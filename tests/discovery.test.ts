import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverHarnesses } from '../src/discovery.ts';
import type { HarnessDiscoveryOptions, HarnessId } from '../src/discovery.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'noah-discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), packageRoot = join(dir, 'noah');
  const options: HarnessDiscoveryOptions = { home, packageRoot, env: {}, path: '', systemBinDirs: [] };
  const file = (path: string, body = 'fixture', mode = 0o600) => {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body, { mode }); return path;
  };
  const item = (id: HarnessId, extra: HarnessDiscoveryOptions = {}) =>
    discoverHarnesses({ ...options, ...extra }).harnesses.find(candidate => candidate.id === id)!;
  return { dir, home, packageRoot, options, file, item };
}

test('empty installation reports all six harnesses with truthful, serializable capabilities', t => {
  const { options } = fixture(t);
  const report = discoverHarnesses(options);
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(report.harnesses.map(item => item.id), ['grok', 'pi', 'codex', 'claude', 'gemini', 'opencode']);
  for (const item of report.harnesses) {
    assert.equal(item.executableInstalled, false);
    assert.equal(item.configPresent, false);
    assert.equal(item.managedCreation.runtimePresent, false);
    assert.equal(item.managedCreation.supported, ['grok', 'pi'].includes(item.id));
    assert.equal(item.liveAttach.capability, ['grok', 'pi'].includes(item.id) ? 'bridge_required' : 'unknown');
    assert.ok(item.explanation && item.liveAttach.explanation && item.managedCreation.explanation);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.deepEqual(report.inspection, {
    filesystemOnly: true, executablesLaunched: false, configurationContentsRead: false, sessionsInspected: false,
  });
});

test('PATH order wins over common locations without executing discovered programs', t => {
  const { dir, home, file, item } = fixture(t);
  const first = join(dir, 'first'), second = join(dir, 'second'), marker = join(dir, 'must-not-exist');
  const script = `#!/bin/sh\ntouch '${marker}'\n`;
  file(join(first, 'grok'), script, 0o700);
  file(join(second, 'grok'), script, 0o700);
  file(join(home, '.grok/bin/grok'), script, 0o700);
  const found = item('grok', { path: [first, second, first] });
  assert.equal(found.executablePath, join(first, 'grok'));
  assert.equal(found.executableSource, 'path');
  assert.equal(found.managedCreation.runtimePresent, true);
  assert.equal(found.managedCreation.modelConfigPresent, false);
  assert.equal(existsSync(marker), false);
});

test('GUI fallback discovers fixed user and system install locations with an empty PATH', t => {
  const { dir, home, file, options } = fixture(t);
  const systemBin = join(dir, 'homebrew/bin');
  const locations: Record<HarnessId, string> = {
    grok: join(home, '.grok/bin/grok'), pi: join(home, '.npm-global/bin/pi'),
    codex: join(systemBin, 'codex'), claude: join(home, '.local/bin/claude'),
    gemini: join(home, '.volta/bin/gemini'), opencode: join(home, '.opencode/bin/opencode'),
  };
  for (const path of Object.values(locations)) file(path, '#!/bin/sh\nexit 1\n', 0o700);
  for (const found of discoverHarnesses({ ...options, systemBinDirs: [systemBin] }).harnesses) {
    assert.equal(found.executableInstalled, true, found.id);
    assert.equal(found.executablePath, locations[found.id]);
    assert.equal(found.executableSource, 'common_location');
  }
});

test('non-executable files, directories and broken symlinks are not CLI installations', t => {
  const { dir, file, item } = fixture(t);
  const bin = join(dir, 'bin');
  file(join(bin, 'grok'), '#!/bin/sh\nexit 0\n', 0o600);
  mkdirSync(join(bin, 'claude'));
  symlinkSync(join(dir, 'absent'), join(bin, 'codex'));
  for (const id of ['grok', 'claude', 'codex'] as const) assert.equal(item(id, { path: bin }).executableInstalled, false);
  file(join(bin, 'real-pi'), '#!/bin/sh\nexit 0\n', 0o700);
  symlinkSync(join(bin, 'real-pi'), join(bin, 'pi'));
  assert.equal(item('pi', { path: bin }).executableInstalled, true);
});

test('configuration and session traces never imply an executable, auth validity or live attachment', t => {
  const { home, file, item, options } = fixture(t);
  const secret = 'fixture-secret-do-not-return';
  const config = file(join(home, '.grok/config.toml'), `invalid TOML with ${secret}`);
  chmodSync(config, 0o000); // Presence remains observable without opening the file.
  file(join(home, '.codex/sessions/history.jsonl'), secret);
  file(join(home, '.pi/agent/auth.json'), secret);
  file(join(home, '.claude/settings.json'), '{not valid json');
  assert.equal(item('grok').configPresent, true);
  assert.equal(item('grok').executableInstalled, false);
  assert.equal(item('claude').configPresent, true);
  assert.equal(item('claude').managedCreation.supported, false);
  assert.equal(item('codex').configPresent, false);
  assert.equal(item('pi').configPresent, false);
  const report = discoverHarnesses({ ...options, env: { ANTHROPIC_API_KEY: secret, OPENAI_API_KEY: secret } });
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(report.harnesses.every(entry => ['unknown', 'bridge_required'].includes(entry.liveAttach.capability)));
  chmodSync(config, 0o600);
  assert.equal(readFileSync(config, 'utf8'), `invalid TOML with ${secret}`);
});

test('Noah bundled pi is independent of an installed CLI and uses Grok model configuration', t => {
  const { home, packageRoot, file, item } = fixture(t);
  const sdk = join(packageRoot, 'node_modules/@earendil-works/pi-coding-agent');
  file(join(sdk, 'package.json'), '{must not be parsed');
  file(join(sdk, 'dist/index.js'), 'throw new Error("must not import SDK")');
  file(join(sdk, 'dist/cli.js'), '#!/bin/sh\nexit 2\n', 0o700);
  file(join(packageRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js'));
  file(join(packageRoot, 'src/pi-worker.ts'));
  const bin = join(packageRoot, 'node_modules/.bin'); mkdirSync(bin);
  symlinkSync(join(sdk, 'dist/cli.js'), join(bin, 'pi'));
  file(join(home, '.grok/config.toml'), 'unvalidated config');
  const found = item('pi', { path: bin });
  assert.deepEqual(found.bundledRuntime, { kind: 'pi_sdk', present: true, path: sdk });
  assert.equal(found.executableInstalled, false);
  assert.equal(found.configPresent, false);
  assert.equal(found.managedCreation.runtimePresent, true);
  assert.equal(found.managedCreation.modelConfigPresent, true);
  const aliasBin = join(home, '.local/bin'); mkdirSync(aliasBin, { recursive: true });
  symlinkSync(join(sdk, 'dist/cli.js'), join(aliasBin, 'pi'));
  assert.equal(item('pi', { path: aliasBin }).executableInstalled, false);
});

test('an external pi CLI alone does not satisfy Noah SDK worker requirements', t => {
  const { home, file, item } = fixture(t);
  file(join(home, '.local/bin/pi'), '#!/bin/sh\nexit 0\n', 0o700);
  const found = item('pi');
  assert.equal(found.executableInstalled, true);
  assert.equal(found.bundledRuntime?.present, false);
  assert.equal(found.managedCreation.runtimePresent, false);
});

test('explicit paths and supported environment locations are injectable without reading env secrets', t => {
  const { dir, home, file, item } = fixture(t);
  const grokBin = file(join(dir, 'custom/grok'), '#!/bin/sh\nexit 0\n', 0o700);
  const env = {
    NOAH_GROK_BIN: grokBin, NOAH_GROK_CONFIG: join(dir, 'grok.toml'), PI_CODING_AGENT_DIR: '~/pi-config',
    CODEX_HOME: join(dir, 'codex-home'), CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
    GEMINI_CLI_HOME: join(dir, 'gemini-home'), XDG_CONFIG_HOME: join(dir, 'xdg'),
    OPENCODE_CONFIG: join(dir, 'custom-opencode.json'), NPM_CONFIG_PREFIX: join(dir, 'npm-prefix'),
  };
  const configs: Record<HarnessId, string> = {
    grok: env.NOAH_GROK_CONFIG, pi: join(home, 'pi-config/models.json'),
    codex: join(env.CODEX_HOME, 'config.toml'), claude: join(env.CLAUDE_CONFIG_DIR, 'settings.json'),
    gemini: join(env.GEMINI_CLI_HOME, '.gemini/settings.json'), opencode: env.OPENCODE_CONFIG,
  };
  for (const path of Object.values(configs)) file(path);
  file(join(env.NPM_CONFIG_PREFIX, 'bin/gemini'), 'fixture', 0o700);
  for (const [id, path] of Object.entries(configs)) assert.deepEqual(item(id as HarnessId, { env }).configPaths, [path]);
  assert.equal(item('grok', { env }).executablePath, grokBin);
  assert.equal(item('grok', { env }).executableSource, 'environment');
  assert.equal(item('gemini', { env }).executableInstalled, true);
});

test('relative and empty PATH entries do not cause project-directory discovery', t => {
  const { packageRoot, file, item } = fixture(t);
  file(join(packageRoot, 'grok'), 'fixture', 0o700);
  file(join(packageRoot, 'relative-bin/grok'), 'fixture', 0o700);
  const originalCwd = process.cwd();
  try {
    process.chdir(packageRoot);
    const found = item('grok', { path: ':.:relative-bin:', env: { NOAH_GROK_BIN: '$(touch must-not-run)' } });
    assert.equal(found.executableInstalled, false);
    assert.equal(found.executablePath, null);
  } finally { process.chdir(originalCwd); }
});
