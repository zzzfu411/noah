const { createHash, randomUUID } = require('node:crypto');
const { readState, writeState } = require('./state.cjs');

const kinds = Object.freeze({
  human_input: '有讨论需要你的决定，点击回到 Noah。',
  failed: '有一项协作未能完成，点击查看可继续的步骤。',
  uncertain: '有一项执行结果需要核对，点击查看详情。',
  proposal: '有新的结论提案等待你确认，点击查看详情。',
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'conversationId,id,kind' ||
      typeof value.id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(value.id) ||
      typeof value.kind !== 'string' || !Object.hasOwn(kinds, value.kind) || typeof value.conversationId !== 'string' || !uuid.test(value.conversationId)) {
    throw new Error('通知只能包含事件标识、类型和讨论标识');
  }
  return { id: value.id, kind: value.kind, conversationId: value.conversationId };
}

// This receipt ledger is independent of renderer storage and backend ports. It
// contains only event hashes and discussion IDs, never message bodies or titles.
class DesktopNotifications {
  constructor(path, { supported, foreground, show, open }) {
    this.path = path;
    this.supported = supported;
    this.foreground = foreground;
    this.show = show;
    this.open = open;
    const saved = readState(path);
    this.state = { version: 1, enabled: saved?.enabled === true, observed: {} };
    if (saved?.version === 1 && saved.observed && typeof saved.observed === 'object') {
      for (const [key, value] of Object.entries(saved.observed)) {
        if (/^[a-f0-9]{64}$/.test(key) && typeof value === 'string' && uuid.test(value)) this.state.observed[key] = value;
      }
    }
  }
  settings() { return { enabled: this.state.enabled, supported: !!this.supported() }; }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('通知开关必须是布尔值');
    this.state.enabled = enabled;
    writeState(this.path, this.state);
    return this.settings();
  }
  async notify(value) {
    const event = validateEvent(value);
    const key = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    if (Object.hasOwn(this.state.observed, key)) return { status: 'duplicate' };
    // Observe while disabled or foregrounded too: enabling notifications later
    // must not replay old alerts, and a refresh must not create another alert.
    this.state.observed[key] = event.conversationId;
    writeState(this.path, this.state);
    if (!this.state.enabled) return { status: 'disabled' };
    if (!this.supported()) return { status: 'unsupported' };
    if (this.foreground()) return { status: 'foreground' };
    try {
      return await this.show({ id: 'noah-' + key, groupId: 'noah-attention', title: 'Noah 需要你关注', body: kinds[event.kind], silent: true },
        () => this.open(event.conversationId));
    } catch { return { status: 'failed' }; }
  }
  testNotification(conversationId) {
    if (conversationId !== null && (typeof conversationId !== 'string' || !uuid.test(conversationId))) {
      return Promise.reject(new Error('测试提醒只能包含讨论标识或 null'));
    }
    if (this.pendingTest) return this.pendingTest;
    if (!this.supported()) return Promise.resolve({ status: 'unsupported' });
    // An explicit one-time test bypasses the opt-in/foreground policy, but must
    // neither opt the owner in nor consume or replay any real attention event.
    this.pendingTest = Promise.resolve().then(() => this.show({
      id: 'noah-test-' + randomUUID(), groupId: 'noah-notification-test',
      title: '来自 Noah 的测试提醒',
      body: conversationId ? '系统提醒测试，点击回到当前讨论。' : '系统提醒测试，点击回到 Noah。',
      silent: true,
    }, () => this.open(conversationId))).catch(() => ({ status: 'failed' })).finally(() => { this.pendingTest = undefined; });
    return this.pendingTest;
  }
  conversationForNotification(id) {
    if (typeof id !== 'string' || !/^noah-[a-f0-9]{64}$/.test(id)) return undefined;
    const key = id.slice(5);
    return Object.hasOwn(this.state.observed, key) ? this.state.observed[key] : undefined;
  }
  conversationFromLaunchInfo(launchInfo) {
    // Electron forwards macOS UNNotificationResponse on cold start. Only a
    // default click on our persisted alert is navigation, never a dismissal.
    if (launchInfo?.actionIdentifier !== 'com.apple.UNNotificationDefaultActionIdentifier') return undefined;
    return this.conversationForNotification(launchInfo.identifier);
  }
}

module.exports = { DesktopNotifications, validateEvent };
