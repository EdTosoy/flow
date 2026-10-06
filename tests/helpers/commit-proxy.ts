import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';

/** Test-only TCP proxy: forward COMMIT, drop its successful server acknowledgement. */
export async function commitDropProxy(
  target: string,
): Promise<{ url: string; dropped: Promise<void>; close(): Promise<void> }> {
  const parsed = new URL(target);
  const targetPort = Number(parsed.port);
  const sockets = new Set<Socket>();
  let dropResolve: () => void = () => {};
  const dropped = new Promise<void>((r) => {
    dropResolve = r;
  });
  const server = createServer((front) => {
    const back = connect({ host: parsed.hostname, port: targetPort });
    sockets.add(front);
    sockets.add(back);
    let startup = true;
    let committing = false;
    let frontBuffer = Buffer.alloc(0);
    let backBuffer = Buffer.alloc(0);
    front.on('data', (data) => {
      frontBuffer = Buffer.concat([frontBuffer, data]);
      while (frontBuffer.length >= (startup ? 4 : 5)) {
        const length = startup
          ? frontBuffer.readUInt32BE(0)
          : frontBuffer.readUInt32BE(1) + 1;
        if (frontBuffer.length < length) break;
        const packet = frontBuffer.subarray(0, length);
        frontBuffer = frontBuffer.subarray(length);
        if (
          !startup &&
          packet[0] === 81 &&
          packet.subarray(5).toString() === 'COMMIT\0'
        )
          committing = true;
        startup = false;
        back.write(packet);
      }
    });
    back.on('data', (data) => {
      backBuffer = Buffer.concat([backBuffer, data]);
      while (backBuffer.length >= 5) {
        const length = backBuffer.readUInt32BE(1) + 1;
        if (backBuffer.length < length) break;
        const packet = backBuffer.subarray(0, length);
        backBuffer = backBuffer.subarray(length);
        if (
          committing &&
          packet[0] === 67 &&
          packet.subarray(5).toString() === 'COMMIT\0'
        ) {
          // CommandComplete means PostgreSQL committed. Caller receives neither this nor ReadyForQuery.
          dropResolve();
          front.destroy();
          back.destroy();
          return;
        }
        front.write(packet);
      }
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
  if (address === null || typeof address === 'string')
    throw new Error('Proxy did not bind TCP');
  parsed.port = String(address.port);
  return {
    url: parsed.toString(),
    dropped,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
