import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPiSession } from '../src/pi-session.ts';
import { LocalAdapter } from '../src/adapters.ts';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'noah-pi-restore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { cwd: dir, sessionDir: join(dir, 'sessions') };
}

test('a new Pi binding survives restart before any prompt or assistant response', t => {
  const options = fixture(t);
  const first = openPiSession(options);
  const sessionFile = first.getSessionFile()!;
  const expectedSessionId = first.getSessionId();
  assert.ok(statSync(sessionFile).size > 0);
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
  assert.equal(first.getEntries().length, 0);
  assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8').trim()).id, expectedSessionId);
  const restored = openPiSession({ ...options, sessionFile, expectedSessionId });
  assert.equal(restored.getSessionId(), expectedSessionId);
  assert.equal(restored.getEntries().length, 0);
  // First input is durable even if the worker exits before an assistant replies.
  restored.appendMessage({ role: 'user', content: 'before the first response', timestamp: Date.now() });
  const again = openPiSession({ ...options, sessionFile, expectedSessionId });
  assert.equal(again.getSessionId(), expectedSessionId);
  assert.equal(again.buildSessionContext().messages.length, 1);
});

test('Pi restore rejects a missing or empty bound file without replacing it', t => {
  const options = fixture(t);
  const first = openPiSession(options);
  const sessionFile = first.getSessionFile()!;
  const expectedSessionId = first.getSessionId();
  rmSync(sessionFile);
  assert.throws(() => openPiSession({ ...options, sessionFile, expectedSessionId }), /无法恢复/);
  assert.equal(existsSync(sessionFile), false);
  writeFileSync(sessionFile, '');
  assert.throws(() => openPiSession({ ...options, sessionFile, expectedSessionId }), /无法恢复/);
  assert.equal(statSync(sessionFile).size, 0);
});

test('Pi restore rejects a different native ID, corrupt header, or incomplete binding', t => {
  const options = fixture(t);
  const first = openPiSession(options);
  const sessionFile = first.getSessionFile()!;
  const expectedSessionId = first.getSessionId();
  const original = readFileSync(sessionFile, 'utf8');
  assert.throws(() => openPiSession({ ...options, sessionFile, expectedSessionId: 'another-native-id' }), /绑定不符/);
  assert.equal(readFileSync(sessionFile, 'utf8'), original);
  assert.throws(() => openPiSession({ ...options, sessionFile }), /缺少原生 ID/);
  assert.throws(() => openPiSession({ ...options, expectedSessionId }), /缺少原生 ID/);
  writeFileSync(sessionFile, 'not a Pi session\n');
  assert.throws(() => openPiSession({ ...options, sessionFile, expectedSessionId }), /无法恢复/);
  assert.equal(readFileSync(sessionFile, 'utf8'), 'not a Pi session\n');
});

test('the real Pi worker restores its handshake binding without making a model request', async t => {
  const options = fixture(t);
  const configPath = join(options.cwd, 'config.toml');
  writeFileSync(configPath, '[models]\ndefault = "test"\n[model.test]\nmodel = "test"\nbase_url = "http://127.0.0.1:9/v1"\napi_backend = "chat_completions"\napi_key = "test-key-no-network"\n');
  const start = async (nativeId: string | null = null, nativeFile: string | null = null) => {
    const adapter = new LocalAdapter({
      agent: 'pi', dataDir: options.cwd, configPath, modelAlias: 'test',
      row: { conversation_id: 'restore-test', agent: 'pi', native_id: nativeId, native_file: nativeFile,
        status: 'offline', error: null, capabilities: null },
      bridgeUrl: 'http://127.0.0.1:9', bridgeToken: 'test-bridge-token',
      events: { accepted() {}, output() {}, usage() {}, exit() {} },
    });
    try { return await adapter.start(); } finally { await adapter.close(); }
  };
  const first = await start();
  assert.ok(first.nativeFile && statSync(first.nativeFile).size > 0);
  const restored = await start(first.nativeId, first.nativeFile!);
  assert.equal(restored.nativeId, first.nativeId);
  assert.equal(restored.nativeFile, first.nativeFile);
  rmSync(first.nativeFile!);
  await assert.rejects(start(first.nativeId, first.nativeFile!), /无法恢复/);
  assert.equal(existsSync(first.nativeFile!), false);
});
