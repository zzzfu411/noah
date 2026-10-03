import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGrokConfig, prepareGrokHome, modelSummary, redact } from '../src/config.ts';
import { JsonLines, JsonRpcProcess } from '../src/jsonl.ts';

test('model URL/key/backend come from the selected Grok config without writing secrets to generated config', t => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.toml'); const key = 'secret-fixture-only-123456789';
  writeFileSync(file, `[models]\ndefault="custom"\n[model.custom]\nmodel="model-id"\nbase_url="https://example.invalid/v1"\napi_key="${key}"\napi_backend="responses"\n`);
  const c = loadGrokConfig(file, 'custom');
  assert.equal(c.apiKey, key); assert.equal(c.baseUrl, 'https://example.invalid/v1'); assert.equal(c.backend, 'responses');
  const home = prepareGrokHome(join(dir, 'isolated'), c);
  const generated = readFileSync(join(home, 'config.toml'), 'utf8');
  assert.ok(!generated.includes(key)); assert.ok(generated.includes('NOAH_MODEL_API_KEY'));
  assert.ok(!JSON.stringify(modelSummary(c)).includes(key)); assert.equal(redact('error ' + key), 'error [redacted]');
  assert.throws(() => loadGrokConfig(file, 'missing'), /没有/);
});

test('JSONL handles fragmented UTF-8 and embedded Unicode separators; malformed frames fail', () => {
  const text = '中文\u2028不会断帧\u2029🙂'; const bytes = Buffer.from(JSON.stringify({ text }) + '\r\n');
  const parser = new JsonLines(); const messages = [];
  for (const byte of bytes) messages.push(...parser.feed(Buffer.from([byte])));
  assert.deepEqual(messages, [{ text }]);
  assert.throws(() => new JsonLines().feed('{bad}\n'));
});

test('a resolved credential can cross the worker boundary without inheriting unrelated environment values', t => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-env-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.toml');
  writeFileSync(file, '[models]\ndefault="custom"\n[model.custom]\nbase_url="https://example.invalid/v1"\nenv_key="NOAH_FIXTURE_MISSING_KEY"\n');
  assert.throws(() => loadGrokConfig(file, 'custom'), /未配置/);
  assert.equal(loadGrokConfig(file, 'custom', 'resolved-test-secret').apiKey, 'resolved-test-secret');
});

test('RPC rejects exited and absent executables without leaving requests hanging', async () => {
  const rpc = new JsonRpcProcess(process.execPath, ['-e', 'process.exit(3)'], { cwd: tmpdir(), env: {} });
  await assert.rejects(rpc.request('hello'), /exited/); await rpc.close();
  const absent = new JsonRpcProcess('/definitely/no/noah-executable', [], { cwd: tmpdir(), env: {} });
  await assert.rejects(absent.request('hello'), /ENOENT/); await absent.close();
  await assert.rejects(absent.request('again'), /disconnected/);
});
