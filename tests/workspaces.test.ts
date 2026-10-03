import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { WorkspaceService } from '../src/workspaces.ts';

test('workspace permission is explicit, scoped, and never creates project files', () => {
  const path = mkdtempSync(join(tmpdir(), 'noah-intent-')), store = new Store(':memory:');
  try {
    const a = store.create('项目 A'), b = store.create('项目 B'); const service = new WorkspaceService(store);
    const grant = service.grant(a.id, { path }) as any;
    assert.throws(() => service.declare(b.id, 'pi', { workspace_id: grant.id, path: 'src', description: '实现' }), /授权/);
    assert.throws(() => service.declare(a.id, 'pi', { workspace_id: grant.id, path: '../outside', description: '实现' }), /相对路径/);
    service.declare(a.id, 'pi', { workspace_id: grant.id, path: 'src', description: '实现' });
    assert.deepEqual(readdirSync(path), []);
    service.revoke(a.id, grant.id);
    assert.equal(service.list(a.id).intents[0]?.state, 'revoked');
    assert.throws(() => service.declare(a.id, 'pi', { workspace_id: grant.id, path: 'src', description: '实现' }), /撤销/);
  } finally { store.db.close(); rmSync(path, { recursive: true, force: true }); }
});

test('advisory paths show conflicts, renewal, own release, and expiration', () => {
  const path = mkdtempSync(join(tmpdir(), 'noah-intent-')), store = new Store(':memory:'); let now = 1000;
  try {
    const c = store.create('协作'); const service = new WorkspaceService(store, () => now); const grant = service.grant(c.id, { path }) as any;
    const one = service.declare(c.id, 'pi', { workspace_id: grant.id, path: 'src/a', description: '实现', ttl_seconds: 60 });
    for (let i = 0; i < 301; i++) store.db.prepare('INSERT INTO work_intents VALUES(?,?,?,?,?,?,?,?,NULL)').run(`active-${i}`, c.id, grant.id, 'grok', `other-${i}`, 'other active work', now + i + 1, now + 60000);
    assert.equal(service.declare(c.id, 'grok', { workspace_id: grant.id, path: 'src/ab', description: '其他模块' }).conflicts.length, 0);
    const overlap = service.declare(c.id, 'grok', { workspace_id: grant.id, path: 'src/a/file.ts', description: '复核修改', ttl_seconds: 60 });
    assert.equal(overlap.conflicts.length, 1);
    assert.throws(() => service.release(c.id, 'pi', overlap.intent!.id), /自己/);
    assert.equal(service.declare(c.id, 'pi', { workspace_id: grant.id, path: 'src/a', description: '更新', ttl_seconds: 60 }).intent?.id, one.intent?.id);
    service.release(c.id, 'grok', overlap.intent!.id);
    assert.equal(service.list(c.id).conflicts.length, 0);
    now += 60001;
    assert.equal(service.list(c.id).intents.some(i => i.id === one.intent!.id && i.state === 'active'), false);
    assert.ok(service.list(c.id).intents.some(i => i.state === 'expired'));
    store.removeParticipant(c.id, 'pi');
    assert.throws(() => service.tool(c.id, 'pi', 'noah_list_workspaces', {}), /退出/);
  } finally { store.db.close(); rmSync(path, { recursive: true, force: true }); }
});
