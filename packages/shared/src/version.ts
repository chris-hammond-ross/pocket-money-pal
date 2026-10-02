import { z } from 'zod';

/**
 * What the server says about itself, in `/api/health` and the WebSocket `hello` (ADR 0011).
 * Read leniently, on its own: a client of any age must still be able to tell it's out of
 * date, however much else the server has changed since.
 */
export const serverVersionSchema = z.object({
  /** The web build the server is serving now; null when there isn't one (development). */
  build: z.string().nullable(),
  apiVersion: z.number().int(),
});
export type ServerVersion = z.infer<typeof serverVersionSchema>;

/** The client's build id in the Vite dev server, where updates arrive by hot reload. */
export const DEV_BUILD = 'dev';

/**
 * - `current`: this screen runs what the server serves (or there's nothing to compare).
 * - `stale`: there's a newer build, but this one still works with the server.
 * - `incompatible`: the API changed under this screen; it must reload now.
 */
export type VersionStatus = 'current' | 'stale' | 'incompatible';

export function versionStatus(
  client: { build: string; apiVersion: number },
  server: ServerVersion,
): VersionStatus {
  if (client.apiVersion !== server.apiVersion) return 'incompatible';
  if (client.build === DEV_BUILD || server.build === null) return 'current';
  return client.build === server.build ? 'current' : 'stale';
}
