import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.ts';
import { Engine } from '../src/engine.ts';

test('owner HTTP flow persists membership, material revisions, reviewed outcomes and archive recovery without inference', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'noah-maturity-http-')); let prompts = 0;
  const app = await startServer({ dataDir: directory, port: 0, modelCheck: false,
    discovery: () => ({ schemaVersion: 1, harnesses: [], inspection: { filesystemOnly: true, executablesLaunched: false, configurationContentsRead: false, sessionsInspected: false } }),
    engineFactory: (store, dataDir) => new Engine(store, dataDir, () => ({ start: async () => ({ nativeId: 'isolated-maturity', capabilities: {} }), prompt: async () => { prompts++; }, cancel: async () => {}, close: async () => {} })),
  });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path: string, data?: unknown, status = data === undefined ? 200 : 201) => {
    const response = await fetch(app.url + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await response.json() as any;
    assert.equal(response.status, status, value.error); return value;
  };
  const c = await request('/api/conversations', { title: '完整管理流程', participants: [{ id: 'writer', harness: 'pi' }], contextBudgetBytes: 20000 });
  const base = `/api/conversations/${c.id}`;
  await request(base + '/control', { action: 'pause' }, 200);
  const message = await request(base + '/messages', { recipient: 'writer', content: '需要有依据的结论', clientKey: 'source' });
  assert.equal((await request(base + `/messages/${message.id}`)).message.seq, message.seq);
  await request(base + '/context-budget', { contextBudgetBytes: null }, 200);
  assert.equal(app.store.conversation(c.id).status, 'paused', 'budget changes never resume collaboration');
  await request(base + '/context-budget', { contextBudgetBytes: 20000 }, 200);
  const workspace = await request(base + '/workspaces', { path: directory });
  const intention = await request(base + '/work-intents', { workspace_id: workspace.id, path: 'src/example', description: '准备修改' });
  assert.equal((await request(base + '/workspaces')).intents[0].state, 'active');
  await request(base + `/work-intents/${intention.intent.id}/release`, {}, 200);
  await request(base + '/participants', { participant: { id: 'reviewer', harness: 'pi' }, shareHistory: true });
  const receipts = await request(base + `/deliveries?messageIds=${message.id}`);
  assert.equal(receipts.deliveries.length, 2); assert.equal(receipts.deliveries.find((d: any) => d.agent === 'reviewer').wake, 0);
  const original = await request(base + '/materials', { name: '方案.txt', content: '旧方案' });
  const revised = await request(base + `/materials/${original.id}/revisions`, { name: '方案.txt', content: '更新方案' });
  assert.equal(revised.revision, 2);
  assert.equal((await request(base + `/materials/${original.id}`)).content, '旧方案');
  const outcome = await request(base + '/outcomes', { kind: 'open_question', title: '是否继续', content: '需要补充验证', evidenceMessageIds: [message.id] });
  await request(base + `/outcomes/${outcome.id}/decision`, { decision: 'confirmed', expectedRevision: 1 }, 200);
  await request(base + `/outcomes/${outcome.id}/revisions`, { title: '继续的条件', content: '新版仍须审阅', evidenceMessageIds: [message.id], expectedRevision: 1 });
  assert.equal((await request(base + '/outcomes')).decisions[0].decision, 'confirmed');
  const files = await request('/api/grok-bridge-grants', {});
  assert.equal(files.experimental, true); assert.equal(files.joinToken, undefined);
  const grant = JSON.parse(readFileSync(files.grantPath, 'utf8'));
  const bridgeRequest = async (route: string, data: unknown, credential = '') => {
    const response = await fetch(app.url + '/api/grok-bridge/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify(data) });
    assert.ok(response.ok); return await response.json() as any;
  };
  const registered = await bridgeRequest('register', { joinToken: grant.joinToken, nativeSessionId: 'isolated-hook-fixture', projectDir: directory, label: '实验 Grok', callCommand: 'fixture-call' });
  await bridgeRequest('poll', {}, registered.credential);
  await request(base + '/participants', { participant: { id: 'native-grok', harness: 'grok', mode: 'external', bindingId: registered.bindingId }, shareHistory: true });
  assert.ok((await request('/api/native-sessions')).sessions.some((s: any) => s.id === registered.bindingId && s.harness === 'grok'));
  await request(base + '/participants/writer/remove', {}, 200);
  await request(base + '/control', { action: 'archive' }, 200);
  await request(base + '/control', { action: 'resume' }, 400);
  const state = await request('/api/state?compact=1');
  assert.equal(state.compact, true); assert.equal(state.outcomes[0].status, 'proposed');
  assert.equal(state.conversations[0].status, 'archived');
  const exported = await request(base + '/export?format=json');
  assert.equal(exported.materials.length, 2); assert.equal(exported.outcomeRevisions.length, 2);
  assert.equal(exported.workspaceCoordination.grants[0].root, workspace.root);
  assert.ok(exported.membership.find((m: any) => m.participant_id === 'writer').removed_at);
  const restored = await request(base + '/control', { action: 'restore' }, 200);
  assert.equal(restored.status, 'paused'); assert.equal(restored.context_budget_bytes, 20000);
  await new Promise(r => setTimeout(r, 20)); assert.equal(prompts, 0);
});
