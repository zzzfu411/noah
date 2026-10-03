import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { DesktopNotifications } = require('../desktop/notifications.cjs');
const { installLocal, rollbackLocal } = require('../desktop/install.cjs');
const conversationId = '11111111-2222-4333-8444-555555555555';
const event = { id: 'human:request-1', kind: 'human_input', conversationId };

function directory(t: { after: (callback: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), 'noah-desktop-maturity-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('notifications default off, accept metadata only, and never replay observed alerts after opt-in', async t => {
  const file = join(directory(t), 'notifications.json');
  let attempts = 0;
  const manager = new DesktopNotifications(file, { supported: () => true, foreground: () => false,
    show: () => { attempts++; return { status: 'shown' }; }, open: () => {} });
  assert.deepEqual(manager.settings(), { enabled: false, supported: true });
  assert.deepEqual(await manager.notify(event), { status: 'disabled' });
  await assert.rejects(manager.notify({ ...event, body: 'private material must stay local' }), /通知只能/);
  manager.setEnabled(true);
  assert.deepEqual(await manager.notify(event), { status: 'duplicate' });
  assert.equal(attempts, 0);
  const ledger = readFileSync(file, 'utf8');
  assert.ok(!ledger.includes(event.id));
  assert.ok(!ledger.includes('private material'));
});

