import type { ServerEvent, ServerVersion } from '@pmp/shared';
import type { WebSocket } from 'ws';

/** Tracks connected clients and fans server events out to all of them. */
export class WsHub {
  private readonly clients = new Set<WebSocket>();

  /** `version` is told to every new connection, so open screens notice an update (ADR 0011). */
  constructor(private readonly version: () => ServerVersion) {}

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('close', () => {
      this.clients.delete(socket);
      this.broadcast({ type: 'presence', clients: this.size });
    });
    this.send(socket, {
      type: 'hello',
      serverTime: new Date().toISOString(),
      clients: this.size,
      ...this.version(),
    });
    this.broadcast({ type: 'presence', clients: this.size });
  }

  send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }

  broadcast(event: ServerEvent): void {
    for (const socket of this.clients) this.send(socket, event);
  }
}
