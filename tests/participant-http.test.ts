import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.ts';
import { Engine } from '../src/engine.ts';

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'noah-participant-http-'));
  let prompts = 0;
  const app = await startServer({ dataDir: dir, port: 0, modelCheck: false,
    discovery: () => ({ schemaVersion: 1, harnesses: [], inspection: {
      filesystemOnly: true, executablesLaunched: false, configurationContentsRead: false, sessionsInspected: false,
    } }),
    engineFactory: (store, dataDir) => new Engine(store, dataDir, () => ({
      start: async () => ({ nativeId: 'isolated-http-fixture', capabilities: {} }),
      prompt: async () => { prompts++; }, cancel: async () => {}, close: async () => {},
    })),
  });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = (path: string, payload?: unknown, credential: string | null = app.token, headers: Record<string, string> = {}) => fetch(app.url + path, {
    method: payload === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...headers,
    }, body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const create = async (payload: unknown) => {
    const response = await request('/api/conversations', payload);
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as any;
  };
  const register = async (suffix: string) => {
    const issued = await request('/api/bridge-grants', {});
    assert.equal(issued.status, 201);
    const grant = await issued.json() as any;
    assert.equal(statSync(grant.grantPath).mode & 0o777, 0o600);
    assert.equal('joinToken' in grant, false, 'the owner UI gets a grant file path, not the bearer secret');
    const saved = JSON.parse(readFileSync(grant.grantPath, 'utf8'));
    assert.equal(saved.url, app.url);
    const metadata = { nativeSessionId: `native-${suffix}`, runtimeId: `runtime-${suffix}`, projectDir: join(dir, suffix), label: `原会话 ${suffix}`, idle: true, capabilities: 'pi-extension-v1', joinToken: saved.joinToken };
    const response = await request('/api/bridge/register', metadata, null);
    assert.equal(response.status, 201, await response.clone().text());
    const binding = await response.json() as any;
    assert.equal((await request('/api/bridge/register', metadata, null)).status, 401, 'join grants are one-use');
    return { ...binding, joinToken: saved.joinToken };
  };
  return { app, request, create, register, promptCount: () => prompts };
}

test('owner API creates separate same-harness participants and validates recipients within their discussion', async t => {
  const { app, request, create, promptCount } = await fixture(t);
  const discussion = await create({ title: '两个 pi 协作', participants: [
    { id: 'pi-writer', harness: 'pi', label: '作者' }, { id: 'pi-reviewer', harness: 'pi', label: '审阅者' },
  ] });
  await request(`/api/conversations/${discussion.id}/control`, { action: 'pause' });
  const state = await (await request('/api/state')).json() as any;
  assert.deepEqual(state.sessions.filter((session: any) => session.conversation_id === discussion.id).map((session: any) => [session.agent, session.harness, session.label]), [
    ['pi-writer', 'pi', '作者'], ['pi-reviewer', 'pi', '审阅者'],
  ]);
  const path = `/api/conversations/${discussion.id}/messages`;
  const payload = { recipient: 'pi-reviewer', content: '只请审阅者回应，其他成员仍可看到公开讨论。', clientKey: 'review-request' };
  const first = await request(path, payload); assert.equal(first.status, 201);
  const message = await first.json() as any;
  const retried = await request(path, payload); assert.equal(retried.status, 201);
  assert.equal((await retried.json() as any).id, message.id);
  assert.equal(app.store.messages(discussion.id).length, 1);
  const deliveries = app.store.db.prepare('SELECT agent,wake FROM deliveries WHERE message_id=? ORDER BY agent').all(message.id) as any[];
  assert.deepEqual(deliveries.map(delivery => [delivery.agent, delivery.wake]), [['pi-reviewer', 1], ['pi-writer', 0]]);
  for (const recipient of ['pi', 'grok', 'foreign-member', 'human']) {
    assert.equal((await request(path, { ...payload, recipient, clientKey: recipient })).status, 400);
  }
  assert.equal((await request(path, { ...payload, sender: 'pi-writer' })).status, 400, 'an owner message cannot forge its author');
  assert.equal((await request(path, { ...payload, content: 'different message with same key' })).status, 400);
  assert.equal((await request(path, { recipient: 'all', content: '所有成员可以回答', clientKey: 'all' })).status, 201);
  const other = await create({ title: '外部引用目标', participants: [{ id: 'elsewhere', harness: 'pi' }] });
  app.store.pause(other.id, 'Test paused');
  const foreign = app.store.send(other.id, 'human', 'elsewhere', '另一个讨论的消息', 'foreign');
  assert.equal((await request(path, { ...payload, clientKey: 'bad-reply', inReplyTo: foreign.id })).status, 400);
  for (const participants of [
    [{ id: 'same', harness: 'pi' }, { id: 'same', harness: 'pi' }],
    [{ id: 'human', harness: 'pi' }], [{ id: 'all', harness: 'pi' }], [],
    [{ id: 'native', harness: 'pi', mode: 'external', bindingId: 'unknown-binding' }],
  ]) assert.equal((await request('/api/conversations', { title: 'invalid', participants })).status, 400);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(promptCount(), 0, 'member selection, paused sends and validation do not call a model');
});

