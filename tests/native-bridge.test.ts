import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SessionManager, createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Store } from '../src/store.ts';
import { NativeBridge } from '../src/native-bridge.ts';
import { BridgeHttpError, NOAH_DISCUSSION_TYPE, NOAH_WAKE_TYPE, PiBridgeClient, type BridgeTransport, type PiBridgeHost } from '../src/native-bridge-client.ts';
import noahPi from '../extensions/noah-pi.ts';

function fixture(t: any) {
  const store = new Store(':memory:'); let now = Date.now();
  const bridge = new NativeBridge(store, { now: () => now });
  const requests: any[] = [];
  const transport: BridgeTransport = async (path, credential, body) => {
    requests.push({ path, body });
    const result = await bridge.handle(path, 'POST', credential, body);
    if (!result) throw new Error('Unknown route');
    if (result.status >= 400) throw new BridgeHttpError(result.status, result.body.error);
    return result.body;
  };
  t.after(() => store.close());
  return { store, bridge, transport, requests, advance: (ms: number) => { now += ms; } };
}
/** Models precisely pi 0.87.0's passive FIFO and void API; real SDK is tested separately below. */
function fakeHost() {
  let manager = SessionManager.inMemory('/work');
  let idle = true;
  const queue: any[] = [], notices: string[] = [];
  let prompts = 0;
  const host: PiBridgeHost = {
    nativeSessionId: () => manager.getSessionId(), projectDir: () => '/work', label: () => 'Existing work',
    isIdle: () => idle, hasPendingMessages: () => false,
    entries: () => manager.getEntries(), contextEntries: () => manager.buildContextEntries(),
    notify: message => { notices.push(message); },
    sendMessage: (message, options) => {
      if (options.triggerTurn) { assert.equal(options.deliverAs, 'followUp'); prompts++; manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); idle = false; }
      else if (!idle) queue.push(message);
      else manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    },
  };
  return { host, notices, get manager() { return manager; }, get prompts() { return prompts; }, get queued() { return queue.length; }, setBusy() { idle = false; }, settle() {
    manager.appendMessage({ role: 'assistant', content: [], api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    while (queue.length) { const m = queue.shift(); manager.appendCustomMessageEntry(m.customType, m.content, m.display, m.details); } idle = true;
  }, switchSession() { manager = SessionManager.inMemory('/work'); idle = true; } };
}
async function joined(t: any, options: { transport?: (base: BridgeTransport) => BridgeTransport; limits?: boolean } = {}) {
  const f = fixture(t), native = fakeHost();
  const client = new PiBridgeClient(native.host, options.transport?.(f.transport) || f.transport);
  await client.connect(f.bridge.issueJoinToken({ projectDir: '/work' }).joinToken, { poll: false });
  const c = f.store.create('Existing native work', options.limits ? 1 : undefined, undefined, undefined, options.limits, [
    { id: 'native-pi', harness: 'pi', mode: 'external', bindingId: client.bindingId, label: 'My original pi' },
    { id: 'grok-peer', harness: 'grok', mode: 'managed', label: 'Grok peer' },
  ]);
  t.after(() => { void client.disconnect(); });
  return { ...f, ...native, native, client, c };
}
const discussionEntries = (f: { native: ReturnType<typeof fakeHost> }) => f.native.manager.getEntries().filter(e => e.type === 'custom_message' && e.customType === NOAH_DISCUSSION_TYPE);

test('enrollment validates its one-use project grant and permits no extra metadata', async t => {
  const { bridge, transport } = fixture(t);
  const joinToken = bridge.issueJoinToken({ projectDir: '/approved' }).joinToken;
  const input = { joinToken, nativeSessionId: 'native', runtimeId: 'runtime', projectDir: '/elsewhere', label: 'Work', idle: true, capabilities: 'pi-extension-v1' };
  await assert.rejects(transport('/api/bridge/register', '', input), /授权范围/);
  await assert.rejects(transport('/api/bridge/register', '', { ...input, projectDir: '/approved', privateHistory: 'secret' }), /字段无效/);
  const registered = await transport('/api/bridge/register', '', { ...input, projectDir: '/approved' });
  assert.equal(registered.generation, 1);
  await assert.rejects(transport('/api/bridge/register', '', { ...input, projectDir: '/approved' }), /已使用/);
  assert.equal(JSON.stringify(bridge.list()).includes(registered.credential), false);
  assert.equal(await bridge.handle('/api/conversations', 'POST', registered.credential, {}), undefined);
  assert.equal(bridge.get(registered.bindingId).nativeSessionId, 'native');
});

test('full passive discussion enters the original native session without any inference or private-history publication', async t => {
  const f = await joined(t);
  const originalId = f.native.manager.getSessionId();
  f.native.manager.appendMessage({ role: 'user', content: 'PRIVATE ORIGINAL WORK', timestamp: Date.now() });
  f.store.send(f.c.id, 'human', 'grok-peer', 'Complete public body\n第二行', 'passive');
  await f.client.tick();
  assert.equal(f.native.prompts, 0);
  assert.equal(f.native.manager.getSessionId(), originalId);
  assert.equal(discussionEntries(f).length, 1);
  assert.ok((discussionEntries(f)[0] as any).content.endsWith('Complete public body\n第二行'));
  const journal = f.store.db.prepare('SELECT * FROM native_bridge_deliveries').get() as any;
  assert.ok(journal.entry_id); assert.equal(journal.context_present, 1);
  assert.equal(JSON.stringify(f.requests).includes('PRIVATE ORIGINAL WORK'), false);
  assert.equal(f.store.conversation(f.c.id).used_runs, 0);
});

test('actual pi SDK passive append keeps its existing session and makes zero provider calls', async t => {
  const f = fixture(t), dir = mkdtempSync(join(tmpdir(), 'noah-native-sdk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('no-network', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', models: [{ id: 'fake', name: 'fake', input: ['text'], contextWindow: 32000, maxTokens: 1000, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, additionalExtensionPaths: [fileURLToPath(new URL('../extensions/noah-pi.ts', import.meta.url))], noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const sendTool = loaded.extensions[0].tools.get('noah_send');
  assert.equal((sendTool?.definition.parameters as any).type, 'object');
  assert.equal((sendTool?.definition.parameters as any).properties.content.type, 'string');
  const sessionManager = SessionManager.create(dir, join(dir, 'sessions'));
  sessionManager.appendMessage({ role: 'user', content: 'private existing work', timestamp: Date.now() });
  const nativeId = sessionManager.getSessionId();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel('no-network', 'fake'), settingsManager, resourceLoader: loader, sessionManager, tools: [] });
  t.after(() => session.dispose());
  let modelStarts = 0; session.subscribe(e => { if (e.type === 'agent_start') modelStarts++; });
  const client = new PiBridgeClient({ nativeSessionId: () => sessionManager.getSessionId(), projectDir: () => dir, label: () => 'Native SDK fixture', isIdle: () => !session.isStreaming, hasPendingMessages: () => false, entries: () => sessionManager.getEntries(), contextEntries: () => sessionManager.buildContextEntries(), notify() {}, sendMessage: (message, options) => { void session.sendCustomMessage(message, options); } }, f.transport);
  await client.connect(f.bridge.issueJoinToken({ projectDir: dir }).joinToken, { poll: false });
  const c = f.store.create('SDK', undefined, undefined, undefined, false, [{ id: 'existing', harness: 'pi', mode: 'external', bindingId: client.bindingId }, { id: 'other', harness: 'grok' }]);
  f.store.send(c.id, 'human', 'other', 'Full shared public message', 'sdk-passive');
  await client.tick();
  assert.equal(session.sessionManager, sessionManager);
  assert.equal(sessionManager.getSessionId(), nativeId);
  assert.equal(modelStarts, 0);
  assert.ok(sessionManager.getEntries().some(e => e.type === 'custom_message' && e.customType === NOAH_DISCUSSION_TYPE));
  assert.equal((f.store.db.prepare('SELECT entry_id FROM native_bridge_deliveries').get() as any).entry_id !== null, true);
  // A fresh native session may not have flushed to disk: the ACK claims memory observation only.
  const ack = f.requests.find(r => r.path.endsWith('/receipt')); assert.ok(ack);
  await client.disconnect();
});

test('multiple directed messages coalesce into one wake after every full body is observed', async t => {
  const f = await joined(t);
  f.store.send(f.c.id, 'human', 'native-pi', 'Question one', 'q1');
  f.store.send(f.c.id, 'grok-peer', 'native-pi', 'Question two', 'q2');
  f.store.send(f.c.id, 'human', 'grok-peer', 'Passive three', 'q3');
  await f.client.tick();
  assert.equal(discussionEntries(f).length, 3);
  assert.equal(f.native.prompts, 1);
  assert.equal(f.store.conversation(f.c.id).used_runs, 1);
  await f.client.tick(); assert.equal(f.native.prompts, 1);
  f.native.settle(); await f.client.agentSettled();
  assert.equal((f.bridge.wakes()[0] as any).state, 'completed');
  assert.equal(f.native.prompts, 1);
});

test('lost transcript ACK is retried without repeating the original entry or blocking a later wake', async t => {
  let lose = true;
  const f = await joined(t, { transport: base => async (path, credential, input) => {
    const result = await base(path, credential, input);
    if (lose && path.endsWith('/receipt')) { lose = false; throw new TypeError('simulated connection loss after commit'); }
    return result;
  } });
  f.store.send(f.c.id, 'human', 'native-pi', 'Exactly one transcript body', 'lost-ack');
  await f.client.tick(); assert.equal(discussionEntries(f).length, 1); assert.equal(f.native.prompts, 0);
  await f.client.tick(); assert.equal(discussionEntries(f).length, 1); assert.equal(f.native.prompts, 1);
});

test('busy native session queues passive content and does not ACK the void send call', async t => {
  const f = await joined(t);
  await f.client.tick(); f.native.setBusy();
  f.store.send(f.c.id, 'human', 'native-pi', 'wait for safe point', 'busy');
  await f.client.tick(); await f.client.tick();
  assert.equal(f.native.queued, 1);
  assert.equal((f.store.db.prepare('SELECT entry_id FROM native_bridge_deliveries').get() as any).entry_id, null);
  assert.equal(f.native.prompts, 0);
  f.native.settle(); await f.client.agentSettled();
  assert.equal(discussionEntries(f).length, 1); assert.equal(f.native.prompts, 1);
});

test('busy reload waits for the old passive queue before reconciling the same native binding', async t => {
  const f = await joined(t);
  await f.client.tick(); f.native.setBusy();
  f.store.send(f.c.id, 'human', 'grok-peer', 'old pending native append', 'reload');
  await f.client.tick(); assert.equal(f.native.queued, 1);
  const originalBinding = f.client.bindingId;
  await f.client.disconnect();
  const restored = new PiBridgeClient(f.native.host, f.transport);
  await restored.connect(f.bridge.issueJoinToken({ projectDir: '/work' }).joinToken, { poll: false });
  assert.equal(restored.bindingId, originalBinding);
  await restored.tick(); assert.equal(f.native.queued, 1);
  f.native.settle(); await restored.tick();
  assert.equal(discussionEntries(f).length, 1);
  assert.equal(f.native.prompts, 0);
  await restored.disconnect();
});

test('expired leases reconnect with a new generation and reject stale receipts', async t => {
  const f = fixture(t), joinToken = f.bridge.issueJoinToken().joinToken;
  const r = await f.transport('/api/bridge/register', '', { joinToken, nativeSessionId: 'native', runtimeId: 'runtime', projectDir: '/work', label: 'Work', idle: true, capabilities: 'pi-extension-v1' });
  f.advance(31000); assert.equal(f.bridge.list()[0].status, 'offline');
  const next = await f.transport('/api/bridge/reconnect', r.credential, { generation: r.generation, nativeSessionId: 'native', runtimeId: 'runtime' });
  assert.ok(next.generation > r.generation);
  await assert.rejects(f.transport('/api/bridge/receipt', r.credential, { generation: r.generation, receipts: [] }), /代次/);
  await assert.rejects(f.transport('/api/bridge/reconnect', r.credential, { generation: next.generation, nativeSessionId: 'other-session', runtimeId: 'runtime' }), /ID 已改变/);
  f.bridge.revoke(r.bindingId);
  await assert.rejects(f.transport('/api/bridge/heartbeat', r.credential, { generation: next.generation, nativeSessionId: 'native', status: 'idle' }), /已撤销/);
});

test('late network responses never append to a successor native session', async t => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), pending = new Promise<void>(r => { release = r; });
  const f = await joined(t, { transport: base => async (path, credential, input) => { const result = await base(path, credential, input); if (path.endsWith('/inbox')) { entered(); await pending; } return result; } });
  f.store.send(f.c.id, 'human', 'native-pi', 'must not leak into successor', 'switch');
  const tick = f.client.tick(); await ready;
  f.native.switchSession(); release(); await tick;
  assert.equal(f.native.manager.getEntries().length, 0);
  await f.client.tick(); assert.equal(f.client.connected, false);
});

test('lost wake-start response is not retried as a model turn and becomes owner-resolvable uncertainty', async t => {
  let lose = true;
  const f = await joined(t, { transport: base => async (path, credential, input) => { const result = await base(path, credential, input); if (lose && path.endsWith('/wake-start')) { lose = false; throw new TypeError('connection lost after wake reservation'); } return result; } });
  f.store.send(f.c.id, 'human', 'native-pi', 'potentially expensive action', 'uncertain');
  await f.client.tick(); await f.client.tick();
  assert.equal(f.native.prompts, 0);
  assert.equal((f.bridge.wakes()[0] as any).state, 'uncertain');
  f.advance(31000);
  const wake = f.bridge.wakes()[0] as any; assert.equal(wake.state, 'uncertain');
  await f.client.tick(); assert.equal(f.native.prompts, 0);
  f.bridge.resolveWake(wake.id); assert.equal((f.bridge.wakes()[0] as any).state, 'cancelled');
});

test('native communication tools are scoped to joined discussions and publication is idempotent', async t => {
  const f = await joined(t);
  const another = f.store.create('Private unrelated discussion');
  await assert.rejects(f.client.tool('noah_read', { conversationId: another.id }), /未加入/);
  const peers = await f.client.tool('noah_peers', {});
  assert.equal(peers[0].self, 'native-pi');
  const args = { conversationId: f.c.id, recipient: 'grok-peer', content: 'Explicitly shared finding', clientKey: 'publish-id' };
  const first = await f.client.tool('noah_send', args), again = await f.client.tool('noah_send', args);
  assert.equal(first.id, again.id); assert.equal(first.sender, 'native-pi');
  await assert.rejects(f.client.tool('noah_send', { ...args, content: 'different' }), /Idempotency/);
  await assert.rejects(f.client.tool('pause_everyone', {}), /字段无效/);
});

test('native owner limits stop new wakes while keeping passive full messages observable', async t => {
  const f = await joined(t, { limits: true });
  f.store.send(f.c.id, 'human', 'native-pi', 'First allowed wake', 'limit1'); await f.client.tick();
  f.native.settle(); await f.client.agentSettled();
  f.store.send(f.c.id, 'human', 'native-pi', 'Second awaits owner', 'limit2'); await f.client.tick();
  assert.equal(f.native.prompts, 1); assert.equal(discussionEntries(f).length, 2);
  assert.equal(f.store.conversation(f.c.id).status, 'paused');
});

test('pausing a reserved discussion releases its native binding for another discussion', async t => {
  let pauseFirst = true;
  let pausedId = '';
  let f: Awaited<ReturnType<typeof joined>>;
  f = await joined(t, { transport: base => async (path, credential, input) => {
    const result = await base(path, credential, input);
    if (pauseFirst && path.endsWith('/wake') && result.wake) {
      pauseFirst = false; pausedId = result.wake.conversationId;
      f.store.pause(pausedId, 'Owner paused before model start');
    }
    return result;
  } });
  const other = f.store.create('Other task', undefined, undefined, undefined, false, [{ id: 'native-again', harness: 'pi', mode: 'external', bindingId: f.client.bindingId }, { id: 'other-grok', harness: 'grok' }]);
  f.store.send(f.c.id, 'human', 'native-pi', 'Do not start this paused question', 'pause-reservation');
  await f.client.tick(); assert.equal(pausedId, f.c.id); assert.equal(f.native.prompts, 0);
  f.store.send(other.id, 'human', 'native-again', 'Other task may proceed', 'other-question');
  await f.client.tick(); assert.equal(f.native.prompts, 1);
  assert.equal((f.bridge.wakes().find((w: any) => w.conversation_id === f.c.id) as any).state, 'cancelled');
  assert.equal((f.bridge.wakes().find((w: any) => w.conversation_id === other.id) as any).state, 'starting');
});

test('history presence outside the active context is reported separately and never wakes', async t => {
  const f = await joined(t);
  f.native.host.contextEntries = () => [];
  f.store.send(f.c.id, 'human', 'native-pi', 'Not in current projection', 'context-mismatch');
  await f.client.tick();
  assert.equal(f.native.prompts, 0);
  const journal = f.store.db.prepare('SELECT * FROM native_bridge_deliveries').get() as any;
  assert.ok(journal.entry_id); assert.equal(journal.context_present, 0);
  assert.equal(f.bridge.list()[0].status, 'paused');
});

test('requesting the owner preserves the question and pauses only the joined discussion', async t => {
  const f = await joined(t);
  const other = f.store.create('Unrelated');
  const result = await f.client.tool('noah_request_human', { conversationId: f.c.id, question: 'May this task change the project scope?', clientKey: 'ask-owner' });
  assert.equal(result.status, 'waiting_human');
  assert.equal(f.store.conversation(f.c.id).status, 'paused');
  assert.equal(f.store.conversation(other.id).status, 'active');
  const response = await f.client.tool('noah_send', { conversationId: f.c.id, recipient: 'human', content: 'Current work status is preserved while paused', clientKey: 'final-status' });
  assert.equal(response.sender, 'native-pi');
});

test('native metrics count unique full bodies separately from short wake requests', async t => {
  const f = await joined(t);
  f.store.send(f.c.id, 'human', 'native-pi', '你好', 'metrics');
  await f.client.tick(); await f.client.tick();
  const metrics = f.bridge.metrics() as any;
  assert.equal(metrics.observed_messages, 1); assert.equal(metrics.shared_body_bytes, 6);
  assert.ok(metrics.observed_envelope_bytes > 6); assert.ok(metrics.wake_prompt_bytes > 0);
  assert.equal(metrics.wake_start_requests, 1); assert.equal(metrics.provider_input_tokens, null);
});

test('old unresolved native wakes remain actionable beyond 200 completed records', async t => {
  const f = await joined(t);
  const insert = f.store.db.prepare('INSERT INTO native_bridge_wakes(id,binding_id,conversation_id,generation,state,created_at) VALUES(?,?,?,?,?,?)');
  const uncertainId = randomUUID(), reservedId = randomUUID(), startingId = randomUUID();
  for (const [id, state] of [[uncertainId, 'uncertain'], [reservedId, 'reserved'], [startingId, 'starting']]) insert.run(id, f.client.bindingId, f.c.id, f.client.generation, state, 1);
  for (let i = 0; i < 240; i++) insert.run(randomUUID(), f.client.bindingId, f.c.id, f.client.generation, 'completed', 100 + i);
  const wakes = f.bridge.wakes() as any[];
  assert.equal(wakes.length, 203);
  for (const id of [uncertainId, reservedId, startingId]) assert.ok(wakes.some(w => w.id === id));
  f.bridge.resolveWake(uncertainId);
  assert.equal((f.store.db.prepare('SELECT state FROM native_bridge_wakes WHERE id=?').get(uncertainId) as any).state, 'cancelled');
});

test('v0.4 native removal and archive block new delivery and tools without ending the original process', async t => {
  for (const action of ['remove', 'archive'] as const) {
    let applyChange = true;
    let f: Awaited<ReturnType<typeof joined>>;
    f = await joined(t, { transport: base => async (path, credential, input) => {
      const result = await base(path, credential, input);
      if (applyChange && path.endsWith('/wake') && result.wake) {
        applyChange = false;
        f.store.send(f.c.id, 'human', 'grok-peer', '已持久保存，但变更后不再注入原会话', 'pending-at-change');
        if (action === 'remove') f.store.removeParticipant(f.c.id, 'native-pi');
        else f.store.control(f.c.id, 'archive');
      }
      return result;
    } });
    const originalId = f.native.manager.getSessionId();
    f.store.send(f.c.id, 'human', 'native-pi', '已追加，但用户决定前不能开始推理', 'reserved-at-change');
    await f.client.tick(); await f.client.tick();
    assert.equal(f.native.prompts, 0);
    assert.equal(f.native.manager.getSessionId(), originalId);
    assert.equal(discussionEntries(f).length, 1, 'pending full body remains in Noah after the owner change');
    assert.equal(f.client.connected, true, 'leaving one discussion does not revoke or terminate the original pi process');
    assert.equal(f.store.conversation(f.c.id).status, action === 'archive' ? 'archived' : 'active');
    assert.ok(f.bridge.wakes().every((wake: any) => wake.state === 'cancelled'));
    await assert.rejects(f.client.tool('noah_read', { conversationId: f.c.id }), /未加入|归档|archived/);
    await assert.rejects(f.client.tool('noah_send', { conversationId: f.c.id, recipient: 'grok-peer', content: '不再接受新工具调用', clientKey: 'after-change' }), /未加入|归档|archived/);
    assert.equal(f.store.messages(f.c.id).length, 2);
  }
});

test('v0.4 native context reservations charge repeated inbox once and pause before a budget-exceeding wake', async t => {
  const f = await joined(t);
  await f.client.tick();
  f.store.control(f.c.id, 'resume', 0, 20, undefined, 100000);
  f.native.setBusy();
  const body = '公开正文保持完整，不能因为预算而截断。\n'.repeat(30);
  const message = f.store.send(f.c.id, 'human', 'native-pi', body, 'budgeted-body');
  await f.client.tick();
  const reserved = f.store.conversation(f.c.id).context_used_bytes;
  assert.ok(reserved > Buffer.byteLength(body));
  await f.client.tick();
  assert.equal(f.store.conversation(f.c.id).context_used_bytes, reserved, 'same generation and delivery reuse the committed reservation');
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM context_charges').get() as any).n, 1);
  assert.equal(f.native.queued, 1);
  f.store.control(f.c.id, 'resume', 0, 20, undefined, reserved);
  f.native.settle(); await f.client.agentSettled(); await f.client.tick();
  assert.equal(f.native.prompts, 0, 'wake prompt must not call triggerTurn after its reservation is rejected');
  assert.equal(f.store.conversation(f.c.id).status, 'paused');
  assert.equal(f.store.conversation(f.c.id).used_runs, 0);
  assert.equal(f.store.conversation(f.c.id).context_used_bytes, reserved);
  assert.ok((discussionEntries(f)[0] as any).content.endsWith(body));
  assert.equal(f.store.messages(f.c.id)[0].id, message.id);
  assert.equal(f.store.messages(f.c.id)[0].content, body);
  assert.equal((f.bridge.metrics() as any).wake_start_requests, 0);
  f.store.control(f.c.id, 'resume', 0, 20, undefined, null);
  await f.client.tick();
  assert.equal(f.native.prompts, 1);
  assert.equal(discussionEntries(f).length, 1);
});

test('extension registers supported native lifecycle hooks and only Noah-scoped tools', () => {
  const hooks: string[] = [], commands: string[] = [], tools: string[] = [];
  noahPi({ on: (name: string) => { hooks.push(name); }, registerCommand: (name: string) => { commands.push(name); }, registerTool: (tool: any) => { tools.push(tool.name); } } as any);
  assert.ok(hooks.includes('session_before_switch') && hooks.includes('agent_settled') && hooks.includes('session_compact'));
  assert.deepEqual(commands, ['noah-connect', 'noah-disconnect']);
  assert.deepEqual(tools, ['noah_peers', 'noah_send', 'noah_read', 'noah_material', 'noah_request_human', 'noah_read_outcomes', 'noah_propose_outcome', 'noah_revise_outcome', 'noah_list_workspaces', 'noah_declare_work', 'noah_release_work']);
});
