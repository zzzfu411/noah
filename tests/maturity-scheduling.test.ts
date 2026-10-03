import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { activityPage } from '../src/queries.ts';

test('twenty discussions receive round-robin turns without changing autonomous policy', async t => {
  const store = new Store(':memory:');
  const visits: string[] = [], waits: number[] = [], queuedAt = new Map<string, number>();
  const engine = new Engine(store, '/tmp/noah-fair-test', options => ({
    start: async () => ({ nativeId: options.row.conversation_id + options.agent, capabilities: {} }),
    prompt: async () => { visits.push(options.row.conversation_id); waits.push(performance.now() - queuedAt.get(options.row.conversation_id)!); await new Promise(r => setTimeout(r, 2)); },
    cancel: async () => {}, close: async () => {},
  }));
  engine.url = 'http://127.0.0.1:1'; t.after(async () => { await engine.close(); store.close(); });
  const discussions = Array.from({ length: 20 }, (_, i) => {
    const c = store.create(`讨论 ${i}`, undefined, undefined, undefined, false, [
      { id: 'one', harness: 'pi' }, { id: 'two', harness: 'pi' }, { id: 'three', harness: 'pi' },
    ]);
    queuedAt.set(c.id, performance.now()); store.send(c.id, 'human', 'all', '每个讨论都应有进展', 'ask'); return c;
  });
  for (let i = 0; visits.length < 60 && i < 600; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(visits.length, 60);
  assert.equal(new Set(visits.slice(0, 20)).size, 20, 'each discussion gets its first turn before any gets a second');
  assert.ok(discussions.every(c => store.conversation(c.id).limits_enabled === 0));
  const sorted = [...waits].sort((a, b) => a - b);
  t.diagnostic(`Mock harness workload only: ${visits.length} starts / 20 discussions; queue wait p50=${sorted[29].toFixed(1)}ms p95=${sorted[56].toFixed(1)}ms; no provider latency included.`);
});

test('execution and receipt pages are scoped, ordered and expose full persisted output only on demand', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const a = store.create('分页'), b = store.create('别的讨论');
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    store.send(a.id, 'human', 'pi', `公开问题${i}`, `m${i}`);
    const work = store.queued().find(d => d.conversation_id === a.id)!;
    store.claim(work.id); store.output(work.id, `private output ${i}`); store.delivery(work.id, 'completed'); ids.push(work.id);
  }
  store.send(b.id, 'human', 'pi', '无关', 'other');
  const first = activityPage(store, a.id, 'runs', { limit: 3 });
  const second = activityPage(store, a.id, 'runs', { limit: 4, before: Number(first.nextBefore) });
  assert.deepEqual([...(first.runs as any[]), ...(second.runs as any[])].map(r => r.id), [...ids].reverse());
  assert.equal((first.runs as any[])[0].output, 'private output 6');
  assert.equal(first.hasOlder, true); assert.equal(second.hasOlder, false);
  const receipts = activityPage(store, a.id, 'deliveries', { limit: 200 }).deliveries as any[];
  assert.equal(receipts.length, 14); assert.ok(receipts.every(d => d.conversation_id === a.id));
  const oldMessageId = (receipts[0] as any).message_id;
  const selected = activityPage(store, a.id, 'deliveries', { messageIds: [oldMessageId] }).deliveries!;
  assert.equal(selected.length, 2); assert.ok(selected.every(d => d.message_id === oldMessageId));
});

test('compact state omits private output and preserves full-history accounting with a bounded recent window', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const c = store.create('快照基线', undefined, undefined, undefined, false, [{ id: 'pi', harness: 'pi' }]);
  for (let i = 0; i < 240; i++) {
    store.send(c.id, 'human', 'pi', `公开消息 ${i}`, `row-${i}`);
    const batch = store.claimBatch(store.queued()[0].id)!;
    store.recordInjection(batch.id, '实际提交文本', batch.deliveries);
    store.output(batch.id, 'PRIVATE-OUTPUT-'.repeat(1200));
    store.deliveryBatch(batch.id, 'completed');
  }
  const full = JSON.stringify(store.snapshot()), compact = store.snapshot({ compact: true });
  const encoded = JSON.stringify(compact);
  assert.equal(compact.messages.length, 200); assert.equal(compact.runs.length, 100);
  assert.equal(encoded.includes('PRIVATE-OUTPUT'), false);
  assert.equal((compact.runMetrics[0] as any).prompt_starts, 240);
  assert.equal((compact.deliveryCounts[0] as any).count, 240);
  assert.ok(Buffer.byteLength(encoded) < Buffer.byteLength(full) / 5);
  t.diagnostic(`Local fixture only: 240 runs × 16.8KB private output; full snapshot ${Buffer.byteLength(full)}B, compact ${Buffer.byteLength(encoded)}B.`);
});
