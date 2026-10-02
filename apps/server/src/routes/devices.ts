import {
  idSchema,
  inviteRequestSchema,
  pairCheckRequestSchema,
  pairRequestSchema,
  type DeviceList,
  type DeviceMe,
  type PairCheckResult,
  type PairingInvite,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { authOf, deviceOf, requireParent, setDeviceCookie } from '../auth/devices';
import type { Db } from '../db/client';
import { isOnPc, lanAddresses } from '../net';
import {
  checkPairingCode,
  countActiveDevices,
  createPairingCode,
  deviceNameFrom,
  listDevices,
  pairDevice,
  revokeDevice,
  spendPairingCode,
  type PairingCodeProblem,
} from '../repo/devices';
import { recordEvent } from '../repo/events';
import { isSetupNeeded } from '../repo/setup';
import { findParent, listParents } from '../repo/users';

export interface DeviceRouteOptions {
  db: Db;
  now: () => number;
  publicUrl: string | null;
}

/** 404 for a code nobody issued, 410 for one that's spent, expired or no longer valid. */
const CODE_STATUS: Record<PairingCodeProblem, number> = { unknown: 404, expired: 410 };

/**
 * Pairing and paired devices (ADR 0008): who this phone is, the Paired phones list and
 * revoking, pairing codes (from a paired phone, or the PC while no phone is paired), and
 * the new phone's side of pairing.
 */
export async function deviceRoutes(
  app: FastifyInstance,
  { db, now, publicUrl }: DeviceRouteOptions,
): Promise<void> {
  const parentOnly = { preHandler: requireParent(db, now) };
  const invite = (code: { code: string; expiresAt: number }): PairingInvite => ({
    ...code,
    hosts: lanAddresses(),
    publicUrl,
  });

  /** Which parent this device is paired to. 401 when it isn't (or was revoked). */
  app.get('/api/devices/me', parentOnly, async (req) => {
    const { device, parent } = authOf(req);
    const me: DeviceMe = {
      deviceId: device.id,
      name: device.name,
      parent: { id: parent.id, name: parent.name },
    };
    return me;
  });

  app.get('/api/devices', parentOnly, async (req): Promise<DeviceList> => {
    const { device: current } = authOf(req);
    return listDevices(db).map(({ device, parent }) => ({
      id: device.id,
      name: device.name,
      parent: { id: parent.id, name: parent.name },
      pairedAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      current: device.id === current.id,
    }));
  });

  /** Revoke a device. Revoking your own phone logs it out. */
  app.delete('/api/devices/:id', parentOnly, async (req, reply) => {
    const id = idSchema.safeParse(Number((req.params as { id: string }).id));
    if (!id.success) return reply.code(404).send({ error: 'not-found' });
    const { device, parent } = authOf(req);
    const at = now();
    const revoked = db.transaction((tx) => {
      if (!revokeDevice(tx, id.data, at)) return false;
      recordEvent(tx, {
        type: 'device.revoked',
        at,
        actorId: parent.id,
        data: { deviceId: id.data, byDeviceId: device.id },
      });
      return true;
    });
    if (!revoked) return reply.code(404).send({ error: 'not-found' });
    app.hub.broadcast({ type: 'devices.changed' });
    return reply.code(204).send();
  });

  /**
   * A paired phone's "Pair another phone": a one-time code for the QR (10 minutes). With
   * `{ move: true }` it's this phone's "Switch to secure app" (ADR 0009): pairing with the
   * code unpairs this phone.
   */
  app.post('/api/devices/invites', parentOnly, async (req, reply) => {
    const body = inviteRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const code = createPairingCode(db, {
      createdByDevice: authOf(req).device.id,
      now: now(),
      move: body.data.move,
    });
    return reply.code(201).send(invite(code));
  });

  /**
   * The PC's code, for the kiosk's "Pair a parent phone" card: only from the PC itself, and
   * only while setup is done and no phone is paired at all.
   */
  app.get('/api/devices/pc-invite', async (req, reply) => {
    if (!isOnPc(req.ip)) return reply.code(403).send({ error: 'pc-only' });
    if (isSetupNeeded(db)) return reply.code(409).send({ error: 'setup-needed' });
    if (countActiveDevices(db) > 0) return reply.code(409).send({ error: 'phones-paired' });
    return invite(createPairingCode(db, { createdByDevice: null, now: now() }));
  });

  const refuseCode = (reply: FastifyReply, problem: PairingCodeProblem) =>
    reply.code(CODE_STATUS[problem]).send({ error: `code-${problem}` });

  /** The new phone checks its code, and learns which grown-ups it can pair as. */
  app.post('/api/devices/pair/check', async (req, reply) => {
    const body = pairCheckRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const check = checkPairingCode(db, body.data.code, now());
    if (!check.ok) return refuseCode(reply, check.problem);
    const result: PairCheckResult = {
      parents: listParents(db).map((p) => ({ id: p.id, name: p.name })),
      expiresAt: check.expiresAt,
    };
    return result;
  });

  /** The new phone pairs as the grown-up it picked. The code is spent. */
  app.post('/api/devices/pair', async (req, reply) => {
    const body = pairRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (isOnPc(req.ip)) return reply.code(403).send({ error: 'not-on-pc' });
    // Already paired: pairing again would leave the old token dangling.
    if (deviceOf(db, req)) return reply.code(409).send({ error: 'already-paired' });

    const at = now();
    const result = db.transaction((tx) => {
      const check = checkPairingCode(tx, body.data.code, at);
      if (!check.ok) return check;
      const parent = findParent(tx, body.data.parentId);
      if (!parent) return { ok: false as const, problem: 'no-parent' as const };
      spendPairingCode(tx, body.data.code, at);
      const paired = pairDevice(tx, {
        userId: parent.id,
        name: deviceNameFrom(req.headers['user-agent']),
        now: at,
      });
      recordEvent(tx, {
        type: 'device.paired',
        at,
        actorId: parent.id,
        data: {
          deviceId: paired.device.id,
          name: paired.device.name,
          via: check.createdByDevice === null ? 'pc' : check.replacesDevice ? 'move' : 'invite',
          invitedByDevice: check.createdByDevice,
        },
      });
      // A move code: the same phone, now on the HTTPS address. Its old pairing goes.
      if (check.replacesDevice !== null && revokeDevice(tx, check.replacesDevice, at)) {
        recordEvent(tx, {
          type: 'device.revoked',
          at,
          actorId: parent.id,
          data: { deviceId: check.replacesDevice, movedTo: paired.device.id },
        });
      }
      return { ok: true as const, paired, parent };
    });

    if (!result.ok) {
      if (result.problem === 'no-parent') return reply.code(400).send({ error: 'no-parent' });
      return refuseCode(reply, result.problem);
    }
    setDeviceCookie(req, reply, result.paired.token);
    app.hub.broadcast({ type: 'devices.changed' });
    const me: DeviceMe = {
      deviceId: result.paired.device.id,
      name: result.paired.device.name,
      parent: { id: result.parent.id, name: result.parent.name },
    };
    return reply.code(201).send(me);
  });
}
