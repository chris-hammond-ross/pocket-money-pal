import { createReadStream } from 'node:fs';
import {
  backupRestoreRequestSchema,
  RESTORE_WORD,
  zonedDateOf,
  type BackupInspectResult,
  type BackupRestoreResult,
} from '@pmp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { deviceOf, requireParent, authOf, setDeviceCookie } from '../auth/devices';
import type { Db } from '../db/client';
import type { GoalImages } from '../goal-image';
import { isOnPc } from '../net';
import {
  BackupError,
  createBackup,
  inspectBackup,
  newUploadId,
  restoreBackup,
  type BackupProblem,
  type TempFile,
} from '../repo/backup';
import { DEVICE_COOKIE, deviceNameFrom } from '../repo/devices';
import { recordEvent } from '../repo/events';
import { getSettings } from '../repo/settings';
import { isSetupNeeded } from '../repo/setup';
import { canRunSetup } from './setup';

/** The biggest backup a phone may upload: the database plus its jar pictures. */
export const BACKUP_BODY_LIMIT = 100 * 1024 * 1024;

/** How long a checked upload waits for its restore. */
const PENDING_MS = 30 * 60_000;

const PROBLEM_STATUS: Record<BackupProblem, number> = { invalid: 400, newer: 409, old: 409 };

export interface BackupRouteOptions {
  db: Db;
  now: () => number;
  images: GoalImages;
  /** Brings an older backup up to date; null refuses backups older than this server. */
  migrationsDir: string | null;
  appVersion: string;
  /** The scheduler re-plans for the restored family. */
  onScheduleChanged?: () => void;
}

/** Who is restoring: a paired phone over live data, or anyone allowed to run setup. */
type Access = 'parent' | 'setup';

/**
 * Backup and restore (ADR 0020): a paired phone downloads the family as one file, and
 * restores one from the DANGER ZONE (typing RESTORE) or from the setup screen.
 */
export async function backupRoutes(
  app: FastifyInstance,
  { db, now, images, migrationsDir, appVersion, onScheduleChanged }: BackupRouteOptions,
): Promise<void> {
  // A backup is uploaded as the file itself.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: BACKUP_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  /** The one checked upload waiting to be restored; a new upload replaces it. */
  let pending: (TempFile & { id: string; at: number; access: Access }) | null = null;
  const dropPending = async () => {
    const old = pending;
    pending = null;
    await old?.cleanup();
  };
  app.addHook('onClose', dropPending);

  /** Setup rules while setup is needed (nothing to lose), a paired phone afterwards. */
  const accessOf = (req: FastifyRequest, reply: FastifyReply): Access | null => {
    if (isSetupNeeded(db)) {
      if (canRunSetup(db, req)) return 'setup';
      void reply.code(403).send({ error: 'setup-token' });
      return null;
    }
    const found = deviceOf(db, req);
    if (found) {
      req.auth = found;
      return 'parent';
    }
    void reply.code(401).send({ error: 'not-paired' });
    return null;
  };

  app.get('/api/backup', { preHandler: requireParent(db, now) }, async (req, reply) => {
    const at = now();
    const backup = await createBackup(db, { images: await images.readAll(), appVersion, now: at });
    recordEvent(db, { type: 'backup.exported', at, actorId: authOf(req).parent.id });
    const date = zonedDateOf(at, getSettings(db).timezone);
    const stream = createReadStream(backup.file);
    stream.on('close', () => void backup.cleanup());
    return reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="pocket-money-pal-${date}.pmpbackup"`)
      .header('cache-control', 'no-store')
      .send(stream);
  });

  /** Checks an uploaded backup and says what's in it. Nothing changes yet. */
  app.post('/api/backup/inspect', { bodyLimit: BACKUP_BODY_LIMIT }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'backup-file' });
    const access = accessOf(req, reply);
    if (!access) return reply;
    let checked;
    try {
      checked = await inspectBackup(db, req.body, {
        migrationsDir,
        token: req.cookies[DEVICE_COOKIE],
      });
    } catch (err) {
      if (err instanceof BackupError && err.problem !== 'no-parent') {
        return reply.code(PROBLEM_STATUS[err.problem]).send({ error: `backup-${err.problem}` });
      }
      throw err;
    }
    await dropPending();
    const { summary, ...file } = checked;
    pending = { ...file, id: newUploadId(), at: now(), access };
    const result: BackupInspectResult = { uploadId: pending.id, summary };
    return result;
  });

  /** Replaces everything with the checked backup. */
  app.post('/api/backup/restore', async (req, reply) => {
    const body = backupRestoreRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const access = accessOf(req, reply);
    if (!access) return reply;
    const { uploadId, confirm, parentId } = body.data;
    const at = now();
    if (!pending || pending.id !== uploadId || pending.access !== access) {
      return reply.code(404).send({ error: 'backup-gone' });
    }
    if (at - pending.at > PENDING_MS) {
      await dropPending();
      return reply.code(404).send({ error: 'backup-gone' });
    }
    if (access === 'parent' && confirm?.trim().toUpperCase() !== RESTORE_WORD) {
      return reply.code(400).send({ error: 'confirm' });
    }
    const onPc = isOnPc(req.ip);
    const token = access === 'parent' ? req.cookies[DEVICE_COOKIE] : undefined;

    let result;
    try {
      result = restoreBackup(db, pending.file, {
        now: at,
        token,
        pairAs:
          parentId !== undefined && !onPc
            ? { parentId, deviceName: deviceNameFrom(req.headers['user-agent']) }
            : undefined,
      });
    } catch (err) {
      if (err instanceof BackupError && err.problem === 'no-parent') {
        return reply.code(400).send({ error: 'no-parent' });
      }
      throw err;
    }
    await dropPending();
    await images.restoreAll(result.images);

    app.log.warn({ parent: req.auth?.parent.name ?? null, access }, 'Backup restored');
    if (result.newToken) setDeviceCookie(req, reply, result.newToken);
    else if (!result.paired && token) void reply.clearCookie(DEVICE_COOKIE, { path: '/' });

    if (access === 'setup') app.hub.broadcast({ type: 'setup.completed' });
    app.hub.broadcast({ type: 'data.changed' });
    onScheduleChanged?.();
    const out: BackupRestoreResult = { paired: result.paired };
    return out;
  });
}
