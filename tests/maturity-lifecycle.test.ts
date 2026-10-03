import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { exportDiscussion, searchMessages } from '../src/queries.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Lifecycle operation timed out');
}

test('archive preserves queued history and owner limits; restored discussions stay paused', t => {
  const dir = mkdtempSync(join(tmpdir(), 'noah-v5-')), path = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  let s = new Store(path);
  const c = s.create('保留讨论', 9, 30);
  const m = s.send(c.id, 'human', 'pi', '归档后仍能检索的正文', 'one');
  s.db.exec('PRAGMA user_version=4'); s.close();
  s = new Store(path); t.after(() => s.close());
  assert.equal(readdirSync(dir).filter(n => n.includes('.pre-v5-')).length, 1);
  assert.equal(s.conversation(c.id).max_runs, 9);
  assert.equal(s.conversation(c.id).limits_enabled, 1);
  s.control(c.id, 'archive');
  assert.equal(s.queued().length, 0);
  assert.throws(() => s.control(c.id, 'resume'), /恢复/);
  assert.throws(() => s.send(c.id, 'human', 'pi', '不新增', 'two'), /恢复/);
  s.pause(c.id, '运行稍后失败');
  assert.equal(s.conversation(c.id).status, 'archived', 'a settling run must not undo the owner archive');
  assert.equal(searchMessages(s, '仍能检索').results[0].id, m.id);
  s.control(c.id, 'restore');
  assert.equal(s.conversation(c.id).status, 'paused');
  assert.equal(s.queued().length, 0);
  assert.equal(s.messages(c.id)[0].id, m.id);
  assert.equal(s.conversation(c.id).used_runs, 0);
});

test('membership changes preserve identity and optionally share history without starting work; material versions remain readable', t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  const c = s.create('成员与资料');
  const original = s.send(c.id, 'human', 'pi', '完整旧正文', 'old');
  const count = s.queued().length;
  s.addParticipant(c.id, { id: 'pi-review', harness: 'pi' }, true);
  s.addParticipant(c.id, { id: 'pi-fresh', harness: 'pi' }, false);
  assert.equal(s.queued().length, count, 'history backfill is passive');
  const backfill = (s.snapshot().deliveries as any[]).filter(d => d.agent === 'pi-review');
  assert.equal(backfill.length, 1); assert.equal(backfill[0].message_id, original.id); assert.equal(backfill[0].wake, 0);
  assert.equal((s.snapshot().deliveries as any[]).filter(d => d.agent === 'pi-fresh').length, 0);
  s.removeParticipant(c.id, 'pi');
  assert.equal(s.sessions(c.id).some(p => p.agent === 'pi'), false);
  assert.equal(s.sessions(c.id, true).some(p => p.agent === 'pi'), true);
  assert.throws(() => s.send(c.id, 'pi', 'human', '过期成员不能发言', 'bad'), /Invalid/);
  assert.throws(() => s.addParticipant(c.id, { id: 'pi', harness: 'pi' }, true), /historical/);
  const v1 = s.addMaterial(c.id, '方案.txt', '旧版完整正文');
  const v2 = s.reviseMaterial(c.id, v1.id, '方案.txt', '新版完整正文');
  assert.equal(v2.revision, 2); assert.equal(v2.family_id, v1.id);
  assert.equal(s.material(c.id, v1.id).content, '旧版完整正文');
  assert.equal(s.material(c.id, v1.id).sha256, v1.sha256);
  assert.equal(s.material(c.id, v2.id).content, '新版完整正文');
  assert.throws(() => s.reviseMaterial(c.id, v1.id, '覆盖.txt', '过期更新'), /更新版本/);
});

test('optional byte budget pauses before prompt, retains full input, and reservations charge once', async t => {
  const s = new Store(':memory:'); let prompts = 0;
  const engine = new Engine(s, '/tmp/noah-budget-test', () => ({ start: async () => ({ nativeId: 'budget', capabilities: {} }), prompt: async () => { prompts++; }, cancel: async () => {}, close: async () => {} }));
  engine.url = 'http://127.0.0.1:1'; t.after(async () => { await engine.close(); s.close(); });
  const c = s.create('预算自主可选', undefined, undefined, undefined, false, [{ id: 'pi', harness: 'pi' }], 3);
  assert.equal(s.reserveContextBytes(c.id, 'native:sample', 3), true);
  assert.equal(s.reserveContextBytes(c.id, 'native:sample', 3), true);
  assert.equal(s.conversation(c.id).context_used_bytes, 3);
  s.send(c.id, 'human', 'pi', '不能被静默截断的完整正文', 'full');
  await until(() => s.conversation(c.id).status === 'paused');
  assert.equal(prompts, 0); assert.equal(s.conversation(c.id).used_runs, 0);
  assert.equal(s.snapshot().runs.length, 0);
  assert.equal(s.messages(c.id)[0].content, '不能被静默截断的完整正文');
  s.control(c.id, 'resume', 0, 20, undefined, null);
  await until(() => prompts === 1);
  assert.equal(s.conversation(c.id).limits_enabled, 0);
  assert.equal(s.conversation(c.id).context_budget_bytes, null);
});

