import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import type { AdapterOptions } from '../src/adapters.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

async function until(predicate: () => boolean, timeout = 2500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function fixture(t: any, run: (o: AdapterOptions, input: string) => Promise<void>) {
  const store = new Store(':memory:');
  let starts = 0;
  const engine = new Engine(store, '/tmp/noah-mock', o => ({
    start: async () => ({ nativeId: `native-${o.agent}`, capabilities: {} }),
    prompt: async input => { starts++; o.events.accepted(); await run(o, input); },
    cancel: async () => {}, close: async () => {},
  }));
  engine.url = 'http://127.0.0.1:1';
  t.after(async () => { await engine.close(); store.close(); });
  return { store, engine, starts: () => starts };
}

test('durable send is idempotent; conflicting retries and cross-task replies are rejected', t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  const a = s.create('A'), b = s.create('B');
  const first = s.send(a.id, 'human', 'grok', 'hello', 'retry-key');
  const event = s.snapshot().eventId;
  assert.equal(s.send(a.id, 'human', 'grok', 'hello', 'retry-key').id, first.id);
  assert.equal(s.snapshot().eventId, event);
  assert.equal(s.queued().length, 1);
  assert.throws(() => s.send(a.id, 'human', 'grok', 'changed', 'retry-key'), /conflict/);
  assert.throws(() => s.send(b.id, 'human', 'pi', 'reply', 'other', first.id), /outside/);
  assert.throws(() => s.send(a.id, 'grok', 'grok', 'self', 'self'), /Invalid/);
  assert.throws(() => s.send(a.id, 'human', 'pi', '中'.repeat(22000), 'large'), /UTF-8/);
});

test('claim serializes each session, spends a shared quota once, and respects pause/expiry', t => {
  const s = new Store(':memory:'); t.after(() => s.close()); const c = s.create('quota', 1);
  s.send(c.id, 'human', 'grok', 'one', 'one'); s.send(c.id, 'human', 'pi', 'two', 'two');
  const [a, b] = s.queued();
  assert.ok(s.claim(a.id)); assert.equal(s.claim(a.id), undefined); assert.equal(s.claim(b.id), undefined);
  assert.equal(s.conversation(c.id).used_runs, 1); assert.equal(s.conversation(c.id).status, 'paused');
  s.control(c.id, 'resume', 1); assert.ok(s.claim(b.id));
  const expired = s.create('expired', 12); s.send(expired.id, 'human', 'pi', 'later', 'expired');
  s.db.prepare('UPDATE conversations SET expires_at=0 WHERE id=?').run(expired.id);
  assert.equal(s.claim(s.queued()[0].id), undefined); assert.equal(s.conversation(expired.id).used_runs, 0);
});

test('autonomous peers continue beyond twelve starts and an expired legacy deadline, then stay idle', async t => {
  let engine: Engine;
  const inputs: string[] = [];
  const f = fixture(t, async (o, input) => {
    inputs.push(input);
    const turn = inputs.length;
    await engine.invoke(o.bridgeToken, 'noah_send', {
      recipient: turn < 16 ? (o.agent === 'grok' ? 'pi' : 'grok') : 'human',
      content: turn < 16 ? `Useful contribution ${turn}` : 'Discussion result',
    }, `turn-${turn}`);
  }); engine = f.engine;
  const c = f.store.create('autonomous peers');
  assert.equal(c.limits_enabled, 0);
  assert.equal(c.max_runs, 12, 'the stored compatibility value is not an active limit');
  f.store.db.prepare('UPDATE conversations SET expires_at=0 WHERE id=?').run(c.id);
  f.store.send(c.id, 'human', 'grok', 'Discuss together', 'start');
  await until(() => f.starts() === 16 && (f.store.snapshot().runs as any[]).every(r => r.status === 'completed'));
  assert.equal(f.store.conversation(c.id).used_runs, 16);
  assert.equal(f.store.conversation(c.id).status, 'active');
  assert.equal(f.store.queued().length, 0);
  assert.ok((f.store.snapshot().sessions as any[]).every(s => s.status === 'idle'));
  assert.deepEqual(f.store.messages(c.id).map(m => `${m.sender}>${m.recipient}`), [
    'human>grok', ...Array.from({ length: 15 }, (_, i) => i % 2 ? 'pi>grok' : 'grok>pi'), 'pi>human',
  ]);
  for (const input of inputs) {
    assert.match(input, /Autonomous collaboration: no task-level run or time limit/);
    assert.doesNotMatch(input, /Remaining Noah starts|Noah dispatch deadline/);
  }
  f.store.snapshot(); f.store.emit('change'); f.store.emit('output');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.starts(), 16, 'idle state and read events must not wake agents');
  f.store.send(c.id, 'human', 'pi', 'One new question', 'followup');
  await until(() => f.starts() === 17 && (f.store.snapshot().runs as any[]).every(r => r.status === 'completed'));
  assert.equal(f.store.conversation(c.id).status, 'active', 'a new message needs no manual resume after natural idling');
});

