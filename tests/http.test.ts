import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { startServer } from '../src/server.ts';
import { Engine } from '../src/engine.ts';
import type { HarnessDiscoveryReport } from '../src/discovery.ts';

test('owner pairing, origin checks, scoped tools and reconnect reads cannot forge or replay work', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-http-')); let starts = 0;
  const app = await startServer({ dataDir: dir, port: 0, modelCheck: false,
    engineFactory: (store, dataDir) => new Engine(store, dataDir, () => ({
      start: async () => ({ nativeId: 'mock', capabilities: {} }),
      prompt: async () => { starts++; }, cancel: async () => {}, close: async () => {},
    })),
  });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(app.url + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal((await request('/api/state')).status, 401);
  const owner = { Authorization: `Bearer ${app.token}` };
  for (const file of ['grok.svg', 'pi.svg', 'codex.png', 'claude.png', 'gemini.png', 'opencode.svg', 'opencode-dark.svg']) {
    const asset = await request('/assets/harnesses/' + file);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type')!, file.endsWith('.svg') ? /^image\/svg\+xml/ : /^image\/png/);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), readFileSync(new URL('../public/assets/harnesses/' + file, import.meta.url)));
  }
  assert.equal((await request('/assets/harnesses/LICENSE-pi.txt', undefined, owner)).status, 404);
  assert.equal((await request('/assets/harnesses/../../../../package.json', undefined, owner)).status, 404);
  assert.equal((await request('/api/state', undefined, { ...owner, Origin: 'https://evil.invalid' })).status, 403);
  // Fetch intentionally normalizes Host; use an actual raw HTTP request for this boundary.
  const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(app.url + '/api/state', { headers: { ...owner, Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHostStatus, 403);
  const pair = await request('/api/pair', {}, owner); assert.equal(pair.status, 200);
  const setCookie = pair.headers.get('set-cookie')!; assert.ok(setCookie.includes('HttpOnly; SameSite=Strict'));
  assert.equal((await request('/api/state', undefined, { Cookie: setCookie.split(';')[0] })).status, 200);
  const c = await (await request('/api/conversations', { title: 'HTTP test' }, owner)).json() as any;
  assert.equal((await request(`/api/conversations/${c.id}/messages`, { sender: 'pi', recipient: 'grok', content: 'fake', clientKey: 'bad' }, owner)).status, 400);
  assert.equal((await request('/api/tool', { name: 'noah_send', args: { recipient: 'grok', content: 'forged' }, callId: 'bad' }, owner)).status, 403);
  const data = { recipient: 'grok', content: 'once', clientKey: 'retry' };
  await request(`/api/conversations/${c.id}/messages`, data, owner);
  await request(`/api/conversations/${c.id}/messages`, data, owner);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(starts, 1);
  const abort = new AbortController();
  const stream = await fetch(app.url + '/api/events', { headers: owner, signal: abort.signal });
  assert.equal(stream.status, 200); await stream.body!.getReader().read(); abort.abort();
  await request('/api/state', undefined, owner); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(starts, 1); assert.equal(app.store.messages(c.id).length, 1);
  const exported = await request(`/api/conversations/${c.id}/export`, undefined, owner);
  assert.match(await exported.text(), /human → grok/);
});

test('installation inventory is owner-only, cached for state reads, and cannot dispatch work', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-discovery-http-'));
  let scans = 0, adapters = 0, starts = 0, prompts = 0, failScan = false;
  const privatePath = '/private/fixture-owner-installation/grok';
  const app = await startServer({ dataDir: dir, port: 0, modelCheck: false,
    discovery: () => {
      scans++;
      if (failScan) throw new Error('Discovery temporarily unavailable');
      const report: HarnessDiscoveryReport = {
        schemaVersion: 1,
        harnesses: [{
          id: 'grok', label: 'Grok', executableInstalled: true,
          executablePath: privatePath, executableSource: 'path',
          configPresent: true, configPaths: [`${privatePath}-config-${scans}.toml`], bundledRuntime: null,
          managedCreation: { supported: true, runtimePresent: true, modelConfigPresent: true, explanation: 'Presence only' },
          liveAttach: { capability: 'bridge_required', explanation: 'Not attached' }, explanation: 'Test installation',
        }],
        inspection: { filesystemOnly: true, executablesLaunched: false, configurationContentsRead: false, sessionsInspected: false },
      };
      return report;
    },
    engineFactory: (store, dataDir) => new Engine(store, dataDir, () => {
      adapters++;
      return { start: async () => { starts++; return { nativeId: 'must-not-start', capabilities: {} }; },
        prompt: async () => { prompts++; }, cancel: async () => {}, close: async () => {} };
    }),
  });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = { Authorization: `Bearer ${app.token}` };
  const rawHost = (path: string) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = httpRequest(app.url + path, { headers: { ...owner, Host: 'evil.invalid' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject); req.end();
  });
  for (const path of ['/api/state', '/api/harnesses']) {
    for (const [headers, status] of [
      [{}, 401], [{ Authorization: 'Bearer unrelated-agent-token' }, 401],
      [{ ...owner, Origin: 'https://evil.invalid' }, 403],
      [{ ...owner, Origin: 'null' }, 403],
    ] as const) {
      const response = await fetch(app.url + path, { headers });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.ok(!(await response.text()).includes(privatePath));
    }
    const badHost = await rawHost(path);
    assert.equal(badHost.status, 403); assert.ok(!badHost.body.includes(privatePath));
  }
  assert.equal(scans, 0, 'denied requests must not even run the filesystem scanner');

  // A paused delivery makes accidental wake-up visible, without invoking a real model.
  const conversation = app.store.create('Discovery must not resume this task');
  app.store.pause(conversation.id, 'Owner paused');
  app.store.send(conversation.id, 'human', 'grok', 'Waiting for explicit resume', 'held-message');
  const before = app.store.snapshot();
  const initial = await (await fetch(app.url + '/api/state', { headers: owner })).json() as any;
  assert.equal(scans, 1);
  assert.equal(initial.discovery.harnesses[0].executablePath, privatePath);
  for (let i = 0; i < 3; i++) {
    const state = await (await fetch(app.url + '/api/state', { headers: owner })).json() as any;
    assert.deepEqual(state.discovery, initial.discovery);
  }
  assert.equal(scans, 1, 'ordinary state refreshes reuse the installation snapshot');

  const pair = await fetch(app.url + '/api/pair', { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = pair.headers.get('set-cookie')!.split(';')[0];
  const refreshedResponse = await fetch(app.url + '/api/harnesses', { headers: { Cookie: cookie } });
  assert.equal(refreshedResponse.status, 200);
  assert.equal(refreshedResponse.headers.get('cache-control'), 'no-store');
  const refreshed = await refreshedResponse.json() as any;
  assert.equal(scans, 2);
  assert.notDeepEqual(refreshed.harnesses[0].configPaths, initial.discovery.harnesses[0].configPaths);
  const cached = await (await fetch(app.url + '/api/state', { headers: owner })).json() as any;
  assert.deepEqual(cached.discovery, refreshed); assert.equal(scans, 2);

  const wrongMethod = await fetch(app.url + '/api/harnesses', { method: 'POST', headers: owner });
  assert.equal(wrongMethod.status, 404); assert.equal(scans, 2);
  failScan = true;
  assert.equal((await fetch(app.url + '/api/harnesses', { headers: owner })).status, 400);
  const retained = await (await fetch(app.url + '/api/state', { headers: owner })).json() as any;
  assert.deepEqual(retained.discovery, refreshed, 'a failed rescan preserves the previous cache');
  assert.equal(scans, 3);
  failScan = false;
  assert.equal((await fetch(app.url + '/api/harnesses', { headers: owner })).status, 200);
  assert.equal(scans, 4);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(app.store.snapshot(), before, 'inventory queries must not change durable task state');
  assert.equal(adapters, 0); assert.equal(starts, 0); assert.equal(prompts, 0);
});

test('HTTP collaboration policy defaults to autonomous and only explicit resume changes legacy limits', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-policy-http-')); let starts = 0;
  const app = await startServer({ dataDir: dir, port: 0, modelCheck: false,
    engineFactory: (store, dataDir) => new Engine(store, dataDir, () => ({
      start: async () => ({ nativeId: 'policy-mock', capabilities: {} }),
      prompt: async () => { starts++; }, cancel: async () => {}, close: async () => {},
    })),
  });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const owner = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(app.url + path, {
    method: 'POST', headers: owner, body: JSON.stringify(body),
  });
  const create = async (body: unknown) => {
    const response = await post('/api/conversations', body);
    assert.equal(response.status, 201);
    return await response.json() as any;
  };
  const autonomous = await create({ title: 'Default autonomous' });
  assert.equal(autonomous.limits_enabled, 0);
  const legacy = await create({ title: 'Legacy bounds', maxRuns: 1, minutes: 1 });
  assert.equal(legacy.limits_enabled, 1);
  assert.equal((await create({ title: 'Legacy time bound', minutes: 1 })).limits_enabled, 1);
  const explicit = await create({ title: 'Explicit bounds', limitsEnabled: true });
  assert.equal(explicit.limits_enabled, 1); assert.equal(explicit.max_runs, 12);
  assert.equal((await create({ title: 'Explicit autonomous wins', maxRuns: 1, minutes: 1, limitsEnabled: false })).limits_enabled, 0);
  assert.equal((await post('/api/conversations', { title: 'Invalid flag', limitsEnabled: 'false' })).status, 400);
  const control = async (body: unknown) => {
    const response = await post(`/api/conversations/${legacy.id}/control`, body);
    assert.equal(response.status, 200); return await response.json() as any;
  };
  const paused = await control({ action: 'pause', additionalRuns: 99, minutes: 240, limitsEnabled: false });
  assert.equal(paused.status, 'paused'); assert.equal(paused.limits_enabled, 1);
  assert.equal(paused.max_runs, legacy.max_runs); assert.equal(paused.expires_at, legacy.expires_at);
  await post(`/api/conversations/${legacy.id}/messages`, { recipient: 'pi', content: 'Held until explicit resume', clientKey: 'held' });
  const state = await (await fetch(app.url + '/api/state', { headers: owner })).json() as any;
  assert.equal(state.conversations.find((c: any) => c.id === legacy.id).limits_enabled, 1);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(starts, 0);
  const stopped = await control({ action: 'stop', limitsEnabled: false });
  assert.equal(stopped.status, 'paused'); assert.equal(stopped.limits_enabled, 1);
  const resumed = await control({ action: 'resume', limitsEnabled: false });
  assert.equal(resumed.limits_enabled, 0); assert.equal(resumed.status, 'active');
  const deadline = Date.now() + 2500;
  const startCount = () => starts;
  while (startCount() !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(starts, 1);
  await control({ action: 'pause' });
  const bounded = await control({ action: 'resume', limitsEnabled: true, additionalRuns: 4, minutes: 2 });
  assert.equal(bounded.limits_enabled, 1); assert.equal(bounded.max_runs, bounded.used_runs + 4);
  const extended = await control({ action: 'resume', additionalRuns: 2 });
  assert.equal(extended.limits_enabled, 1); assert.equal(extended.max_runs, bounded.max_runs + 2);
});
