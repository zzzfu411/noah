import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGrokJoinFiles } from '../src/grok-native-setup.ts';

test('an orphaned shell cannot keep its Noah monitor renewing the original session', { timeout: 15000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'noah-monitor-lifetime-'));
  let polls = 0, disconnected = false, stopping = false;
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/disconnect')) disconnected = true;
    if (request.url?.endsWith('/poll')) polls++;
    response.writeHead(stopping ? 401 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ notification: null }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const files = createGrokJoinFiles({ directory: join(temp, 'join'), url: `http://127.0.0.1:${(server.address() as any).port}`, joinToken: 'test-only', expiresAt: Date.now() + 60000 });
  const grant = JSON.parse(readFileSync(files.grantPath, 'utf8'));
  writeFileSync(grant.bindingPath, JSON.stringify({ bindingId: 'test-only', credential: 'test-only', nativeSessionId: 'test-only', projectDir: temp }), { mode: 0o600 });
  const parentScript = join(temp, 'parent.mjs');
  // The shell remains the monitor's direct parent after this helper exits,
  // matching the real Grok failure. Checking only process.ppid would miss it.
  writeFileSync(parentScript, `import { spawn } from 'node:child_process';
const child = spawn('/bin/sh', ['-c', '"$1" "$2" monitor "$3" & monitor_pid=$!; printf "%s\\n" "$monitor_pid"; wait "$monitor_pid"', 'noah-test-shell', process.execPath, process.argv[2], process.argv[3]], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', data => process.send({ shellPid: child.pid, monitorPid: Number(data.toString().trim()) }));
setInterval(() => {}, 1000);
`);
  const parent = spawn(process.execPath, [parentScript, fileURLToPath(new URL('../src/grok-native-cli.ts', import.meta.url)), files.grantPath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let shellPid = 0, monitorPid = 0;
  const alive = (pid: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (check: () => boolean) => {
    const start = Date.now();
    while (!check()) { if (Date.now() - start > 6000) throw new Error('Monitor lifetime check timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  t.after(async () => {
    stopping = true;
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGTERM');
    // Only PIDs created by this fixture are eligible for cleanup.
    for (const pid of [monitorPid, shellPid]) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  });
  parent.once('message', value => { ({ shellPid, monitorPid } = value as { shellPid: number; monitorPid: number }); });
  await until(() => polls > 0 && monitorPid > 0);
  assert.equal(Number(execFileSync('/bin/ps', ['-p', String(monitorPid), '-o', 'ppid='], { encoding: 'utf8' }).trim()), shellPid);
  assert.equal(Number(execFileSync('/bin/ps', ['-p', String(shellPid), '-o', 'ppid='], { encoding: 'utf8' }).trim()), parent.pid);
  const pollsBeforeExit = polls;
  parent.kill('SIGTERM');
  await until(() => parent.signalCode !== null || parent.exitCode !== null);
  await until(() => disconnected);
  assert.equal(polls, pollsBeforeExit, 'No poll may renew the lease after the captured ancestor exits');
  await until(() => !alive(monitorPid));
  await until(() => !alive(shellPid));
});
