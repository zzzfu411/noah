import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { GrokNativeBridge } from '../src/grok-native-bridge.ts';

async function fixture(t: TestContext) {
  const store = new Store(':memory:'); let now = Date.now();
  const bridge = new GrokNativeBridge(store, { now: () => now });
  t.after(() => store.close());
  const request = async (path: string, input: unknown = {}, credential = binding.credential) => {
    const r = await bridge.handle('/api/grok-bridge/' + path, 'POST', credential, input);
    assert.ok(r); return r;
  };
  const grant = bridge.issueJoinToken();
  const registered = await bridge.handle('/api/grok-bridge/register', 'POST', '', { joinToken: grant.joinToken, nativeSessionId: 'actual-hook-session', projectDir: '/work', label: 'Original Grok', callCommand: 'node /noah/grok-native-cli.ts call /private/grant.json' });
  assert.equal(registered?.status, 201);
  const binding = registered!.body;
  assert.throws(() => bridge.get(binding.bindingId), /monitor/);
  await request('poll');
  const c = store.create('Original plus peer', undefined, undefined, undefined, false, [
    { id: 'original', harness: 'grok', mode: 'external', bindingId: binding.bindingId }, { id: 'peer', harness: 'pi' },
  ]);
  const tool = (name: string, args: unknown) => request('tool', { name, args });
  return { store, bridge, c, binding, request, tool, advance: (ms: number) => { now += ms; } };
}

test('Grok monitor batches only attention; full paginated bodies are exact, scoped, and distinctly agent-reported', async t => {
  const f = await fixture(t);
  f.store.send(f.c.id, 'peer', 'human', '旁观完整正文', 'passive');
  assert.equal((await f.request('poll')).body.notification, null);
  const full = '公开正文🔎\n'.repeat(2500);
  f.store.send(f.c.id, 'human', 'original', full, 'attention');
  const notice = (await f.request('poll')).body.notification;
  assert.equal(notice.messageCount, 2);
  assert.equal((await f.request('poll')).body.notification, null, 'a notified batch is never automatically repeated');
  assert.equal((await f.tool('noah_complete', { batchId: notice.batchId })).status, 409);
  const bodies = new Map<string, string>(); let cursor: any = { batchId: notice.batchId };
  while (cursor) {
    const r = await f.tool('noah_read', cursor); assert.equal(r.status, 200);
    const before = f.store.conversation(f.c.id).context_used_bytes;
    assert.deepEqual((await f.tool('noah_read', cursor)).body, r.body);
    assert.equal(f.store.conversation(f.c.id).context_used_bytes, before, 'retry does not reserve bytes twice');
    const m = r.body.message; bodies.set(m.id, (bodies.get(m.id) || '') + m.content); cursor = r.body.next;
  }
  assert.deepEqual([...bodies.values()], ['旁观完整正文', full]);
  assert.equal((await f.tool('noah_propose_outcome', { conversationId: f.c.id, kind: 'conclusion', title: '公开证据支持的建议', content: '仅提案，不声称共识', evidence_message_ids: [[...bodies.keys()][0]], client_message_id: 'proposal' })).status, 200);
  assert.equal((await f.tool('noah_read_outcomes', { conversationId: f.c.id })).body.outcomes.length, 1);
  assert.equal((await f.tool('noah_list_workspaces', { conversationId: f.c.id })).body.advisoryOnly, true);
  assert.equal((await f.tool('noah_send', { conversationId: f.c.id, recipient: 'peer', content: 'Original work can answer without publishing its private history.', clientKey: 'reply' })).status, 200);
  assert.equal((await f.tool('noah_complete', { batchId: notice.batchId })).status, 200);
  assert.ok((f.store.snapshot().deliveries as any[]).filter(d => d.agent === 'original').every(d => d.state === 'agent_reported'));
  assert.equal(f.bridge.get(f.binding.bindingId).capabilities.observedReceipt, false);
});

test('lost native monitor becomes uncertain and never dispatches twice; removed membership loses read and send access', async t => {
  const f = await fixture(t);
  f.store.send(f.c.id, 'human', 'original', 'Wake once', 'wake');
  const notice = (await f.request('poll')).body.notification;
  f.store.removeParticipant(f.c.id, 'original');
  assert.equal((await f.tool('noah_read', { batchId: notice.batchId })).status, 403);
  assert.equal((await f.tool('noah_send', { conversationId: f.c.id, recipient: 'peer', content: 'Must fail', clientKey: 'removed' })).status, 403);
  assert.equal((await f.request('poll')).body.blocked, 'uncertain');
  f.advance(31000);
  assert.equal((await f.request('poll')).status, 401);
  assert.equal((f.bridge.wakes()[0] as any).state, 'uncertain');
  f.bridge.resolveWake(notice.batchId);
  assert.equal((f.store.snapshot().deliveries as any[]).find(d => d.agent === 'original').state, 'cancelled');
});

test('optional byte budget pauses before the native notification and retains every complete message', async t => {
  const f = await fixture(t);
  f.store.db.prepare('UPDATE conversations SET context_budget_bytes=1 WHERE id=?').run(f.c.id);
  const original = f.store.send(f.c.id, 'human', 'original', '完整保留这一条正文', 'budget');
  assert.equal((await f.request('poll')).body.blocked, 'context_budget');
  assert.equal(f.store.conversation(f.c.id).status, 'paused');
  assert.equal(f.store.conversation(f.c.id).used_runs, 0);
  assert.equal(f.store.conversation(f.c.id).context_used_bytes, 0);
  assert.equal(f.store.messages(f.c.id)[0].content, original.content);
  assert.equal(f.bridge.wakes().length, 0);
});