test('owner queries keep literal Chinese search, old-message location and portable export available beyond the state window', async t => {
  const { app, request, create, promptCount } = await fixture(t);
  const discussion = await create({ title: '长讨论', participants: [{ id: 'pi-reader', harness: 'pi' }] });
  app.store.pause(discussion.id, 'Test paused');
  const old = app.store.send(discussion.id, 'human', 'pi-reader', '最早的中文消息：字面 %_\\ 路径。', 'first');
  for (let index = 0; index < 1010; index++) app.store.send(discussion.id, 'human', 'pi-reader', `后续消息 ${index}`, `later-${index}`);
  const query = await request(`/api/search?q=${encodeURIComponent('%_\\')}&conversationId=${discussion.id}`);
  assert.equal(query.status, 200);
  assert.deepEqual((await query.json() as any).results.map((result: any) => result.id), [old.id]);
  const located = await request(`/api/conversations/${discussion.id}/messages?around=${old.seq}&limit=20`);
  assert.equal(located.status, 200);
  const page = await located.json() as any;
  assert.equal(page.total, 1011); assert.ok(page.messages.some((message: any) => message.id === old.id));
  assert.equal(page.hasOlder, false); assert.equal(page.hasNewer, true);
  const older = await request(`/api/conversations/${discussion.id}/messages?before=${old.seq}&limit=20`);
  assert.deepEqual((await older.json() as any).messages, []);
  for (const path of [
    '/api/search?q=%20%20', '/api/search?q=x&unknown=1',
    `/api/conversations/${discussion.id}/messages?limit=201`,
    `/api/conversations/${discussion.id}/messages?before=0`,
    `/api/conversations/${discussion.id}/messages?around=1.5`,
    `/api/conversations/${discussion.id}/messages?before=2&around=${old.seq}`,
  ]) assert.equal((await request(path)).status, 400);
  app.store.updateSession(discussion.id, 'pi-reader', { native_file: '/private/http-native.jsonl', capabilities: JSON.stringify({ key: 'PRIVATE_HTTP_CREDENTIAL' }) });
  app.store.addMaterial(discussion.id, '共享资料.txt', '显式分享的资料');
  const exportedResponse = await request(`/api/conversations/${discussion.id}/export?format=json`);
  assert.equal(exportedResponse.status, 200);
  assert.match(exportedResponse.headers.get('content-disposition')!, /noah-discussion\.json/);
  const exported = await exportedResponse.json() as any;
  assert.equal(exported.messages.length, 1011); assert.equal(exported.messages[0].id, old.id);
  assert.equal(exported.materials[0].content, '显式分享的资料');
  assert.equal(JSON.stringify(exported).includes('/private/http-native.jsonl'), false);
  assert.equal(JSON.stringify(exported).includes('PRIVATE_HTTP_CREDENTIAL'), false);
  const markdown = await request(`/api/conversations/${discussion.id}/export`);
  assert.equal(markdown.status, 200); assert.match(await markdown.text(), /最早的中文消息/);
  const before = JSON.stringify(app.store.snapshot());
  const diagnostic = await request('/api/diagnostics'); assert.equal(diagnostic.status, 200);
  assert.equal((await diagnostic.json() as any).inferenceStarted, false);
  assert.equal(JSON.stringify(app.store.snapshot()), before);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(promptCount(), 0);
});

