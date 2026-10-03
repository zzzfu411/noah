import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai';
import { Store } from '../src/store.ts';
import { NativeBridge } from '../src/native-bridge.ts';
import { BridgeHttpError, PiBridgeClient, type BridgeTransport } from '../src/native-bridge-client.ts';

function broker(t: any) {
  const store = new Store(':memory:'); let now = Date.now();
  const bridge = new NativeBridge(store, { now: () => now });
  const transport: BridgeTransport = async (path, credential, body) => {
    const result = (await bridge.handle(path, 'POST', credential, body))!;
    if (result.status >= 400) throw new BridgeHttpError(result.status, result.body.error);
    return result.body;
  };
  t.after(() => store.close());
  return { store, bridge, transport, expire() { now += 31000; } };
}

test('real pi SDK settlement distinguishes aborted/error turns from a completed native wake', async t => {
  for (const stopReason of ['error', 'aborted', 'stop'] as const) {
    const f = broker(t), dir = mkdtempSync(join(tmpdir(), 'noah-native-outcome-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(dir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
    let providerCalls = 0, settledEvents = 0;
    runtime.registerProvider('local-outcome', {
      api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'local-only-fixture',
      models: [{ id: 'fixture', name: 'Fixture', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model) {
        providerCalls++;
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider,
          model: model.id, timestamp: Date.now(), stopReason,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (stopReason === 'stop') stream.push({ type: 'done', reason: stopReason, message });
        else stream.push({ type: 'error', reason: stopReason, error: message });
        stream.end(); return stream;
      },
    });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const manager = SessionManager.inMemory(dir), originalId = manager.getSessionId();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
      model: runtime.getModel('local-outcome', 'fixture'), settingsManager, resourceLoader: loader, sessionManager: manager, tools: [] });
    const submissions: Promise<void>[] = [];
    const client = new PiBridgeClient({ nativeSessionId: () => manager.getSessionId(), projectDir: () => dir,
      label: () => 'Native outcome fixture', isIdle: () => session.isIdle, hasPendingMessages: () => false,
      entries: () => manager.getEntries(), contextEntries: () => manager.buildContextEntries(), notify() {},
      sendMessage(message, options) { submissions.push(session.sendCustomMessage(message, options)); },
    }, f.transport);
    session.subscribe(event => { if (event.type === 'agent_settled') settledEvents++; });
    try {
      await client.connect(f.bridge.issueJoinToken().joinToken, { poll: false });
      const c = f.store.create('Native outcome', undefined, undefined, undefined, false,
        [{ id: 'original', harness: 'pi', mode: 'external', bindingId: client.bindingId }]);
      f.store.send(c.id, 'human', 'original', 'Only a fully finished native turn may report completion.', 'question');
      await client.tick(); await Promise.all(submissions);
      assert.equal(settledEvents, 1, 'pi emits settled even after error or abort');
      await client.agentSettled(); await client.tick();
      const expected = stopReason === 'stop' ? 'completed' : 'uncertain';
      assert.equal((f.bridge.wakes()[0] as any).state, expected, stopReason);
      assert.equal((f.store.db.prepare('SELECT state FROM deliveries').get() as any).state, expected, stopReason);
      assert.equal(providerCalls, 1, 'failed or uncertain native work is not replayed');
      assert.equal(manager.getSessionId(), originalId);
    } finally { await client.disconnect(); await session.abort(); session.dispose(); }
  }
});

test('pi losing a native connection marks both the in-flight wake and delivery uncertain', async t => {
  for (const loss of ['expired', 'revoked', 'restarted', 'closed', 'paused'] as const) {
    const f = broker(t), manager = SessionManager.inMemory('/work');
    let busy = false;
    const client = new PiBridgeClient({ nativeSessionId: () => manager.getSessionId(), projectDir: () => '/work',
      label: () => 'Connection-loss fixture', isIdle: () => !busy, hasPendingMessages: () => false,
      entries: () => manager.getEntries(), contextEntries: () => manager.buildContextEntries(), notify() {},
      sendMessage(message, options) { manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); busy ||= options.triggerTurn; },
    }, f.transport);
    try {
      await client.connect(f.bridge.issueJoinToken().joinToken, { poll: false });
      const c = f.store.create('Connection loss', undefined, undefined, undefined, false,
        [{ id: 'original', harness: 'pi', mode: 'external', bindingId: client.bindingId }]);
      f.store.send(c.id, 'human', 'original', 'Keep the actual delivery state visible after connection loss.', 'question');
      await client.tick();
      assert.equal((f.bridge.wakes()[0] as any).state, 'starting');
      if (loss === 'expired') { f.expire(); f.bridge.list(); }
      if (loss === 'revoked') f.bridge.revoke(client.bindingId);
      if (loss === 'restarted') new NativeBridge(f.store);
      if (loss === 'closed') f.bridge.close();
      if (loss === 'paused') await client.pause();
      assert.equal((f.bridge.wakes()[0] as any).state, 'uncertain', loss);
      assert.equal((f.store.db.prepare('SELECT state FROM deliveries').get() as any).state, 'uncertain', loss);
      const wake = f.bridge.wakes()[0] as any;
      f.bridge.resolveWake(wake.id);
      assert.equal((f.store.db.prepare('SELECT state FROM deliveries').get() as any).state, 'cancelled');
      assert.equal(f.store.messages(c.id).length, 1, 'owner resolution preserves full discussion history');
    } finally { await client.disconnect(); }
  }
});

test('an old successful assistant message cannot complete a wake with no new terminal evidence', async t => {
  const f = broker(t), manager = SessionManager.inMemory('/work');
  manager.appendMessage({ role: 'assistant', content: [], api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const client = new PiBridgeClient({ nativeSessionId: () => manager.getSessionId(), projectDir: () => '/work',
    label: () => 'Missing terminal evidence', isIdle: () => true, hasPendingMessages: () => false,
    entries: () => manager.getEntries(), contextEntries: () => manager.buildContextEntries(), notify() {},
    sendMessage(message) { manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
  }, f.transport);
  try {
    await client.connect(f.bridge.issueJoinToken().joinToken, { poll: false });
    const c = f.store.create('Missing terminal evidence', undefined, undefined, undefined, false,
      [{ id: 'original', harness: 'pi', mode: 'external', bindingId: client.bindingId }]);
    f.store.send(c.id, 'human', 'original', 'This wake has no new assistant completion.', 'question');
    await client.tick(); await client.agentSettled();
    assert.equal((f.bridge.wakes()[0] as any).state, 'uncertain');
    assert.equal((f.store.db.prepare('SELECT state FROM deliveries').get() as any).state, 'uncertain');
  } finally { await client.disconnect(); }
});
