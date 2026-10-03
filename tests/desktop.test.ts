import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const require = createRequire(import.meta.url);
const { Backend } = require('../desktop/backend.cjs');
const { validateUiState, readState, writeState } = require('../desktop/state.cjs');
const root = fileURLToPath(new URL('../', import.meta.url));

function fixtureConfig(directory: string) {
  const path = join(directory, 'fixture-config.toml');
  writeFileSync(path, [
    '[models]', 'default = "desktop-fixture"', '[model.desktop-fixture]',
    'model = "no-model-requested"', 'base_url = "https://example.invalid/v1"',
    'api_key = "desktop-test-not-a-real-credential"', 'api_backend = "responses"',
  ].join('\n'), { mode: 0o600 });
  return path;
}

async function assertPortClosed(url: string) {
  const target = new URL(url);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: target.hostname, port: Number(target.port) });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Desktop backend still accepts connections after stop')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Timed out while checking desktop backend shutdown')); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

test('desktop owns a real Node backend: IPC authorization, distinct random ports and clean shutdown', { timeout: 35000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'noah-desktop-'));
  // An explicit fixture prevents this test from reading the user's real model configuration.
  const env = { ...process.env, NOAH_GROK_CONFIG: fixtureConfig(directory), NOAH_MODEL: 'desktop-fixture', PORT: '1' };
  const firstDir = join(directory, 'first'), secondDir = join(directory, 'second');
  const first = new Backend({ root, dataDir: firstDir, execPath: process.execPath, runAsNode: false, env, timeoutMs: 15000 });
  const second = new Backend({ root, dataDir: secondDir, execPath: process.execPath, runAsNode: false, env, timeoutMs: 15000 });
  t.after(async () => {
    await Promise.all([first.stop(), second.stop()]);
    rmSync(directory, { recursive: true, force: true });
  });
  const [a, b] = await Promise.all([first.start(), second.start()]);
  assert.notEqual(a.pid, process.pid);
  assert.notEqual(a.pid, b.pid);
  assert.match(a.token, /^[a-f0-9]{64}$/);
  assert.notEqual(a.token, b.token);
  for (const connection of [a, b]) {
    const address = new URL(connection.url);
    assert.equal(address.hostname, '127.0.0.1');
    assert.equal(address.protocol, 'http:');
    assert.ok(Number(address.port) > 0);
    assert.notEqual(address.port, env.PORT, 'desktop must request an ephemeral port instead of inheriting PORT');
  }
  assert.notEqual(new URL(a.url).port, new URL(b.url).port);
  const request = (url: string, token?: string) => fetch(url + '/api/state', {
    headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000),
  });
  assert.equal((await request(a.url)).status, 401);
  assert.equal((await request(a.url, b.token)).status, 401, 'another desktop instance cannot authorize this backend');
  const response = await request(a.url, a.token);
  assert.equal(response.status, 200);
  const snapshot = await response.json() as any;
  assert.deepEqual(snapshot.conversations, []);
  assert.deepEqual(snapshot.runs, []);
  assert.equal(snapshot.config.model, 'no-model-requested');
  assert.equal(snapshot.config.alias, 'desktop-fixture');
  assert.ok(!JSON.stringify(snapshot).includes('desktop-test-not-a-real-credential'));
  assert.equal(readFileSync(join(firstDir, 'server.lock'), 'utf8'), String(a.pid));
  assert.ok(existsSync(join(firstDir, 'connection.json')));
  assert.ok(!existsSync(join(firstDir, 'sessions')), 'reading desktop state must not launch a harness');
  await assert.rejects(first.start(), /already/);

  // A failed second launch against the same data must preserve the active owner's lock.
  const duplicate = new Backend({ root, dataDir: firstDir, execPath: process.execPath, runAsNode: false, env, timeoutMs: 15000 });
  t.after(() => duplicate.stop());
  await assert.rejects(duplicate.start(), /数据目录|已有实例/);
  assert.equal(readFileSync(join(firstDir, 'server.lock'), 'utf8'), String(a.pid));
  assert.equal((await request(a.url, a.token)).status, 200);

  let lost = false;
  first.on('lost', () => { lost = true; });
  const stopping = first.stop();
  assert.strictEqual(first.stop(), stopping, 'concurrent quit requests must share one shutdown');
  await stopping;
  assert.equal(lost, false, 'a requested shutdown must not display the crash flow');
  assert.equal(existsSync(join(firstDir, 'server.lock')), false);
  assert.equal(existsSync(join(firstDir, 'connection.json')), false);
  assert.ok(existsSync(join(firstDir, 'noah.sqlite')), 'shutdown must preserve saved workspace data');
  await assertPortClosed(a.url);
  assert.equal((await request(b.url, b.token)).status, 200, 'quitting one backend must not stop another');
  await second.stop();
  await assertPortClosed(b.url);
  assert.equal(existsSync(join(secondDir, 'server.lock')), false);
});

