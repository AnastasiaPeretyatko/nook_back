import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { IncomingMessage } from 'http';
import { RawData, WebSocket } from 'ws';
import { TokenService } from '../auth/token.service';
import { parseDeviceId } from './device-id';
import { RealtimeService } from './realtime.service';

// Bigger frames are refused by `ws` itself (it closes with 1009).
const MAX_MESSAGE_BYTES = 1024;

// `ws` hands over a Buffer unless told otherwise.
const isPing = (raw: RawData) => {
  try {
    const message = JSON.parse((raw as Buffer).toString()) as {
      t?: unknown;
    } | null;
    return message?.t === 'ping';
  } catch {
    return false;
  }
};

// Never log the request URL here: the access token travels in it (`?token=`).
@WebSocketGateway({ path: '/ws', maxPayload: MAX_MESSAGE_BYTES })
export class RealtimeGateway implements OnGatewayConnection {
  constructor(
    private readonly tokens: TokenService,
    private readonly realtime: RealtimeService,
  ) {}

  async handleConnection(socket: WebSocket, request: IncomingMessage) {
    const params = new URL(request.url ?? '', 'http://x').searchParams;
    const token = params.get('token');
    // Signature only, no database: connecting must not wake Neon.
    const session = token ? await this.tokens.readAccessToken(token) : null;
    if (!session) return this.realtime.refuse(socket);
    if (socket.readyState !== WebSocket.OPEN) return; // left while we were checking
    const { userId, expiresAt } = session;
    this.realtime.add(userId, socket, {
      deviceId: parseDeviceId(params.get('device')),
      expiresAt,
    });
    socket.on('message', (raw) => {
      if (isPing(raw)) this.realtime.pong(userId, socket);
    });
  }
}
