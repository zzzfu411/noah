import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { Engine } from '../src/engine.ts';

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'noah-owner-retry-'));
  let starts = 0;
  const launch = () => startServer({ dataDir: directory, port: 0, modelCheck: false,
    discovery: () => ({ schemaVersion: 1, harnesses: [], inspection: { filesystemOnly: true, executablesLaunched: false, configurationContentsRead: false, sessionsInspected: false } }),
    engineFactory: (store, dataDir) => new Engine(store, dataDir, () => { starts++; throw new Error('This owner-operation test must not launch a harness'); }),
  });
  let app: Awaited<ReturnType<typeof launch>>;
  t.after(async () => { if (app) await app.close(); rmSync(directory, { recursive: true, force: true }); assert.equal(starts, 0); });
  app = await launch();
  const post = async (path: string, data: unknown, expected = 201) => {
    const response = await fetch(app.url + path, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const value = await response.json() as any;
    assert.equal(response.status, expected, value.error); return value;
  };
  const loseResponse = (path: string, data: unknown) => new Promise<void>((resolve, reject) => {
    const req = httpRequest(app.url + path, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' } }, response => {
      // The server has committed, but the client never receives the result body.
      response.destroy(); resolve();
    });
    req.on('error', reject); req.end(JSON.stringify(data));
  });
  return { post, loseResponse, get store() { return app.store; }, restart: async () => { await app.close(); app = await launch(); } };
}

test('create retries recover the committed result after a lost HTTP response and a restart', async t => {
  const f = await fixture(t);
  const payload = { title: '只创建一个讨论', participants: [{ harness: 'pi' }], clientKey: 'create-once' };
  await f.loseResponse('/api/conversations', payload);
  const saved = f.store.snapshot().conversations[0] as any;
  const eventId = f.store.snapshot().eventId;
  assert.deepEqual(await f.post('/api/conversations', payload), { ...saved });
  assert.equal(f.store.snapshot().conversations.length, 1);
  assert.equal(f.store.sessions(saved.id).length, 1);
  assert.equal(f.store.snapshot().eventId, eventId, 'a replay must not emit a new mutation');
  const conflict = await f.post('/api/conversations', { ...payload, title: '不同的创建内容' }, 400);
  assert.match(conflict.error, /重试标识.*不同内容/);
  await f.restart();
  assert.equal(f.store.conversation(saved.id).status, 'paused');
  assert.deepEqual(await f.post('/api/conversations', payload), { ...saved });
  assert.equal(f.store.conversation(saved.id).status, 'paused', 'replaying a create must not resume the recovered discussion');
  assert.equal(f.store.snapshot().conversations.length, 1);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get()!.user_version, 5);
});

test('resume retries do not add quota or extend the deadline twice and persist across restart', async t => {
  const f = await fixture(t);
  const c = await f.post('/api/conversations', { title: '继续只执行一次', maxRuns: 5 });
  const route = `/api/conversations/${c.id}/control`;
  await f.post(route, { action: 'pause' }, 200);
  const payload = { action: 'resume', additionalRuns: 3, clientKey: 'resume-once' };
  await f.loseResponse(route, payload);
  const saved = { ...f.store.conversation(c.id) };
  assert.equal(saved.max_runs, 8);
  const eventId = f.store.snapshot().eventId;
  assert.deepEqual(await f.post(route, { ...payload, minutes: 20 }, 200), saved, 'omitted default minutes and explicit 20 are equivalent');
  assert.equal(f.store.snapshot().eventId, eventId);
  assert.equal(f.store.conversation(c.id).expires_at, saved.expires_at);
  assert.match((await f.post(route, { ...payload, additionalRuns: 4 }, 400)).error, /重试标识.*不同内容/);
  await f.restart();
  assert.deepEqual(await f.post(route, payload, 200), saved);
  assert.equal(f.store.conversation(c.id).status, 'paused');
  assert.equal(f.store.conversation(c.id).max_runs, 8);
  assert.equal((await f.post(route, { ...payload, clientKey: 'resume-new' }, 200)).max_runs, 11);
});

test('legacy calls remain additive and operation records commit atomically with business changes', async t => {
  const f = await fixture(t);
  const legacy = { title: '无标识兼容', maxRuns: 5 };
  const c = await f.post('/api/conversations', legacy), other = await f.post('/api/conversations', legacy);
  assert.notEqual(c.id, other.id);
  const route = `/api/conversations/${c.id}/control`;
  for (let i = 0; i < 2; i++) await f.post(route, { action: 'resume', additionalRuns: 3 }, 200);
  assert.equal(f.store.conversation(c.id).max_runs, 11);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM owner_operations').get()!.count, 0);
  await f.post(route, { action: 'pause' }, 200);
  f.store.db.exec("CREATE TRIGGER reject_operation BEFORE INSERT ON owner_operations BEGIN SELECT RAISE(ABORT, 'fixture operation write failed'); END;");
  const create = { title: '写入必须一起成功', clientKey: 'atomic-create' };
  const resume = { action: 'resume', additionalRuns: 2, clientKey: 'atomic-resume' };
  assert.match((await f.post('/api/conversations', create, 400)).error, /fixture operation write failed/);
  assert.match((await f.post(route, resume, 400)).error, /fixture operation write failed/);
  assert.equal(f.store.snapshot().conversations.length, 2);
  assert.equal(f.store.conversation(c.id).status, 'paused');
  assert.equal(f.store.conversation(c.id).max_runs, 11);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM owner_operations').get()!.count, 0);
  f.store.db.exec('DROP TRIGGER reject_operation');
  await f.post('/api/conversations', create);
  assert.equal((await f.post(route, resume, 200)).max_runs, 13);
  assert.equal(f.store.snapshot().conversations.length, 3);
});
