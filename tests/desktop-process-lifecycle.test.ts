import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { Backend } = require('../desktop/backend.cjs');

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'noah-owned-processes-'));
  mkdirSync(join(directory, 'desktop'));
  const worker = join(directory, 'worker.cjs');
  writeFileSync(worker, `
    const server = require('node:http').createServer((_req, res) => res.end('alive'));
    process.on('SIGTERM', () => {});
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  `);
  writeFileSync(join(directory, 'desktop/service.ts'), `
    import { fork } from 'node:child_process';
    const child = fork(${JSON.stringify(worker)}, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', value => process.send({ type: 'ready', url: 'http://127.0.0.1:' + value.port, token: 'a'.repeat(64) }));
    process.on('message', value => { if (value.type === 'shutdown') process.exit(0); });
  `);
  const backend = new Backend({ root: directory, dataDir: join(directory, 'data'), execPath: process.execPath, runAsNode: false });
  // Represents another independently running harness. It must survive cleanup.
  const independent = fork(worker, [], { execArgv: [], detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    await backend.stop();
    if (independent.exitCode === null && independent.signalCode === null) {
      const exited = once(independent, 'exit'); independent.kill('SIGKILL'); await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const { port } = await new Promise<{ port: number }>((resolve, reject) => {
    independent.once('message', value => resolve(value as { port: number }));
    independent.once('error', reject);
    independent.once('exit', (code, signal) => reject(new Error(`Fixture exited before listening: ${code ?? signal}`)));
  });
  return { backend, independentUrl: `http://127.0.0.1:${port}` };
}

async function isAlive(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000), headers: { Connection: 'close' } })).ok; }
  catch { return false; }
}

for (const crash of [true, false]) test(`desktop cleans its managed group after ${crash ? 'a service crash' : 'a service exit during quit'}, preserving independent processes`, {
  timeout: 10000, skip: process.platform === 'win32',
}, async t => {
  const { backend, independentUrl } = await fixture(t);
  const connection = await backend.start();
  assert.equal(await isAlive(connection.url), true);
  let lost = false; backend.on('lost', () => { lost = true; });
  if (crash) {
    const lostEvent = once(backend, 'lost');
    backend.child.kill('SIGKILL'); await lostEvent;
    assert.equal(lost, true);
  } else {
    const stopping = backend.stop();
    assert.strictEqual(backend.stop(), stopping);
    await stopping; assert.equal(lost, false);
  }
  assert.equal(await isAlive(connection.url), false, 'managed child cannot outlive desktop shutdown');
  assert.equal(await isAlive(independentUrl), true, 'independent harness must remain running');
});
