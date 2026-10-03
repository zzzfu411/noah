import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, type Message } from '../src/store.ts';
import { diagnostics, exportDiscussion, messagePage, searchMessages } from '../src/queries.ts';

test('public-message search handles Chinese and literal SQL wildcard characters without searching private output', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = store.create('方舟方案讨论');
  const second = store.create('另一场讨论');
  const add = (id: string, body: string, key: string) => store.send(id, 'human', 'pi', body, key);
  const chinese = add(first.id, '比较增量投递和上下文开销，保留完整讨论。', 'chinese');
  const percent = add(first.id, '字面路径 /tmp/a%_b\\c，完成率 50%。', 'literal');
  add(first.id, '普通路径 /tmp/axyb/c，完成率 500。', 'decoy');
  const other = add(second.id, '上下文开销也需要检查。', 'other');
  const work = store.queued().find(item => item.message_id === chinese.id)!;
  assert.ok(store.claim(work.id));
  store.output(work.id, 'PRIVATE_RUN_ONLY: 私有推理、sk-fixture-private-key、/private/native-session.jsonl');
  store.updateSession(first.id, 'pi', { native_file: '/private/native-session.jsonl', error: 'PRIVATE_SESSION_ERROR' });

  assert.deepEqual(searchMessages(store, '上下文').results.map(row => row.id), [other.id, chinese.id]);
  assert.deepEqual(searchMessages(store, '上下文', first.id).results.map(row => row.id), [chinese.id]);
  assert.equal(searchMessages(store, '上下文', first.id).results[0]!.conversation_title, first.title);
  for (const query of ['%', '_', '\\', 'a%_b\\c']) {
    assert.deepEqual(searchMessages(store, query).results.map(row => row.id), [percent.id], `literal query ${query}`);
  }
  for (const query of ['PRIVATE_RUN_ONLY', 'sk-fixture-private-key', 'native-session', 'PRIVATE_SESSION_ERROR', first.title]) {
    assert.deepEqual(searchMessages(store, query).results, [], `only explicit message bodies are searchable: ${query}`);
  }
  assert.throws(() => searchMessages(store, '   '));
  assert.throws(() => searchMessages(store, '文'.repeat(201)));
  assert.equal(searchMessages(store, ' 上下文 ').query, '上下文');
  const limited = searchMessages(store, '上下文', undefined, 1);
  assert.equal(limited.results.length, 1); assert.equal(limited.truncated, true);
  assert.equal('content' in limited.results[0]!, false, 'results are scoped excerpts rather than raw rows');
});

test('conversation history can page and locate more than 1000 messages across interleaved discussions', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const history = store.create('需要长期保留的讨论');
  const unrelated = store.create('交错讨论');
  const messages: Message[] = [];
  for (let index = 0; index < 1207; index++) {
    messages.push(store.send(history.id, 'human', 'pi', `历史消息 ${index}：完整正文`, `history-${index}`));
    if (index % 3 === 0) store.send(unrelated.id, 'human', 'grok', `另一场消息 ${index}`, `other-${index}`);
  }
  assert.ok(!(store.snapshot().messages as unknown as Message[]).some(message => message.id === messages[0]!.id), 'the recent state window is deliberately insufficient');

  let before: number | undefined;
  const recovered: Message[] = [];
  for (;;) {
    const page = messagePage(store, history.id, { before, limit: 127 });
    assert.equal(page.total, messages.length);
    assert.ok(page.messages.length <= 127);
    assert.ok(page.messages.every(message => message.conversation_id === history.id));
    assert.ok(page.messages.every((message, index, pageMessages) => !index || pageMessages[index - 1]!.seq < message.seq));
    if (before !== undefined) assert.ok(page.messages.every(message => message.seq < before!));
    recovered.unshift(...page.messages);
    if (!page.hasOlder) break;
    assert.ok(page.before !== null && page.before !== before, 'the pagination cursor makes progress');
    before = page.before!;
  }
  assert.deepEqual(recovered.map(message => message.id), messages.map(message => message.id));
  assert.equal(new Set(recovered.map(message => message.id)).size, messages.length);

  const old = messages[101]!;
  const located = messagePage(store, history.id, { around: old.seq, limit: 20 });
  assert.ok(located.messages.some(message => message.id === old.id));
  assert.equal(located.hasOlder, true); assert.equal(located.hasNewer, true);
  assert.equal(located.total, messages.length);
  const foreign = store.messages(unrelated.id)[0]!;
  assert.throws(() => messagePage(store, history.id, { around: foreign.seq }), /不属于/);
  assert.throws(() => messagePage(store, history.id, { around: Number.MAX_SAFE_INTEGER }), /不属于/);
  const empty = store.create('空讨论');
  assert.deepEqual(messagePage(store, empty.id), { messages: [], total: 0, hasOlder: false, hasNewer: false, before: null });
});