function uiState(content = '尚未发送的中文草稿', updatedAt = 100) {
  return { version: 1, selectedTaskId: 'task-a', drafts: [
    { conversationId: 'task-a', recipient: 'pi', content, updatedAt },
  ] };
}

test('desktop UI state accepts drafts without sharing mutable references', () => {
  const value = uiState();
  const validated = validateUiState(value);
  assert.deepEqual(validated, value);
  assert.notStrictEqual(validated, value);
  assert.notStrictEqual(validated.drafts[0], value.drafts[0]);
  validated.drafts[0].content = 'changed';
  assert.equal(value.drafts[0].content, '尚未发送的中文草稿');
  assert.deepEqual(validateUiState({ version: 1, selectedTaskId: null, drafts: [] }), { version: 1, selectedTaskId: null, drafts: [] });
  assert.equal(validateUiState(uiState('x'.repeat(64000))).drafts[0].content.length, 64000);
});

test('desktop UI state rejects invalid drafts and an oversized UTF-8 payload', () => {
  const invalid = [null, {}, { ...uiState(), version: 2 }, { ...uiState(), drafts: {} },
    { ...uiState(), selectedTaskId: 5 }, { ...uiState(), selectedTaskId: 'x'.repeat(101) },
    { version: 1, drafts: Array.from({ length: 1001 }, () => uiState().drafts[0]) },
  ];
  for (const value of invalid) assert.throws(() => validateUiState(value));
  for (const override of [
    { conversationId: 1 }, { conversationId: 'x'.repeat(101) }, { recipient: 'human' },
    { content: 1 }, { content: 'x'.repeat(64001) }, { updatedAt: NaN }, { updatedAt: Infinity },
  ]) assert.throws(() => validateUiState({ version: 1, drafts: [{ ...uiState().drafts[0], ...override }] }));
  // Individual drafts are legal; the serialized UTF-8 envelope still exceeds the storage cap.
  const oversized = { version: 1, drafts: Array.from({ length: 12 }, (_, i) => ({ ...uiState('中'.repeat(64000)).drafts[0], conversationId: String(i) })) };
  assert.throws(() => validateUiState(oversized), /2 MiB/);
});

test('desktop appearance persists independently of a renderer origin and preserves legacy UI state', t => {
  const directory = mkdtempSync(join(tmpdir(), 'noah-desktop-appearance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ui-state.json');
  for (const appearance of ['system', 'light', 'dark']) {
    const state = { ...uiState(), appearance };
    writeState(path, validateUiState(state));
    // A new renderer can recover from the same native file without localStorage
    // or any knowledge of the prior backend's ephemeral URL.
    const restored = validateUiState(readState(path));
    assert.equal(restored.appearance, appearance);
    assert.deepEqual(restored.drafts, state.drafts);
  }
  writeState(path, uiState());
  assert.deepEqual(validateUiState(readState(path)), uiState(), 'version 1 files without appearance remain valid');
});

test('desktop appearance accepts only the exact supported enum', () => {
  for (const appearance of [null, '', 'Dark', 'auto', 'sepia', 0, false, {}, [], ['dark']]) {
    assert.throws(() => validateUiState({ ...uiState(), appearance }), /appearance/);
  }
});

test('desktop state recovers absent/corrupt files and commits the last write atomically', t => {
  const directory = mkdtempSync(join(tmpdir(), 'noah-desktop-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'private', 'ui-state.json');
  const fallback = { version: 1, drafts: [] };
  assert.deepEqual(readState(path, fallback), fallback);
  writeState(path, validateUiState(uiState('先前草稿', 500)));
  assert.deepEqual(readState(path), uiState('先前草稿', 500));
  writeFileSync(path, '{incomplete');
  assert.deepEqual(readState(path, fallback), fallback);

  for (let index = 0; index < 20; index++) writeState(path, validateUiState(uiState(String(index), 1000 + index)));
  // The unload commit wins by arrival order, including when its draft timestamp is older.
  const finalState = { ...uiState('退出前的最后草稿', 1), selectedTaskId: 'task-final' };
  writeState(path, validateUiState(finalState));
  assert.deepEqual(readState(path), finalState);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), finalState);
  assert.equal(existsSync(path + '.tmp'), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(directory, 'private')).mode & 0o777, 0o700);
  }
});