test('evidence-scoped outcomes retain minority views and all revisions; only owner decisions confirm a version', t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  const c = s.create('需要依据的结论');
  const evidence = s.send(c.id, 'pi', 'human', '实测结果与保留意见', 'source');
  const other = s.create('无关讨论'), foreign = s.send(other.id, 'human', 'pi', '不能引用', 'foreign');
  assert.throws(() => s.proposeOutcome(c.id, 'pi', { kind: 'conclusion', title: '跨讨论', content: '不能', evidenceMessageIds: [foreign.id] }), /同一讨论/);
  const proposal = s.proposeOutcome(c.id, 'pi', { kind: 'conclusion', title: '可实施', content: '仍有条件', evidenceMessageIds: [evidence.id], clientKey: 'proposal' });
  const dissent = s.proposeOutcome(c.id, 'grok', { kind: 'disagreement', title: '保留异议', content: '尚需测量', evidenceMessageIds: [evidence.id] });
  s.decideOutcome(c.id, proposal.id, 'confirmed', 1);
  assert.equal(s.conversation(c.id).status, 'active', 'confirming a proposal does not end a discussion');
  assert.equal(s.outcome(c.id, dissent.id).status, 'proposed');
  assert.throws(() => s.reviseOutcome(c.id, proposal.id, 'human', { title: '替别人改', content: '不允许', evidenceMessageIds: [evidence.id], expectedRevision: 1 }), /自己提出/);
  s.reviseOutcome(c.id, proposal.id, 'pi', { title: '补充限制', content: '原文保留，新版再审', evidenceMessageIds: [evidence.id], expectedRevision: 1 });
  assert.equal(s.outcome(c.id, proposal.id).status, 'proposed');
  assert.throws(() => s.decideOutcome(c.id, proposal.id, 'confirmed', 1), /更新版本/);
  const exported = exportDiscussion(s, c.id);
  assert.equal(exported.outcomes.length, 2);
  assert.equal(exported.outcomeRevisions.length, 3);
  assert.equal(exported.outcomeDecisions.length, 1);
  assert.equal(exported.outcomeRevisions.find(r => r.outcome_id === proposal.id && r.revision === 1).content, '仍有条件');
  assert.equal(s.proposeOutcome(c.id, 'pi', { kind: 'conclusion', title: '可实施', content: '仍有条件', evidenceMessageIds: [evidence.id], clientKey: 'proposal' }).id, proposal.id);
});

test('an in-flight member cannot use tools after removal and its late failure cannot unarchive a discussion', async t => {
  const s = new Store(':memory:'); let credential = '', fail: (error: Error) => void = () => {}, cancels = 0;
  const engine = new Engine(s, '/tmp/noah-archive-running', options => ({
    start: async () => ({ nativeId: 'in-flight', capabilities: {} }),
    prompt: async () => { credential = options.bridgeToken; await new Promise<void>((_, reject) => { fail = reject; }); },
    cancel: async () => { cancels++; }, close: async () => {},
  }));
  engine.url = 'http://127.0.0.1:1'; t.after(async () => { await engine.close(); s.close(); });
  const c = s.create('移除时正在运行', undefined, undefined, undefined, false, [{ id: 'pi', harness: 'pi' }]);
  s.send(c.id, 'human', 'pi', '正在执行', 'start');
  await until(() => !!credential);
  s.removeParticipant(c.id, 'pi');
  assert.equal(cancels, 0, 'membership removal does not pretend to cancel an already running harness');
  await assert.rejects(engine.invoke(credential, 'noah_send', { recipient: 'human', content: '已经退出' }, 'stale'), /退出/);
  s.control(c.id, 'archive'); fail(new Error('Harness disconnected before a receipt'));
  await until(() => (s.snapshot().runs[0] as any).status === 'uncertain');
  assert.equal(s.conversation(c.id).status, 'archived');
  assert.equal(s.messages(c.id).length, 1);
});
