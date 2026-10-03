/**
 * Two bounded end-to-end checks using the real pi SDK and Noah extension.
 * All models, credentials, projects, histories and broker data are fixtures.
 * This is not a TUI interaction or a real-model quality test.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { startServer } from '../src/server.ts';
import { Engine } from '../src/engine.ts';
import { NOAH_DISCUSSION_TYPE } from '../src/native-bridge-client.ts';

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function stop(server: Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function until(description: string, check: () => boolean | Promise<boolean>, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(75); }
  throw new Error(`Timed out: ${description}`);
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'noah-pi-native-e2e-'));
  const project = join(directory, 'project'), agentDir = join(directory, 'agent');
  mkdirSync(project); mkdirSync(agentDir);
  const privateHistory = `PRIVATE_HISTORY_${randomUUID()}`;
  const privateToolOutput = `PRIVATE_TOOL_OUTPUT_${randomUUID()}`;
  writeFileSync(join(project, 'original-work.txt'), privateToolOutput + '\n', { mode: 0o600 });
  const bridgeRequests: unknown[] = [], modelRequests: any[] = [], extensionErrors: string[] = [];
  let app: Awaited<ReturnType<typeof startServer>> | undefined, session: AgentSession | undefined;
  let modelServer: Server | undefined, bridgeProxy: Server | undefined;
  let discussionId = '', originalNativeId = '', originalFile = '';
  let nativeStarts = 0, managedStarts = 0, readExecuted = false, sendExecuted = false;
  let report: Record<string, unknown> | undefined;
  const publicResult = '原工作会话保留；公开资料已完整收到。此条为显式提交给 owner 的验证结果。';

  try {
    modelServer = createServer(async (req, res) => {
      try {
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        modelRequests.push(input);
        assert.ok(modelRequests.length <= 2, 'only tool planning and final completion are expected');
        assert.equal(input.model, 'fixture-model'); assert.equal(input.stream, true);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const envelope = { id: 'fixture-' + modelRequests.length, object: 'chat.completion.chunk', created: 1, model: 'fixture-model' };
        const event = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (modelRequests.length === 1) {
          event({ role: 'assistant', content: null, tool_calls: [
            { index: 0, id: 'call-original-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(project, 'original-work.txt') }) } },
            { index: 1, id: 'call-noah-send', type: 'function', function: { name: 'noah_send', arguments: JSON.stringify({ conversationId: discussionId, recipient: 'human', content: publicResult, clientKey: 'native-e2e-public-result' }) } },
          ] });
          event({}, 'tool_calls');
        } else {
          event({ role: 'assistant', content: '本轮原生处理结束。私有文件内容不发布到 Noah。' });
          event({}, 'stop');
        }
        res.end('data: [DONE]\n\n');
      } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }
    });
    const modelUrl = await listen(modelServer);
    app = await startServer({ dataDir: join(directory, 'noah'), port: 0, modelCheck: false,
      discovery: () => ({ schemaVersion: 1, harnesses: [], inspection: {
        filesystemOnly: true, executablesLaunched: false, configurationContentsRead: false, sessionsInspected: false,
      } }),
      engineFactory: (store, dataDir) => new Engine(store, dataDir, () => {
        managedStarts++; throw new Error('This verification must never create a managed harness');
      }),
    });
    const owner = async (path: string, payload?: unknown) => {
      const response = await fetch(app!.url + path, { method: payload === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app!.token}` },
        body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
      const value = await response.json() as any;
      assert.ok(response.ok, JSON.stringify(value)); return value;
    };
    // The proxy records only bridge bodies in memory, so the privacy boundary is
    // checked at the real HTTP transport rather than inferred from UI state.
    bridgeProxy = createServer(async (req, res) => {
      try {
        assert.ok(req.url?.startsWith('/api/bridge/'));
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        bridgeRequests.push({ path: req.url, body: JSON.parse(body) });
        const response = await fetch(app!.url + req.url, { method: 'POST', body,
          headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
          signal: AbortSignal.timeout(5000) });
        res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
      } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }
    });
    const proxyUrl = await listen(bridgeProxy);
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(agentDir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider('noah-local-verification', { api: 'openai-completions', baseUrl: modelUrl + '/v1', apiKey: 'local-fixture-not-a-real-key',
      models: [{ id: 'fixture-model', name: 'Local deterministic verification', input: ['text'], contextWindow: 64000,
        maxTokens: 2048, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
    const loader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager,
      additionalExtensionPaths: [fileURLToPath(new URL('../extensions/noah-pi.ts', import.meta.url))],
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.create(project, join(agentDir, 'sessions'));
    manager.appendMessage({ role: 'user', content: privateHistory, timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Existing private work is in progress.' }],
      api: 'openai-completions', provider: 'noah-local-verification', model: 'fixture-model', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    originalNativeId = manager.getSessionId(); originalFile = manager.getSessionFile()!;
    assert.ok(readFileSync(originalFile, 'utf8').includes(privateHistory));
    ({ session } = await createAgentSession({ cwd: project, agentDir, modelRuntime: runtime, model: runtime.getModel('noah-local-verification', 'fixture-model'),
      settingsManager, resourceLoader: loader, sessionManager: manager,
      tools: ['read', 'noah_peers', 'noah_send', 'noah_read', 'noah_material', 'noah_request_human'] }));
    session.subscribe(event => {
      if (event.type === 'agent_start') nativeStarts++;
      if (event.type === 'tool_execution_end' && !event.isError) {
        if (event.toolName === 'read') readExecuted = true;
        if (event.toolName === 'noah_send') sendExecuted = true;
      }
    });
    await session.bindExtensions({ mode: 'print', onError: error => { extensionErrors.push(error.error); } });
    const originalTools = session.getActiveToolNames().sort(), originalModel = JSON.stringify(session.model);
    assert.ok(originalTools.includes('read')); assert.ok(!originalTools.includes('bash')); assert.ok(!originalTools.includes('write'));
    const grant = await owner('/api/bridge-grants', {});
    const grantContent = JSON.parse(readFileSync(grant.grantPath, 'utf8'));
    const privateGrant = join(directory, 'join-grant.json');
    writeFileSync(privateGrant, JSON.stringify({ ...grantContent, url: proxyUrl }), { mode: 0o600 });
    await session.prompt(`/noah-connect ${privateGrant}`);
    const binding = (await owner('/api/native-sessions')).sessions.find((item: any) => item.nativeSessionId === originalNativeId);
    assert.ok(binding, 'the real extension command must register the original session');

    // A restricted peer API fixture supplies public messages; it is deliberately
    // not represented as another running harness or a second model integration.
    const peerGrant = app.bridge.issueJoinToken({ projectDir: project });
    const peerResponse = await fetch(app.url + '/api/bridge/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ joinToken: peerGrant.joinToken, nativeSessionId: 'peer-api-fixture', runtimeId: 'peer-api-fixture-runtime',
        projectDir: project, label: 'Public peer API fixture', idle: true, capabilities: 'pi-extension-v1' }) });
    assert.equal(peerResponse.status, 201); const peer = await peerResponse.json() as any;
    const discussion = await owner('/api/conversations', { title: 'Isolated original pi verification', participants: [
      { id: 'native-pi', harness: 'pi', mode: 'external', bindingId: binding.id, label: 'Existing native pi fixture' },
      { id: 'peer-fixture', harness: 'pi', mode: 'external', bindingId: peer.bindingId, label: 'Public peer API fixture' },
    ] });
    discussionId = discussion.id;
    const passiveBody = '完整公开背景第一行\n第二行有 Unicode、代码与引用：`native/session`\n' + 'Full body remains unchanged. '.repeat(80);
    const passiveResponse = await fetch(app.url + '/api/bridge/tool', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${peer.credential}` },
      body: JSON.stringify({ generation: peer.generation, name: 'noah_send', args: { conversationId: discussionId, recipient: 'human', content: passiveBody, clientKey: 'passive-full-body' } }) });
    assert.equal(passiveResponse.status, 200, await passiveResponse.clone().text());
    const originalEntries = () => manager.getEntries().filter(entry => entry.type === 'custom_message' && entry.customType === NOAH_DISCUSSION_TYPE);
    await until('passive full body observed', () => originalEntries().some((entry: any) => entry.content.endsWith(passiveBody)));
    assert.equal(modelRequests.length, 0); assert.equal(nativeStarts, 0);
    assert.equal(manager.getSessionId(), originalNativeId); assert.equal(session.sessionManager, manager);
    assert.equal(JSON.stringify(bridgeRequests).includes(privateHistory), false);

    const questionA = '请在原工作会话继续，读取原有测试资料，并只把显式结论发给 owner。';
    const questionB = '补充：公开正文应完整保留，私有工作历史和 read 输出不可发布。';
    // Pause dispatch while entering the two messages, then explicitly resume so
    // the batching assertion does not depend on a 1.5-second polling race.
    await owner(`/api/conversations/${discussionId}/control`, { action: 'pause' });
    await owner(`/api/conversations/${discussionId}/messages`, { recipient: 'native-pi', content: questionA, clientKey: 'directed-a' });
    await owner(`/api/conversations/${discussionId}/messages`, { recipient: 'native-pi', content: questionB, clientKey: 'directed-b' });
    await owner(`/api/conversations/${discussionId}/control`, { action: 'resume' });
    await until('native wake completed and owner result returned', async () => {
      const state = await owner('/api/state');
      return state.messages.some((message: any) => message.sender === 'native-pi' && message.recipient === 'human' && message.content === publicResult) &&
        state.nativeWakes.some((wake: any) => wake.conversation_id === discussionId && wake.state === 'completed');
    }, 18000);
    await delay(1750); // One additional real bridge poll proves no duplicate wake.
    const finalState = await owner('/api/state');
    assert.deepEqual(extensionErrors, []);
    assert.equal(nativeStarts, 1); assert.equal(modelRequests.length, 2); assert.equal(managedStarts, 0);
    assert.equal(readExecuted, true); assert.equal(sendExecuted, true);
    assert.equal(manager.getSessionId(), originalNativeId); assert.equal(manager.getSessionFile(), originalFile);
    assert.equal(JSON.parse(readFileSync(originalFile, 'utf8').split('\n')[0]!).id, originalNativeId);
    assert.deepEqual(session.getActiveToolNames().sort(), originalTools); assert.equal(JSON.stringify(session.model), originalModel);
    for (const content of [passiveBody, questionA, questionB]) {
      assert.equal(originalEntries().filter((entry: any) => entry.content.endsWith(content)).length, 1);
      assert.ok(JSON.stringify(modelRequests[0]).includes(content.replace(/\n/g, '\\n')) || JSON.stringify(modelRequests[0]).includes(JSON.stringify(content).slice(1, -1)));
    }
    assert.ok(JSON.stringify(modelRequests[0]).includes(privateHistory), 'existing native context remains with its own model');
    assert.ok(JSON.stringify(modelRequests[1]).includes(privateToolOutput), 'the original read tool really executed');
    for (const marker of [privateHistory, privateToolOutput]) {
      assert.equal(JSON.stringify(bridgeRequests).includes(marker), false, 'private data must not enter Noah bridge requests');
      assert.equal(JSON.stringify(finalState).includes(marker), false, 'private data must not enter owner-visible state');
    }
    report = { verifiedAt: new Date().toISOString(), evidenceLevel: 'real-pi-sdk-and-extension-with-local-http-model',
      tuiVerified: false, realModelQualityVerified: false, externalModelRequests: 0,
      nativeSessionIdPreserved: true, nativeSessionFilePreserved: true, modelConfigurationPreserved: true, toolAllowlistPreserved: true,
      passive: { fullBodies: 1, nativeStarts: 0, modelHttpRequests: 0 },
      directed: { fullBodies: 2, nativeStarts, modelHttpRequests: modelRequests.length, originalReadExecuted: readExecuted, noahSendExecuted: sendExecuted, ownerReceivedExplicitResult: true },
      privateHistoryPublished: false, privateToolOutputPublished: false, additionalManagedHarnessesStarted: managedStarts,
      peerSource: 'restricted bridge API fixture, not a second running harness', cleanup: 'temporary fixture directories removed' };
  } finally {
    if (session) {
      await session.abort().catch(() => {});
      await session.prompt('/noah-disconnect').catch(() => {});
      session.dispose();
    }
    await stop(bridgeProxy);
    await app?.close();
    await stop(modelServer);
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
