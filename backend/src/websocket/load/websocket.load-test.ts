/**
 * WebSocket concurrent connection load test.
 *
 * Usage:
 *   npx ts-node src/websocket/load/websocket.load-test.ts --connections=1000 --duration=30
 *
 * For 10k+ connections, raise OS limits first (ulimit -n 65535)
 * and ensure Redis + backend replicas are running.
 */
import { io, Socket } from 'socket.io-client';

function arg(name: string, fallback: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split('=')[1] : fallback;
}

const CONNECTIONS = parseInt(arg('connections', '100'), 10);
const DURATION_SEC = parseInt(arg('duration', '30'), 10);
const URL = arg('url', process.env.WS_PUBLIC_URL || 'http://localhost:4000');
const TOKEN = arg('token', process.env.WS_LOAD_TOKEN || '');

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('Provide --token= or WS_LOAD_TOKEN for authenticated load test');
    process.exit(1);
  }

  console.log(
    `Connecting ${CONNECTIONS} clients to ${URL}/ws for ${DURATION_SEC}s...`,
  );

  const sockets: Socket[] = [];
  let connected = 0;
  let errors = 0;
  let events = 0;
  const started = Date.now();

  const connectOne = (i: number): Promise<void> =>
    new Promise((resolve) => {
      const socket = io(`${URL}/ws`, {
        auth: { token: TOKEN },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });

      socket.on('connected', () => {
        connected += 1;
        socket.emit('subscribe', { channel: 'payments' });
        resolve();
      });

      socket.on('event', () => {
        events += 1;
      });

      socket.on('connect_error', () => {
        errors += 1;
        resolve();
      });

      socket.on('error', () => {
        errors += 1;
      });

      sockets.push(socket);

      setTimeout(() => {
        if (!socket.connected) resolve();
      }, 10_000 + (i % 50) * 20);
    });

  const batchSize = 100;
  for (let i = 0; i < CONNECTIONS; i += batchSize) {
    const batch = Array.from(
      { length: Math.min(batchSize, CONNECTIONS - i) },
      (_, j) => connectOne(i + j),
    );
    await Promise.all(batch);
    process.stdout.write(`\rConnected: ${connected}/${CONNECTIONS} errors=${errors}`);
  }

  console.log(`\nSteady state: ${connected} connections. Holding for ${DURATION_SEC}s...`);
  await new Promise((r) => setTimeout(r, DURATION_SEC * 1000));

  const elapsed = (Date.now() - started) / 1000;
  const failureRate = CONNECTIONS === 0 ? 0 : errors / CONNECTIONS;

  console.log(
    JSON.stringify(
      {
        connections_requested: CONNECTIONS,
        connections_established: connected,
        errors,
        failure_rate: failureRate,
        events_received: events,
        elapsed_seconds: elapsed,
        target_failure_rate: 0.01,
        passed: failureRate < 0.01 && connected >= CONNECTIONS * 0.99,
      },
      null,
      2,
    ),
  );

  for (const s of sockets) {
    s.disconnect();
  }
  process.exit(failureRate < 0.01 ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
