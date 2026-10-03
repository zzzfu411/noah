import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Engine recovery timed out');
}

test('an older application refuses a newer database before changing its data or schema', t => {
  const directory = mkdtempSync(join(tmpdir(), 'noah-newer-db-')), path = join(directory, 'state.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const future = new DatabaseSync(path);
  future.exec("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('新版本的完整数据'); PRAGMA user_version=6;");
  future.close();
  const original = readFileSync(path);
  assert.throws(() => new Store(path), /数据库版本 6.*请更新应用/);
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(readdirSync(directory), ['state.sqlite'], 'a refused database must not acquire a migration backup or journal');
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.equal(check.prepare('SELECT value FROM future_data').get()!.value, '新版本的完整数据');
    assert.equal(check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='conversations'").get()!.count, 0);
  } finally { check.close(); }
});

test('startup failure retains the original inbox and retries only after owner resume', async t => {
  const store = new Store(':memory:');
  let attempts = 0;
  const inputs: string[] = [];
  const engine = new Engine(store, '/tmp/noah-startup-recovery', () => ({
    start: async () => {
      if (++attempts === 1) throw new Error('Harness configuration unavailable');
      return { nativeId: 'reconnected', capabilities: {} };
    },
    prompt: async input => { inputs.push(input); },
    cancel: async () => {}, close: async () => {},
  }));
  engine.url = 'http://127.0.0.1:1';
  t.after(async () => { await engine.close(); store.close(); });
  const c = store.create('修好接入后继续', undefined, undefined, undefined, false, [{ id: 'pi', harness: 'pi' }]);
  const messages = [store.send(c.id, 'human', 'pi', '第一条完整问题', 'one'), store.send(c.id, 'human', 'pi', '补充内容', 'two')];
  await until(() => store.conversation(c.id).status === 'paused');
  const receipts = store.snapshot().deliveries as any[];
  assert.equal(attempts, 1); assert.equal(inputs.length, 0);
  assert.equal(store.conversation(c.id).used_runs, 0); assert.equal(store.snapshot().runs.length, 0);
  assert.ok(receipts.every(d => d.state === 'queued' && d.run_id === null));
  assert.match(store.session(c.id, 'pi').error!, /configuration unavailable/);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(attempts, 1, 'connection errors must not cause automatic startup retries');
  store.control(c.id, 'resume');
  await until(() => (store.snapshot().runs[0] as any)?.status === 'completed');
  assert.equal(attempts, 2); assert.equal(inputs.length, 1); assert.equal(store.conversation(c.id).used_runs, 1);
  assert.ok(messages.every(message => inputs[0].includes(message.content)));
  assert.deepEqual((store.snapshot().deliveries as any[]).map(d => d.id), receipts.map(d => d.id));
  assert.ok((store.snapshot().deliveries as any[]).every(d => d.state === 'completed'));
});

test('late startup failure preserves a removed member receipt and an archived discussion', async t => {
  const store = new Store(':memory:');
  let rejectStart: (error: Error) => void = () => {}, started = false, prompts = 0;
  const engine = new Engine(store, '/tmp/noah-startup-removed', () => ({
    start: () => new Promise((_, reject) => { rejectStart = reject; started = true; }),
    prompt: async () => { prompts++; },
    cancel: async () => {}, close: async () => {},
  }));
  engine.url = 'http://127.0.0.1:1';
  t.after(async () => { await engine.close(); store.close(); });
  const c = store.create('连接时退出', undefined, undefined, undefined, false, [{ id: 'pi', harness: 'pi' }]);
  store.send(c.id, 'human', 'pi', '尚未提交', 'one');
  await until(() => started);
  store.removeParticipant(c.id, 'pi'); store.control(c.id, 'archive');
  rejectStart(new Error('Harness startup disconnected'));
  await until(() => store.session(c.id, 'pi').status === 'error');
  assert.equal(prompts, 0); assert.equal(store.snapshot().runs.length, 0);
  assert.equal((store.snapshot().deliveries[0] as any).state, 'cancelled');
  assert.match((store.snapshot().deliveries[0] as any).error, /成员已退出/);
  assert.equal(store.conversation(c.id).status, 'archived');
});
