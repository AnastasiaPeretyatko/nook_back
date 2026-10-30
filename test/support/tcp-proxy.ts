import net from 'net';

// A TCP pipe between the app and the test database that can be cut: the app connects to the
// proxy, the proxy to Postgres. `cut` drops every open connection (a network break), `stop` also
// stops listening (the server is down: new connections are refused), `start` brings it back on
// the same port. Only this app's connections go through it, so other tests are not affected.
export class TcpProxy {
  private server?: net.Server;
  private sockets = new Set<net.Socket>();

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
    public port = 0,
  ) {}

  async start() {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('error', () => socket.destroy());
        socket.on('close', () => {
          this.sockets.delete(socket);
          (socket === client ? upstream : client).destroy();
        });
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(this.port, '127.0.0.1', resolve),
    );
    this.port = (server.address() as net.AddressInfo).port;
  }

  cut() {
    for (const socket of this.sockets) socket.destroy();
  }

  async stop() {
    this.cut();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}