test('portable export preserves the full shared record and omits private runs, native paths, errors and credentials', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const discussion = store.create('两位 pi 的公开讨论', undefined, undefined, 'fixture-model', false, [
    { id: 'pi-author', harness: 'pi', label: '作者' },
    { id: 'pi-reviewer', harness: 'pi', label: '审阅者' },
  ]);
  const question = store.send(discussion.id, 'human', 'pi-author', '请核对公开材料。', 'private-client-id');
  const response = store.send(discussion.id, 'pi-author', 'pi-reviewer', '公开结论，请检查。', 'another-client-id', question.id);
  const artifact = store.addMaterial(discussion.id, '已共享.txt', '明确分享的资料全文，不能在导出时遗漏。');
  const work = store.queued().find(item => item.message_id === question.id && item.agent === 'pi-author')!;
  assert.ok(store.claim(work.id));
  store.output(work.id, 'PRIVATE_RUN_OUTPUT sk-private-export-test');
  store.usage(work.id, { privateMetadata: 'PRIVATE_USAGE_METADATA' });
  store.delivery(work.id, 'failed', 'PRIVATE_DELIVERY_ERROR /private/native-session.jsonl');
  store.updateSession(discussion.id, 'pi-author', {
    native_id: 'PRIVATE_NATIVE_ID', native_file: '/private/native-session.jsonl',
    error: 'PRIVATE_SESSION_ERROR', capabilities: JSON.stringify({ token: 'PRIVATE_CAPABILITY_KEY' }),
  });
  store.pause(discussion.id, 'PRIVATE_RECOVERY_REASON /private/native-session.jsonl');
  const other = store.create('无关讨论');
  store.send(other.id, 'human', 'grok', 'UNRELATED_MESSAGE', 'unrelated');
  store.addMaterial(other.id, 'private.txt', 'UNRELATED_MATERIAL');

  const exported = exportDiscussion(store, discussion.id);
  assert.equal(exported.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
  assert.deepEqual(exported.participants, [
    { id: 'pi-author', harness: 'pi', label: '作者', mode: 'managed' },
    { id: 'pi-reviewer', harness: 'pi', label: '审阅者', mode: 'managed' },
  ]);
  assert.deepEqual(exported.messages.map(message => message.id), [question.id, response.id]);
  assert.equal(exported.messages[1]!.in_reply_to, question.id);
  assert.ok(exported.deliveries.some(delivery => delivery.message_id === question.id && delivery.participant_id === 'pi-author'));
  assert.equal((exported.materials[0] as any).id, artifact.id);
  assert.equal((exported.materials[0] as any).content, '明确分享的资料全文，不能在导出时遗漏。');
  const serialized = JSON.stringify(exported);
  for (const privateValue of ['PRIVATE_', 'sk-private-export-test', '/private/native-session.jsonl', 'private-client-id', 'another-client-id', 'UNRELATED_']) {
    assert.equal(serialized.includes(privateValue), false, `portable export does not include ${privateValue}`);
  }
});

test('diagnostics identifies uncertain work without changing paused tasks or revealing private output', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const discussion = store.create('需要人工核对', 2, 15);
  const message = store.send(discussion.id, 'human', 'grok', '请处理', 'diagnostic-message');
  const work = store.queued().find(item => item.message_id === message.id)!;
  assert.ok(store.claim(work.id));
  store.output(work.id, 'PRIVATE_DIAGNOSTIC_OUTPUT');
  store.delivery(work.id, 'uncertain', 'PRIVATE_DIAGNOSTIC_ERROR');
  store.pause(discussion.id, 'Owner paused');
  const before = JSON.stringify(store.snapshot());
  const report = diagnostics(store);
  assert.equal(report.database, 'ok'); assert.equal(report.inferenceStarted, false);
  assert.equal(report.unresolved.length, 1);
  assert.equal((report.unresolved[0] as any).conversation_id, discussion.id);
  assert.equal((report.unresolved[0] as any).id, work.id);
  assert.equal(JSON.stringify(report).includes('PRIVATE_DIAGNOSTIC_'), false);
  assert.equal(JSON.stringify(store.snapshot()), before, 'diagnostics is a read and must not resume or resolve work');
});