test('owner-enabled limits still stop dispatch before another harness is started', async t => {
  const store = new Store(':memory:'); let adapterStarts = 0, prompts = 0, input = '';
  const engine = new Engine(store, '/tmp/noah-bounded-mock', o => ({
    start: async () => { adapterStarts++; return { nativeId: `native-${o.agent}`, capabilities: {} }; },
    prompt: async value => {
      prompts++; input = value;
      await engine.invoke(o.bridgeToken, 'noah_send', { recipient: 'pi', content: 'Continue only if permitted' }, 'next');
    },
    cancel: async () => {}, close: async () => {},
  }));
  engine.url = 'http://127.0.0.1:1';
  t.after(async () => { await engine.close(); store.close(); });
  const capped = store.create('one start', 1);
  const expired = store.create('expired', undefined, 1);
  store.db.prepare('UPDATE conversations SET expires_at=0 WHERE id=?').run(expired.id);
  store.send(capped.id, 'human', 'grok', 'First contribution', 'first');
  store.send(expired.id, 'human', 'grok', 'Too late', 'late');
  await until(() => store.conversation(capped.id).status === 'paused' && store.conversation(expired.id).status === 'paused');
  assert.equal(prompts, 1); assert.equal(adapterStarts, 1);
  assert.equal(store.conversation(capped.id).used_runs, 1);
  assert.equal(store.conversation(expired.id).used_runs, 0);
  assert.match(input, /Remaining Noah starts: 0/);
  assert.match(input, /Noah dispatch deadline: \d{4}-/);
  assert.equal((store.snapshot().deliveries as any[]).filter(d => d.state === 'queued' && d.wake).length, 2);
});

test('autonomous mode retains the per-turn communication-tool guard and pauses queued work', async t => {
  let engine: Engine;
  const f = fixture(t, async o => {
    await engine.invoke(o.bridgeToken, 'noah_send', { recipient: 'pi', content: 'Queued peer question' }, 'peer');
    for (let i = 1; i < 64; i++) await engine.invoke(o.bridgeToken, 'noah_list_peers', {}, `read-${i}`);
    await assert.rejects(engine.invoke(o.bridgeToken, 'noah_send', {
      recipient: 'human', content: 'This excess tool call must not persist',
    }, 'excess'), /tool call limit reached/);
  }); engine = f.engine;
  const c = f.store.create('Runaway tool calls');
  f.store.send(c.id, 'human', 'grok', 'Start', 'start');
  await until(() => f.store.conversation(c.id).status === 'paused' && (f.store.snapshot().runs as any[]).every(r => r.status === 'completed'));
  assert.equal(f.store.conversation(c.id).limits_enabled, 0);
  assert.match(f.store.conversation(c.id).reason!, /64/);
  assert.equal(f.store.messages(c.id).length, 2);
  assert.equal((f.store.snapshot().deliveries as any[]).filter(d => d.state === 'queued' && d.wake).length, 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.starts(), 1, 'the queued peer must not wake after the tool guard pauses dispatch');
});

test('limit policy changes only on explicit resume and enabling limits starts from used runs', t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  const c = s.create('policy');
  s.db.prepare('UPDATE conversations SET used_runs=20,expires_at=0 WHERE id=?').run(c.id);
  s.send(c.id, 'human', 'pi', 'Held until resumed', 'held');
  const work = s.queued()[0];
  s.control(c.id, 'pause', 99, 60, true);
  assert.equal(s.conversation(c.id).limits_enabled, 0);
  assert.equal(s.conversation(c.id).max_runs, 12);
  assert.equal(s.conversation(c.id).expires_at, 0);
  assert.equal(s.claim(work.id), undefined);
  const beforeResume = Date.now();
  s.control(c.id, 'resume', 4, 2, true);
  assert.equal(s.conversation(c.id).limits_enabled, 1);
  assert.equal(s.conversation(c.id).max_runs, 24);
  assert.ok(s.conversation(c.id).expires_at >= beforeResume + 120000);
  assert.ok(s.claim(work.id));
  s.control(c.id, 'pause', 0, 20, false);
  assert.equal(s.conversation(c.id).limits_enabled, 1, 'pause does not silently remove owner limits');
  s.control(c.id, 'resume', 2);
  assert.equal(s.conversation(c.id).limits_enabled, 1);
  assert.equal(s.conversation(c.id).max_runs, 26, 'existing bounded resumes retain additive runs');
  s.control(c.id, 'resume', 0, 20, false);
  assert.equal(s.conversation(c.id).limits_enabled, 0);
  s.control(c.id, 'pause'); s.control(c.id, 'resume');
  assert.equal(s.conversation(c.id).limits_enabled, 0, 'omitted policy preserves autonomous mode');
  assert.equal(s.create('explicit opt out', 1, 1, undefined, false).limits_enabled, 0);
  assert.equal(s.create('explicit opt in', undefined, undefined, undefined, true).limits_enabled, 1);
});

