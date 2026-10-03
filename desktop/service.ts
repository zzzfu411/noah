import { startServer } from '../src/server.ts';
import { redact } from '../src/config.ts';

// Only the parent desktop process receives the owner credential, through IPC.
if (!process.send) throw new Error('Noah desktop service must be launched by its desktop parent');
let service: Awaited<ReturnType<typeof startServer>> | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await service?.close(); } finally { process.exit(0); }
}
process.on('message', message => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'shutdown') void stop();
});
process.on('disconnect', () => { void stop(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void stop(); });
try {
  service = await startServer({ port: 0 });
  if (stopping || !process.connected) await stop();
  else process.send!({ type: 'ready', url: service.url, token: service.token, pid: process.pid });
} catch (error) {
  process.send?.({ type: 'startup-error', error: redact(error) });
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
}
