import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'net';
import WebSocket from 'ws';

// A socket plus what happened to it: every message it got and the code it was closed with.
export interface Client {
  socket: WebSocket;
  messages: string[];
  closed: Promise<number>;
  opened: Promise<void>;
}

export const quiet = (ms = 100) => new Promise((r) => setTimeout(r, ms));

// Next message the client gets (or undefined after a second).
export async function nextMessage(client: Client, already = 0) {
  for (let i = 0; i < 100 && client.messages.length <= already; i++) {
    await quiet(10);
  }
  return client.messages[already];
}

export const CHANGED = '{"t":"changed"}';

// Opens real sockets to a listening test app. `closeAll` goes in `afterEach`.
export async function listenForSockets(app: INestApplication) {
  await app.listen(0, '127.0.0.1');
  const { port } = (
    app.getHttpServer() as import('http').Server
  ).address() as AddressInfo;
  let clients: Client[] = [];

  const connect = (query = '', path = '/ws'): Client => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`);
    const messages: string[] = [];
    socket.on('message', (raw) => messages.push((raw as Buffer).toString()));
    const client: Client = {
      socket,
      messages,
      closed: new Promise((resolve) => socket.on('close', resolve)),
      opened: new Promise((resolve, reject) => {
        socket.on('open', resolve);
        socket.on('error', reject);
      }),
    };
    client.opened.catch(() => undefined); // checked by the tests that care
    clients.push(client);
    return client;
  };

  // Connects and waits until the server has registered the socket (it checks the token first).
  const join = async (token: string, device?: string) => {
    const client = connect(
      `?token=${token}${device ? `&device=${device}` : ''}`,
    );
    await client.opened;
    await quiet(50);
    return client;
  };

  const closeAll = async () => {
    for (const { socket } of clients) socket.terminate();
    await Promise.all(clients.map((c) => c.closed));
    clients = [];
  };

  return { connect, join, closeAll };
}

export type Sockets = Awaited<ReturnType<typeof listenForSockets>>;
