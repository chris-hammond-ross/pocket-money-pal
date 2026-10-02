/**
 * Device-token auth for parent endpoints (ADR 0008). A paired phone holds a random token
 * in the httpOnly `pmp_device` cookie; the server knows only its hash.
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Db } from '../db/client';
import { DEVICE_COOKIE, findDeviceByToken, touchDevice, type Device } from '../repo/devices';
import type { User } from '../repo/users';

/** Browsers cap cookie lifetimes at 400 days. It's re-issued as the phone is used. */
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
/** `last_seen_at` is written at most this often. */
const TOUCH_EVERY_MS = 60_000;
/** The cookie is re-issued (a fresh 400 days) once it's been this long since last seen. */
const REISSUE_AFTER_MS = 24 * 60 * 60_000;

export function setDeviceCookie(req: FastifyRequest, reply: FastifyReply, token: string): void {
  void reply.setCookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });
}

export interface ParentAuth {
  device: Device;
  parent: User;
}

/** The paired device and parent behind a request, or null. Has no side effects. */
export function deviceOf(db: Db, req: FastifyRequest): ParentAuth | null {
  const token = req.cookies[DEVICE_COOKIE];
  return token ? findDeviceByToken(db, token) : null;
}

/**
 * A preHandler for parent endpoints: 401 `not-paired` unless the request carries an active
 * device token. On success `req.auth` holds the device and its parent, `last_seen_at` is
 * kept fresh, and a cookie not seen for a day is re-issued so a phone in use stays paired.
 */
export function requireParent(db: Db, now: () => number): preHandlerAsyncHookHandler {
  return async (req, reply) => {
    const found = deviceOf(db, req);
    if (!found) return reply.code(401).send({ error: 'not-paired' });
    const at = now();
    const lastSeen = found.device.lastSeenAt ?? 0;
    if (at - lastSeen >= TOUCH_EVERY_MS) touchDevice(db, found.device.id, at);
    if (at - lastSeen >= REISSUE_AFTER_MS) setDeviceCookie(req, reply, req.cookies[DEVICE_COOKIE]!);
    req.auth = found;
  };
}

/** The parent a `requireParent` route runs as. */
export function authOf(req: FastifyRequest): ParentAuth {
  if (!req.auth) throw new Error('Route is missing the requireParent preHandler');
  return req.auth;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: ParentAuth;
  }
}
