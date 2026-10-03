import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.ts';
import { GrokNativeBridge } from '../src/grok-native-bridge.ts';
const turn = (id: string) => ({ promptIdHash: createHash('sha256').update(id).digest('hex') });

async function fixture(t: TestContext) {
  const store = new Store(':memory:'), bridge = new GrokNativeBridge(store);
  t.after(() => { bridge.close(); store.close(); });
  const grant = bridge.issueJoinToken();
  const registration = await bridge.handle('/api/grok-bridge/register', 'POST', '', { joinToken: grant.joinToken, nativeSessionId: 'cancel-test-session', projectDir: '/work', label: 'Original Grok', callCommand: 'node /noah/grok-native-cli.ts call /private/grant.json' });
  assert.equal(registration?.status, 201);
  const binding = registration!.body;
  const request = (path: string, input: unknown = {}) => bridge.handle('/api/grok-bridge/' + path, 'POST', binding.credential, input);
  await request('poll');
  const c = store.create('Cancellation', undefined, undefined, undefined, false, [{ id: 'original', harness: 'grok', mode: 'external', bindingId: binding.bindingId }]);
  return { store, bridge, binding, request, c };
}

test('a known old cancellation cannot pause a batch admitted after a newer observed turn', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('turn', turn('old')))?.body, { sequence: 1 });
  assert.deepEqual((await f.request('turn', turn('new')))?.body, { sequence: 2 });
  f.store.send(f.c.id, 'human', 'original', 'New discussion work', 'new-turn-input');
  const notice = (await f.request('poll'))!.body.notification;
  assert.deepEqual((await f.request('turn', turn('old')))?.body, { sequence: 1 }, 'repeated old observations never move the turn forward');
  assert.deepEqual((await f.request('pause', { cause: 'cancelled', ...turn('old') }))?.body, { paused: false });
  assert.equal(f.bridge.list()[0].status, 'busy');
  assert.equal((f.bridge.wakes()[0] as any).state, 'notified');
  assert.equal((await f.request('tool', { name: 'noah_read', args: { batchId: notice.batchId } }))?.status, 200);
  assert.equal((await f.request('tool', { name: 'noah_complete', args: { batchId: notice.batchId } }))?.status, 200);
  assert.equal(f.store.snapshot().deliveries[0].state, 'agent_reported');
  assert.equal(f.store.conversation(f.c.id).used_runs, 1);
  f.bridge.revoke(f.binding.bindingId);
  const grant = f.bridge.issueJoinToken();
  const rejoined = await f.bridge.handle('/api/grok-bridge/register', 'POST', '', { joinToken: grant.joinToken, nativeSessionId: 'cancel-test-session', projectDir: '/work', label: 'Original Grok', callCommand: 'node /noah/grok-native-cli.ts call /private/grant.json' });
  assert.equal(rejoined?.status, 201);
  assert.equal((await f.request('turn', turn('old')))?.status, 401, 'the old credential cannot add observations after rejoin');
  assert.deepEqual((await f.bridge.handle('/api/grok-bridge/turn', 'POST', rejoined!.body.credential, turn('new')))?.body, { sequence: 1 }, 'a new grant starts a fresh observation generation');
});

test('a future turn cannot hide cancellation of an older unfinished Noah batch', async t => {
  const f = await fixture(t);
  await f.request('turn', turn('old'));
  assert.deepEqual((await f.request('pause', { cause: 'cancelled', ...turn('old') }))?.body, { paused: false });
  assert.equal((await f.request('poll'))?.status, 200);
  f.store.send(f.c.id, 'human', 'original', 'Shared work still awaiting a reply', 'cancel-input');
  const notice = (await f.request('poll'))!.body.notification;
  await f.request('turn', turn('future'));
  assert.deepEqual((await f.request('pause', { cause: 'cancelled', ...turn('old') }))?.body, { paused: true });
  assert.equal(f.bridge.list()[0].status, 'paused');
  assert.equal((f.bridge.wakes()[0] as any).state, 'uncertain');
  assert.equal((await f.request('poll'))?.status, 401);
  assert.equal((await f.request('tool', { name: 'noah_complete', args: { batchId: notice.batchId } }))?.status, 401);
  assert.equal(f.store.snapshot().deliveries[0].state, 'uncertain');
  assert.equal(f.store.conversation(f.c.id).used_runs, 1);
  f.bridge.resolveWake(notice.batchId);
  assert.equal(f.store.snapshot().deliveries[0].state, 'cancelled');
  assert.equal(f.bridge.list()[0].status, 'paused', 'owner acknowledgement alone must not reactivate credentials');
});

test('missing and unknown turn IDs stay conservative, and an empty pause retains compaction behavior', async t => {
  for (const input of [{ cause: 'cancelled' }, { cause: 'cancelled', ...turn('never-observed') }, {}]) {
    const f = await fixture(t);
    await f.request('turn', turn('known'));
    if ('cause' in input) {
      f.store.send(f.c.id, 'human', 'original', 'Shared work with an uncorrelated cancellation', 'unknown-turn-input');
      await f.request('poll');
    }
    assert.deepEqual((await f.request('pause', input))?.body, { paused: true });
    assert.equal(f.bridge.list()[0].status, 'paused');
    assert.equal((await f.request('poll'))?.status, 401);
    if ('cause' in input) assert.equal((f.bridge.wakes()[0] as any).state, 'uncertain');
    else assert.equal(f.bridge.wakes().length, 0);
  }
});