test('legacy migration preserves limits, counters and pause state without resuming queued work', t => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-migration-')); const path = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,max_runs INTEGER NOT NULL,used_runs INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,reason TEXT,model_alias TEXT);
    INSERT INTO conversations VALUES('paused-task','Legacy paused','paused',4,3,1234,1000,'Owner paused','legacy-model');
    INSERT INTO conversations VALUES('active-task','Legacy active','active',8,2,5678,1001,NULL,'legacy-model');
    PRAGMA user_version=2;`);
  legacy.close();
  let s = new Store(path);
  assert.deepEqual({ ...s.conversation('paused-task') }, {
    id: 'paused-task', title: 'Legacy paused', status: 'paused', max_runs: 4, used_runs: 3,
    expires_at: 1234, created_at: 1000, reason: 'Owner paused', model_alias: 'legacy-model', limits_enabled: 1,
    archived_at: null, context_budget_bytes: null, context_used_bytes: 0,
  });
  assert.equal(s.conversation('active-task').status, 'active', 'migration itself does not alter lifecycle state');
  assert.equal(s.conversation('active-task').limits_enabled, 1);
  s.send('paused-task', 'human', 'pi', 'Waiting for the owner', 'held');
  s.recover();
  assert.equal(s.queued().length, 0);
  assert.equal(s.conversation('paused-task').reason, 'Owner paused');
  assert.equal(s.conversation('active-task').status, 'paused', 'normal restart recovery still requires explicit resume');
  const autonomous = s.create('New autonomous task');
  s.close(); s = new Store(path); t.after(() => s.close());
  assert.equal(s.conversation(autonomous.id).limits_enabled, 0, 'subsequent opens preserve explicit autonomous policy');
  assert.equal(s.conversation('paused-task').limits_enabled, 1);
  assert.equal((s.db.prepare('PRAGMA user_version').get() as any).user_version, 5);
});

test('restart preserves uncertainty and never automatically resubmits an ambiguous run', t => {
  const s = new Store(':memory:'); t.after(() => s.close()); const c = s.create('restart');
  s.send(c.id, 'human', 'grok', 'first', 'first'); s.send(c.id, 'human', 'grok', 'second', 'second');
  const [a, b] = s.queued(); assert.ok(s.claim(a.id));
  s.recover(); s.control(c.id, 'resume');
  assert.equal((s.snapshot().deliveries[0] as any).state, 'uncertain');
  assert.equal(s.claim(b.id), undefined);
  s.resolveUncertain(a.id); assert.ok(s.claim(b.id));
  assert.equal((s.snapshot().deliveries[0] as any).state, 'cancelled');
  assert.equal(s.conversation(c.id).used_runs, 2);
});

test('shared materials are immutable snapshots scoped to their conversation', t => {
  const s = new Store(':memory:'); t.after(() => s.close()); const a = s.create('A'), b = s.create('B');
  const m = s.addMaterial(a.id, 'notes.md', 'owner selected notes');
  assert.equal(s.material(a.id, m.id).content, 'owner selected notes');
  assert.throws(() => s.material(b.id, m.id), /not shared/);
  assert.equal(s.material(a.id, m.id).sha256.length, 64);
});

test('both peers initiate through authenticated tools; private output and read events do not send messages', async t => {
  let engine: Engine; const turns: Record<string, number> = {};
  const f = fixture(t, async o => {
    const key = `${o.row.conversation_id}:${o.agent}`; turns[key] = (turns[key] || 0) + 1;
    o.events.output('PRIVATE OUTPUT NEVER BROADCAST');
    const recipient = turns[key] === 1 ? (o.agent === 'grok' ? 'pi' : 'grok') : 'human';
    await engine.invoke(o.bridgeToken, 'noah_send', { recipient, content: 'peer reply' }, key + turns[key]);
  }); engine = f.engine;
  const c = f.store.create('peers'); f.store.send(c.id, 'human', 'grok', 'start', 'start');
  await until(() => f.starts() === 3 && (f.store.snapshot().runs as any[]).every(r => r.status === 'completed'));
  assert.deepEqual(f.store.messages(c.id).map(m => `${m.sender}>${m.recipient}`), ['human>grok', 'grok>pi', 'pi>grok', 'grok>human']);
  assert.ok((f.store.snapshot().runs as any[]).every(r => r.output.includes('PRIVATE')));
  f.store.snapshot(); f.store.emit('change'); f.store.emit('output');
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.starts(), 3);
  assert.equal(f.store.messages(c.id).some(m => m.content.includes('PRIVATE')), false);
});

test('busy inbox messages wait; forged identities and out-of-scope tool access are rejected', async t => {
  let release!: () => void, token = '', engine: Engine;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, async o => { token = o.bridgeToken; await gate; }); engine = f.engine;
  const c = f.store.create('busy'); const other = f.store.create('other');
  const material = f.store.addMaterial(other.id, 'private.txt', 'must not leak');
  f.store.send(c.id, 'human', 'pi', 'first', 'first');
  await until(() => f.starts() === 1);
  f.store.send(c.id, 'human', 'pi', 'second', 'second');
  await assert.rejects(engine.invoke(token, 'noah_send', { sender: 'grok', recipient: 'human', content: 'fake' }, 'fake'));
  await assert.rejects(engine.invoke(token, 'noah_read_material', { material_id: material.id }, 'read'), /not shared/);
  await assert.rejects(engine.invoke('wrong', 'noah_list_peers', {}, 'bad'), /credential/);
  assert.equal(f.starts(), 1); release();
  await until(() => f.starts() === 2 && (f.store.snapshot().runs as any[]).every(r => r.status === 'completed'));
  await assert.rejects(engine.invoke(token, 'noah_send', { recipient: 'human', content: 'late' }, 'late'), /No active/);
});

test('adapter timeout pauses the task with uncertainty and no model retry', async t => {
  const f = fixture(t, async () => { throw new Error('Harness timeout: session/prompt'); });
  const c = f.store.create('timeout'); f.store.send(c.id, 'human', 'grok', 'work', 'work');
  await until(() => (f.store.snapshot().deliveries[0] as any)?.state === 'uncertain');
  assert.equal(f.store.conversation(c.id).status, 'paused');
  f.store.control(c.id, 'resume'); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.starts(), 1);
});

test('request_human pauses future dispatch while preserving the explicit question', async t => {
  let engine: Engine;
  const f = fixture(t, async o => {
    await engine.invoke(o.bridgeToken, 'noah_request_human', { question: 'Which direction?' }, 'question');
    await engine.invoke(o.bridgeToken, 'noah_send', { recipient: 'pi', content: 'queued only' }, 'peer');
  }); engine = f.engine;
  const c = f.store.create('decision'); f.store.send(c.id, 'human', 'grok', 'start', 'start');
  await until(() => f.store.conversation(c.id).status === 'paused');
  assert.equal(f.store.messages(c.id).find(m => m.recipient === 'human')?.content, 'Which direction?');
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.starts(), 1);
});

test('confirmed cancellation terminates the active delivery and blocks subsequent turns', async t => {
  const store = new Store(':memory:'); let rejectPrompt!: (error: Error) => void, token = '';
  const engine = new Engine(store, '/tmp/noah-cancel-mock', o => ({
    start: async () => ({ nativeId: 'cancel-native', capabilities: {} }),
    prompt: async () => { token = o.bridgeToken; await new Promise<void>((_, reject) => { rejectPrompt = reject; }); },
    cancel: async () => rejectPrompt?.(new Error('Run cancelled')), close: async () => {},
  }));
  engine.url = 'http://127.0.0.1:1';
  t.after(async () => { await engine.close(); store.close(); });
  const c = store.create('cancel'); store.send(c.id, 'human', 'grok', 'one', 'one'); store.send(c.id, 'human', 'grok', 'two', 'two');
  await until(() => !!rejectPrompt); await engine.stopConversation(c.id);
  await until(() => (store.snapshot().deliveries[0] as any).state === 'cancelled');
  assert.equal(store.conversation(c.id).status, 'paused');
  assert.equal((store.snapshot().deliveries[1] as any).state, 'queued');
  await assert.rejects(engine.invoke(token, 'noah_send', { recipient: 'human', content: 'late' }, 'late'));
  assert.equal(store.conversation(c.id).used_runs, 1);
});

test('reopening the on-disk database retains model binding, messages, materials and uncertain delivery', t => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-reopen-')); const path = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let s = new Store(path);
  const c = s.create('persistent', 4, 20, 'chosen-model');
  const m = s.addMaterial(c.id, 'proof.txt', 'persistent body');
  const message = s.send(c.id, 'human', 'pi', 'persisted request', 'stable'); s.claim(s.queued()[0].id); s.close();
  s = new Store(path); t.after(() => s.close()); s.recover();
  assert.equal(s.conversation(c.id).model_alias, 'chosen-model');
  assert.equal(s.messages(c.id)[0].id, message.id);
  assert.equal(s.material(c.id, m.id).content, 'persistent body');
  assert.equal((s.snapshot().deliveries as any[]).find(d => d.agent === 'pi')?.state, 'uncertain');
  assert.equal(s.queued().length, 0);
});
