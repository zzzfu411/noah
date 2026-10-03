/** One critical transport check: real HTTP + real CLI child processes; no Grok/model launched. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.ts';
import { GrokNativeBridge } from '../src/grok-native-bridge.ts';
import { createGrokJoinFiles } from '../src/grok-native-setup.ts';

const temp = mkdtempSync(join(tmpdir(), 'noah-grok-transport-'));
const store = new Store(join(temp, 'noah.sqlite')), bridge = new GrokNativeBridge(store);
const cli = fileURLToPath(new URL('../src/grok-native-cli.ts', import.meta.url));
let monitor: ChildProcessWithoutNullStreams | undefined;
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const result = await bridge.handle(req.url || '/', req.method || '', (req.headers.authorization || '').replace(/^Bearer /, ''), text ? JSON.parse(text) : {});
  res.writeHead(result?.status || 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(result?.body || {}));
});
async function until(predicate: () => boolean) {
  const start = Date.now(); while (!predicate()) { if (Date.now() - start > 10000) throw new Error('Transport check timed out'); await new Promise(r => setTimeout(r, 50)); }
}
async function command(mode: string, grantPath: string, input?: unknown) {
  const child = spawn(process.execPath, [cli, mode, grantPath], { cwd: temp, env: { PATH: process.env.PATH, HOME: temp }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 0, errors); return output.trim() ? JSON.parse(output) : undefined;
}
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const files = createGrokJoinFiles({ directory: join(temp, 'connection'), url, ...bridge.issueJoinToken() });
  const bindingPath = JSON.parse(readFileSync(files.grantPath, 'utf8')).bindingPath;
  const hook = { hookEventName: 'pre_tool_use', sessionId: 'simulated-native-hook-session', cwd: temp, toolName: 'run_terminal_command', toolInput: { command: files.joinCommand } };
  await command('hook', files.grantPath, { ...hook, toolInput: { command: 'unrelated user work' } });
  assert.equal(existsSync(bindingPath), false, 'an unrelated command cannot consume the join grant');
  await command('hook', files.grantPath, hook);
  const details = await command('join', files.grantPath);
  assert.equal(details.nativeSessionId, hook.sessionId);
  assert.equal(JSON.stringify(details).includes('credential'), false);
  monitor = spawn(process.execPath, [cli, 'monitor', files.grantPath], { cwd: temp, env: { PATH: process.env.PATH, HOME: temp }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = []; let pending = '';
  monitor.stdout.on('data', chunk => { pending += chunk; let n; while ((n = pending.indexOf('\n')) >= 0) { lines.push(pending.slice(0, n)); pending = pending.slice(n + 1); } });
  await until(() => bridge.list().some(b => b.status === 'idle'));
  const c = store.create('CLI transport', undefined, undefined, undefined, false, [{ id: 'original', harness: 'grok', mode: 'external', bindingId: details.bindingId }, { id: 'peer', harness: 'pi' }]);
  store.send(c.id, 'peer', 'human', '公开旁观正文', 'passive');
  store.send(c.id, 'human', 'original', '完整正文🔎\n第二行', 'direct');
  await until(() => lines.length === 1);
  const batchId = String((bridge.wakes()[0] as any).id);
  assert.ok(lines[0].includes(batchId)); assert.ok(!lines[0].includes('第二行'), 'monitor carries one small notice, not a duplicate of the full body');
  let cursor: any = { batchId }; const bodies: string[] = [];
  while (cursor) {
    const read = await command('call', files.grantPath, { name: 'noah_read', args: cursor });
    assert.equal(read.message.contentEncoding, 'concat');
    bodies.push(read.message.contentChunks.join('')); cursor = read.next;
  }
  assert.deepEqual(bodies, ['公开旁观正文', '完整正文🔎\n第二行']);
  await command('call', files.grantPath, { name: 'noah_send', args: { conversationId: c.id, recipient: 'peer', content: 'Public reply', clientKey: 'reply' } });
  await command('call', files.grantPath, { name: 'noah_complete', args: { batchId } });
  assert.ok((store.snapshot().deliveries as any[]).filter(d => d.agent === 'original').every(d => d.state === 'agent_reported'));
  monitor.kill('SIGTERM'); await new Promise<void>(r => monitor!.once('exit', () => r())); monitor = undefined;
  assert.equal(bridge.list()[0].status, 'revoked');
  console.log(JSON.stringify({ hookEntryPoint: true, grantGuard: true, cliRegistration: true, actualHttp: true, oneMonitorLinePerBatch: true, exactFullBodyRoundTrip: true, scopedPublicReply: true, cleanDisconnect: true, grokLaunched: false, paidModelCalls: 0, nativeHookInput: 'simulated; this check does not verify Grok invokes the hook or consumes the monitor' }, null, 2));
} finally {
  monitor?.kill('SIGTERM');
  await new Promise<void>(r => server.close(() => r())); bridge.close(); store.close(); rmSync(temp, { recursive: true, force: true });
}
