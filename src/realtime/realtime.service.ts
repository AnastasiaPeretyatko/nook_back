import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WebSocket } from 'ws';

export const MAX_CONNECTIONS_PER_USER = 10;
export const IDLE_LIMIT_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;

// Close codes of our own side; 4401 is in the contract (bad or expired token).
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_POLICY = 1008;

const CHANGED = '{"t":"changed"}';
const PONG = '{"t":"pong"}';
const UNAUTHORIZED = '{"t":"unauthorized"}';

interface Connection {
  lastSeen: number;
  deviceId?: string;
  // The token's expiry (ms). The connection may outlive the token that opened it.
  expiresAt: number;
}

// Who is connected right now: user id -> socket -> what we know about it.
// Lives in this process's memory only (one server); nothing here touches the database.
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly byUser = new Map<string, Map<WebSocket, Connection>>();
  private timer?: NodeJS.Timeout;

  onModuleInit() {
    this.timer = setInterval(() => this.closeIdle(), SWEEP_EVERY_MS);
    this.timer.unref(); // never keeps the process alive on its own
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  add(
    userId: string,
    socket: WebSocket,
    { deviceId, expiresAt }: { deviceId?: string; expiresAt: number },
  ) {
    const sockets = this.byUser.get(userId) ?? new Map<WebSocket, Connection>();
    this.byUser.set(userId, sockets);
    const connection: Connection = {
      lastSeen: Date.now(),
      deviceId,
      expiresAt,
    };
    sockets.set(socket, connection);
    socket.on('message', () => {
      connection.lastSeen = Date.now();
    });
    socket.once('close', () => this.remove(userId, socket));
    // A phone can lose the network without closing its socket, so the dead connection
    // would keep a place. The oldest goes (Map keeps the order of insertion).
    if (sockets.size > MAX_CONNECTIONS_PER_USER) {
      const [oldest] = sockets.keys();
      this.remove(userId, oldest);
      oldest.close(CLOSE_POLICY);
    }
  }

  connectedUserIds() {
    return [...this.byUser.keys()];
  }

  count(userId: string) {
    return this.byUser.get(userId)?.size ?? 0;
  }

  // The answer to a ping. A token that has run out is not served: the phone gets 4401,
  // refreshes the token and connects again. Checked here and in `ring`, so no timer is needed.
  pong(userId: string, socket: WebSocket) {
    const connection = this.byUser.get(userId)?.get(socket);
    if (!connection || this.closeIfExpired(userId, socket, connection)) return;
    this.send(socket, PONG);
  }

  // "Something changed, ask." Carries no data. Never throws: a ring is sent after the write
  // is saved and must not undo it. `exceptDevice` is the phone that wrote and already knows.
  ring(userIds: Iterable<string>, exceptDevice?: string) {
    for (const userId of new Set(userIds)) {
      for (const [socket, connection] of [...(this.byUser.get(userId) ?? [])]) {
        if (exceptDevice && connection.deviceId === exceptDevice) continue;
        if (this.closeIfExpired(userId, socket, connection)) continue;
        this.send(socket, CHANGED);
      }
    }
  }

  // Run by the timer, not by a request. Silent for longer than the limit means the phone
  // is gone (it pings every ~4 minutes).
  closeIdle(now = Date.now()) {
    for (const [userId, sockets] of this.byUser) {
      for (const [socket, { lastSeen }] of sockets) {
        if (now - lastSeen <= IDLE_LIMIT_MS) continue;
        this.remove(userId, socket);
        socket.close(CLOSE_GOING_AWAY);
      }
    }
  }

  private closeIfExpired(
    userId: string,
    socket: WebSocket,
    { expiresAt }: Connection,
  ) {
    if (expiresAt > Date.now()) return false;
    this.remove(userId, socket);
    this.refuse(socket);
    return true;
  }

  // "Your token is bad or over." Told twice: by a message and by close code 4401. Behind Render's
  // proxy a close the server starts never reaches the client (it sees 1006 about 20 s later), but
  // a message does, so the message is what the phone acts on: it closes, renews the token and
  // connects again.
  refuse(socket: WebSocket) {
    this.send(socket, UNAUTHORIZED);
    this.safely(() => socket.close(CLOSE_UNAUTHORIZED));
  }

  // One broken connection must not stop the rest, so every failure stays here. The log has
  // the error text only: no address (it holds the token) and no user.
  private safely(action: () => void) {
    try {
      action();
    } catch (error) {
      this.logger.warn(`Send failed: ${(error as Error).message}`);
    }
  }

  private send(socket: WebSocket, message: string) {
    this.safely(() =>
      socket.send(message, (error) => {
        if (error) this.logger.warn(`Send failed: ${error.message}`);
      }),
    );
  }

  private remove(userId: string, socket: WebSocket) {
    const sockets = this.byUser.get(userId);
    sockets?.delete(socket);
    if (sockets?.size === 0) this.byUser.delete(userId);
  }
}