test('background notifications have fixed copy, survive reload without duplicates, and return to the exact discussion', async t => {
  const file = join(directory(t), 'notifications.json');
  let focused = false, opened = '', clicked: (() => void) | undefined;
  const shown: any[] = [];
  const options = { supported: () => true, foreground: () => focused,
    show: (payload: any, callback: () => void) => { shown.push(payload); clicked = callback; return { status: 'shown' }; },
    open: (id: string) => { opened = id; } };
  const manager = new DesktopNotifications(file, options);
  manager.setEnabled(true);
  assert.deepEqual(await manager.notify(event), { status: 'shown' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Noah 需要你关注');
  assert.ok(!shown[0].body.includes(conversationId));
  clicked?.();
  assert.equal(opened, conversationId);
  const reopened = new DesktopNotifications(file, options);
  assert.deepEqual(await reopened.notify(event), { status: 'duplicate' });
  assert.equal(reopened.conversationForNotification(shown[0].id), conversationId);
  focused = true;
  assert.deepEqual(await reopened.notify({ ...event, id: 'human:request-2' }), { status: 'foreground' });
  assert.equal(shown.length, 1);
});

test('notification service failure remains distinct from a shown notification and does not repeat on refresh', async t => {
  const manager = new DesktopNotifications(join(directory(t), 'notifications.json'), { supported: () => true,
    foreground: () => false, show: () => { throw new Error('system notification denied'); }, open: () => {} });
  manager.setEnabled(true);
  assert.deepEqual(await manager.notify(event), { status: 'failed' });
  assert.deepEqual(await manager.notify(event), { status: 'duplicate' });
});

test('one-time notification test works while disabled and foregrounded without changing settings or the receipt ledger', async t => {
  const file = join(directory(t), 'notifications.json');
  let opened: string | null | undefined, clicked: (() => void) | undefined;
  const shown: any[] = [];
  const manager = new DesktopNotifications(file, { supported: () => true, foreground: () => true,
    show: (payload: any, callback: () => void) => { shown.push(payload); clicked = callback; return { status: 'shown' }; },
    open: (id: string | null) => { opened = id; } });
  await manager.notify(event);
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(await manager.testNotification(conversationId), { status: 'shown' });
  assert.deepEqual(manager.settings(), { enabled: false, supported: true });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(shown[0].title, '来自 Noah 的测试提醒');
  assert.equal(shown[0].body, '系统提醒测试，点击回到当前讨论。');
  assert.ok(!JSON.stringify(shown[0]).includes(conversationId));
  clicked?.(); assert.equal(opened, conversationId);
  assert.deepEqual(await manager.testNotification(null), { status: 'shown' });
  assert.equal(shown[1].body, '系统提醒测试，点击回到 Noah。');
  assert.notEqual(shown[1].id, shown[0].id);
  clicked?.(); assert.equal(opened, null);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(await manager.notify(event), { status: 'duplicate' });
});

test('one-time notification test rejects extra targets, coalesces pending calls, and preserves system result states', async t => {
  const file = join(directory(t), 'notifications.json');
  let supported = true, attempts = 0, opened: string | null | undefined;
  let settle!: (result: { status: string }) => void, clicked: (() => void) | undefined;
  const manager = new DesktopNotifications(file, { supported: () => supported, foreground: () => true,
    show: (_payload: any, callback: () => void) => { attempts++; clicked = callback; return new Promise(resolve => { settle = resolve; }); },
    open: (id: string | null) => { opened = id; } });
  const first = manager.testNotification(conversationId);
  const second = manager.testNotification(null);
  assert.equal(first, second);
  await assert.rejects(manager.testNotification({ conversationId, body: 'private' }), /讨论标识/);
  await assert.rejects(manager.testNotification('not-a-uuid'), /讨论标识/);
  await assert.rejects(manager.testNotification(undefined), /讨论标识/);
  assert.equal(attempts, 1);
  clicked?.(); assert.equal(opened, conversationId);
  settle({ status: 'submitted' });
  assert.deepEqual(await first, { status: 'submitted' });
  assert.deepEqual(await second, { status: 'submitted' });
  const failed = manager.testNotification(null);
  await Promise.resolve();
  settle({ status: 'failed' }); assert.deepEqual(await failed, { status: 'failed' });
  manager.show = () => { throw new Error('system notification denied'); };
  assert.deepEqual(await manager.testNotification(null), { status: 'failed' });
  supported = false;
  assert.deepEqual(await manager.testNotification(null), { status: 'unsupported' });
  assert.equal(attempts, 2);
  assert.equal(existsSync(file), false);
  assert.deepEqual(manager.settings(), { enabled: false, supported: false });
});

test('notification cold-start target is recovered only for an explicit click on a persisted Noah alert', async t => {
  const file = join(directory(t), 'notifications.json');
  let identifier = '';
  const options = { supported: () => true, foreground: () => false,
    show: (payload: any) => { identifier = payload.id; return { status: 'shown' }; }, open: () => {} };
  const manager = new DesktopNotifications(file, options);
  manager.setEnabled(true); await manager.notify(event);
  const restored = new DesktopNotifications(file, options);
  const click = { identifier, actionIdentifier: 'com.apple.UNNotificationDefaultActionIdentifier' };
  assert.equal(restored.conversationFromLaunchInfo(click), conversationId);
  assert.equal(restored.conversationFromLaunchInfo({ ...click, actionIdentifier: 'com.apple.UNNotificationDismissActionIdentifier' }), undefined);
  assert.equal(restored.conversationFromLaunchInfo({ ...click, actionIdentifier: 'CLOSE_ACTION' }), undefined);
  assert.equal(restored.conversationFromLaunchInfo({ ...click, identifier: 'noah-' + '0'.repeat(64) }), undefined);
  assert.equal(restored.conversationFromLaunchInfo({ ...click, identifier: 'noah-test-' + conversationId }), undefined);
  assert.equal(restored.conversationFromLaunchInfo({ ...click, identifier: 'noah-constructor' }), undefined);
  assert.equal(restored.conversationFromLaunchInfo(undefined), undefined);
});

function bundle(path: string, version: string) {
  mkdirSync(join(path, 'Contents/Resources/app'), { recursive: true });
  writeFileSync(join(path, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.yeuxark.noah</string></dict></plist>');
  writeFileSync(join(path, 'Contents/Resources/app/package.json'), JSON.stringify({ name: 'noah-local', version }));
  writeFileSync(join(path, 'Contents/fixture'), version);
  return path;
}

test('local installation is a read-only preview until explicitly applied', t => {
  const dir = directory(t), source = bundle(join(dir, 'release/Noah.app'), '0.4.0');
  const destination = join(dir, 'Applications/Noah.app');
  const result = installLocal(source, destination);
  assert.equal(result.applied, false);
  assert.equal(result.version, '0.4.0');
  assert.equal(existsSync(join(dir, 'Applications')), false);
  assert.throws(() => installLocal(source, source), /必须分开/);
});

test('application replacement and rollback keep both app versions and leave user data untouched', t => {
  const dir = directory(t), source = bundle(join(dir, 'release/Noah.app'), '0.4.0');
  const destination = bundle(join(dir, 'Applications/Noah.app'), '0.3.0');
  const data = join(dir, 'user-data.sqlite'); writeFileSync(data, 'existing discussions');
  const checked: string[] = [];
  const result = installLocal(source, destination, { apply: true, stopped: () => {}, verify: (path: string) => checked.push(path) });
  assert.equal(result.state, 'installed'); assert.equal(checked.length, 2);
  assert.equal(readFileSync(join(destination, 'Contents/fixture'), 'utf8'), '0.4.0');
  assert.equal(readFileSync(join(result.previous, 'Contents/fixture'), 'utf8'), '0.3.0');
  assert.equal(rollbackLocal(result.receiptPath).applied, false);
  const reverted = rollbackLocal(result.receiptPath, { apply: true, stopped: () => {} });
  assert.equal(readFileSync(join(destination, 'Contents/fixture'), 'utf8'), '0.3.0');
  assert.equal(readFileSync(join(reverted.retained, 'Contents/fixture'), 'utf8'), '0.4.0');
  assert.equal(readFileSync(data, 'utf8'), 'existing discussions');
});

test('a running app or failed staged signature stops replacement before the existing app moves', t => {
  const dir = directory(t), source = bundle(join(dir, 'release/Noah.app'), '0.4.0');
  const destination = bundle(join(dir, 'Applications/Noah.app'), '0.3.0');
  assert.throws(() => installLocal(source, destination, { apply: true, stopped: () => { throw new Error('still running'); } }), /still running/);
  let calls = 0;
  assert.throws(() => installLocal(source, destination, { apply: true, stopped: () => {}, verify: () => { if (++calls === 2) throw new Error('invalid staged signature'); } }), /invalid staged signature/);
  assert.equal(readFileSync(join(destination, 'Contents/fixture'), 'utf8'), '0.3.0');
  assert.equal(existsSync(join(dir, 'Applications/.Noah-install.lock')), false);
});
