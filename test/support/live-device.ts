import { Device } from './fake-device';
import { CHANGED, Client, Sockets, quiet } from './ws-client';

// The app with a WebSocket, as the plan for the app describes it (A7): after EVERY connection one
// pull; on "changed" one sync (pull, then push of what is dirty); on 4401 a new token and a new
// connection; after a break (the server restarted) a new connection. The debounce of 1 second is
// left out: the tests count one ring as one sync.
export class LiveDevice {
  // Rings heard, connections made, and closes seen with their codes.
  rings = 0;
  connects = 0;
  closes: number[] = [];
  client?: Client;

  private chain: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(
    readonly device: Device,
    private readonly sockets: Sockets,
    readonly name: string,
    private token: string,
    private readonly freshToken: () => Promise<string>,
    private readonly autoReconnect = true,
  ) {}

  // Connects and does the one pull that follows every connection.
  async connect(): Promise<void> {
    this.stopped = false;
    const client = await this.sockets.join(this.token, this.name);
    if (client.socket.readyState !== client.socket.OPEN) {
      // Refused (or already dropped). Only a bad token is the app's business: get a new one.
      const code = await client.closed;
      this.closes.push(code);
      if (code !== 4401) throw new Error(`closed with ${code} on connecting`);
      this.token = await this.freshToken();
      return this.connect();
    }
    this.connects += 1;
    this.client = client;
    client.socket.on('message', (raw) => {
      if ((raw as Buffer).toString() !== CHANGED) return;
      this.rings += 1;
      this.queue(() => this.device.sync());
    });
    void client.closed.then((code) => {
      if (this.stopped || this.client !== client) return;
      this.closes.push(code);
      if (code === 4401 || this.autoReconnect) {
        this.queue(async () => {
          if (code === 4401) this.token = await this.freshToken();
          await this.connect();
        });
      }
    });
    await this.device.sync();
  }

  // The phone goes away: no reconnecting.
  disconnect() {
    this.stopped = true;
    this.client?.socket.terminate();
  }

  private queue(job: () => Promise<void>) {
    this.chain = this.chain.then(job);
  }

  // Waits until everything the phone has started (syncs, reconnects) is done.
  async idle() {
    let seen: Promise<void>;
    do {
      seen = this.chain;
      await seen;
      await quiet(20);
    } while (seen !== this.chain);
  }

  async waitUntil(condition: () => boolean, ms = 4000) {
    for (let waited = 0; !condition() && waited < ms; waited += 10) {
      await quiet(10);
    }
    if (!condition()) throw new Error(`${this.name}: waited ${ms} ms in vain`);
    await this.idle();
  }
}
