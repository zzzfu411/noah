import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadGrokConfig, listGrokModels } from '../src/config.ts';
import { discoverHarnesses } from '../src/discovery.ts';
import { LocalAdapter } from '../src/adapters.ts';

function paths(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'noah-integration-paths-'));
  const saved = { NOAH_GROK_BIN: process.env.NOAH_GROK_BIN, NOAH_GROK_CONFIG: process.env.NOAH_GROK_CONFIG };
  const config = join(directory, 'model.toml');
  writeFileSync(config, '[models]\ndefault="fixture"\n[model.fixture]\nbase_url="http://127.0.0.1:9/v1"\napi_backend="chat_completions"\napi_key="local-only-fixture"\n');
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, config, fromHome: (path: string) => '~/' + relative(homedir(), path) };
}

test('a home-relative Grok config resolves identically in discovery, model listing and loading', t => {
  const { config, fromHome } = paths(t);
  process.env.NOAH_GROK_CONFIG = fromHome(config);
  const detected = discoverHarnesses({ path: '', systemBinDirs: [] }).harnesses.find(h => h.id === 'grok')!;
  assert.deepEqual(detected.configPaths, [config]);
  assert.equal(loadGrokConfig(undefined, 'fixture').source, config);
  assert.deepEqual(listGrokModels(), [{ alias: 'fixture', model: 'fixture', backend: 'chat_completions' }]);
});

test('managed Grok launches the resolved executable discovered from a home-relative override', async t => {
  const { directory, config, fromHome } = paths(t), bin = join(directory, 'bin'); mkdirSync(bin);
  const script = join(directory, 'fixture.mjs');
  writeFileSync(script, `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const result = msg.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    : msg.method === 'session/new' ? { sessionId: 'resolved-executable-fixture' } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
lines.on('close', () => process.exit(0));\n`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'grok'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
  process.env.NOAH_GROK_BIN = fromHome(join(bin, 'grok'));
  const detected = discoverHarnesses().harnesses.find(h => h.id === 'grok')!;
  assert.equal(detected.executablePath, join(bin, 'grok'));
  const adapter = new LocalAdapter({ agent: 'grok', dataDir: join(directory, 'data'), configPath: config, modelAlias: 'fixture',
    row: { conversation_id: 'fixture', agent: 'grok', native_id: null, native_file: null, status: 'offline', error: null, capabilities: null },
    bridgeUrl: 'http://127.0.0.1:9', bridgeToken: 'local-only-bridge-fixture',
    events: { accepted() {}, output() {}, usage() {}, exit() {} },
  });
  try { assert.equal((await adapter.start()).nativeId, 'resolved-executable-fixture'); }
  finally { await adapter.close(); }
});
