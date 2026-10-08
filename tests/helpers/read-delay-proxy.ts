import { connect, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
/** Real test-only PostgreSQL transport: withhold responses after a read transaction begins. */
export async function readDelayProxy(target: string) {
  const url = new URL(target);
  const targetPort = Number(url.port);
  const sockets = new Set<Socket>();
  const server = createServer((front) => {
    const back = connect({ host: url.hostname, port: targetPort });
    sockets.add(front);
    sockets.add(back);
    let startup = true,
      delayed = false,
      buffer = Buffer.alloc(0);
    front.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = startup
          ? buffer.readUInt32BE(0)
          : buffer.readUInt32BE(1) + 1;
        if (buffer.length < length) break;
        const packet = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        if (
          !startup &&
          packet[0] === 81 &&
          packet.subarray(5).toString().startsWith('BEGIN')
        )
          delayed = true;
        startup = false;
        back.write(packet);
      }
    });
    back.on('data', (data) => {
      if (!delayed) front.write(data);
    });
    front.on('error', () => back.destroy());
    back.on('error', () => front.destroy());
    front.on('close', () => {
      sockets.delete(front);
      back.destroy();
    });
    back.on('close', () => {
      sockets.delete(back);
      front.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Read proxy did not bind');
  url.port = String(address.port);
  return {
    url: url.toString(),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