test('owner, one-use join grant and native bridge credentials stay in separate authority scopes', async t => {
  const { app, request, create, register } = await fixture(t);
  const native = await register('alice');
  const own = await create({ title: '已加入的讨论', participants: [{ id: 'alice', harness: 'pi', mode: 'external', bindingId: native.bindingId }] });
  const other = await create({ title: '未加入的讨论', participants: [{ id: 'unrelated', harness: 'pi' }] });
  app.store.pause(other.id, 'Test paused');
  app.store.send(other.id, 'human', 'unrelated', 'UNRELATED_PRIVATE_DISCUSSION', 'unrelated');
  const material = app.store.addMaterial(other.id, 'not-shared-with-alice.txt', 'UNRELATED_PRIVATE_MATERIAL');
  const deniedReads = ['/api/state', '/api/native-sessions', '/api/diagnostics', '/api/search?q=UNRELATED',
    `/api/conversations/${other.id}/messages`, `/api/conversations/${other.id}/export?format=json`,
    `/api/conversations/${other.id}/materials/${material.id}?offset=0`];
  for (const credential of [null, 'invalid-token', native.joinToken, native.credential]) {
    for (const path of deniedReads) {
      const response = await request(path, undefined, credential);
      assert.equal(response.status, 401, `${path} rejects non-owner credentials`);
      assert.equal((await response.text()).includes('UNRELATED_PRIVATE_'), false);
    }
    for (const [path, body] of [
      ['/api/bridge-grants', {}], ['/api/conversations', { title: 'unauthorized' }],
      [`/api/native-sessions/${native.bindingId}/revoke`, {}],
      [`/api/conversations/${own.id}/messages`, { recipient: 'alice', content: 'forged owner', clientKey: 'forged' }],
    ] as const) assert.equal((await request(path, body, credential)).status, 401);
  }
  const bridgeRequest = (name: string, args: unknown) => request('/api/bridge/tool', { generation: native.generation, name, args }, native.credential);
  for (const credential of [null, app.token, native.joinToken]) {
    assert.equal((await request('/api/bridge/tool', { generation: native.generation, name: 'noah_peers', args: {} }, credential)).status, 401);
  }
  const peers = await bridgeRequest('noah_peers', {}); assert.equal(peers.status, 200);
  assert.deepEqual((await peers.json() as any[]).map(row => [row.conversationId, row.self]), [[own.id, 'alice']]);
  assert.equal((await bridgeRequest('noah_read', { conversationId: other.id })).status, 403);
  assert.equal((await bridgeRequest('noah_material', { conversationId: other.id, id: material.id })).status, 403);
  assert.equal((await bridgeRequest('noah_send', { conversationId: other.id, recipient: 'unrelated', content: 'cross-discussion', clientKey: 'cross' })).status, 403);
  assert.equal((await bridgeRequest('noah_send', { conversationId: own.id, sender: 'human', recipient: 'human', content: 'forged author', clientKey: 'forged-author' })).status, 400);
  const reply = await bridgeRequest('noah_send', { conversationId: own.id, recipient: 'human', content: '原会话公开回复', clientKey: 'native-reply' });
  assert.equal(reply.status, 200); assert.equal((await reply.json() as any).sender, 'alice');
  const sessionsResponse = await request('/api/native-sessions'); assert.equal(sessionsResponse.status, 200);
  const sessionText = await sessionsResponse.text();
  assert.equal(sessionText.includes(native.credential), false); assert.equal(sessionText.includes(native.joinToken), false);
  assert.equal((await request('/api/bridge/tool', { generation: native.generation + 1, name: 'noah_peers', args: {} }, native.credential)).status, 409);
  const crossOrigin = await request('/api/bridge/tool', { generation: native.generation, name: 'noah_peers', args: {} }, native.credential, { Origin: 'https://untrusted.invalid' });
  assert.equal(crossOrigin.status, 403);
  const revoked = await request(`/api/native-sessions/${native.bindingId}/revoke`, {}); assert.equal(revoked.status, 200);
  assert.equal((await bridgeRequest('noah_peers', {})).status, 401);
  assert.equal((await request('/api/conversations', { title: 'revoked', participants: [{ id: 'revoked', harness: 'pi', mode: 'external', bindingId: native.bindingId }] })).status, 400);
});

test('owner material previews page by the supplied offset and cannot cross discussion scopes', async t => {
  const { app, request, create, promptCount } = await fixture(t);
  const discussion = await create({ title: '共享材料', participants: [{ id: 'reader', harness: 'pi' }] });
  const other = await create({ title: '其他资料', participants: [{ id: 'other-reader', harness: 'pi' }] });
  app.store.pause(discussion.id, 'Test paused'); app.store.pause(other.id, 'Test paused');
  const content = '汉'.repeat(16000) + '乙'.repeat(16000) + '最后一段';
  const material = app.store.addMaterial(discussion.id, 'long-shared.md', content);
  const foreign = app.store.addMaterial(other.id, 'other-private.md', 'UNRELATED_MATERIAL_PREVIEW');
  const path = `/api/conversations/${discussion.id}/materials/${material.id}`;
  let recovered = '', offset: number | null = 0;
  const seenOffsets: number[] = [];
  while (offset !== null) {
    seenOffsets.push(offset);
    const response = await request(`${path}?offset=${offset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.json() as any;
    assert.equal(page.id, material.id); assert.equal(page.sha256, material.sha256);
    assert.ok(page.content.length <= 16000);
    recovered += page.content;
    assert.ok(page.nextOffset === null || page.nextOffset > offset, 'material pagination makes progress');
    offset = page.nextOffset;
  }
  assert.deepEqual(seenOffsets, [0, 16000, 32000]);
  assert.equal(recovered, content);
  const crossed = await request(`/api/conversations/${discussion.id}/materials/${foreign.id}?offset=0`);
  assert.equal(crossed.status, 400); assert.equal((await crossed.text()).includes('UNRELATED_MATERIAL_PREVIEW'), false);
  for (const query of ['offset=-1', 'offset=1.5', 'offset=nan', 'offset=0&unknown=value']) {
    assert.equal((await request(`${path}?${query}`)).status, 400);
  }
  for (const credential of [null, 'invalid-owner']) {
    const denied = await request(path, undefined, credential);
    assert.equal(denied.status, 401); assert.equal((await denied.text()).includes('最后一段'), false);
  }
  assert.equal((await request(path, undefined, app.token, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal(promptCount(), 0, 'previewing shared files never dispatches inference');
});
