import { z } from 'zod';

/**
 * Events the server pushes to every connected client over the WebSocket.
 * Clients generally react by invalidating the matching query cache.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), serverTime: z.string(), clients: z.number().int() }),
  z.object({ type: z.literal('presence'), clients: z.number().int() }),
  z.object({ type: z.literal('ping'), from: z.string(), at: z.string() }),
  z.object({ type: z.literal('settings.updated') }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];
