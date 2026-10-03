import { createHash, randomUUID } from 'node:crypto';
import type { NativeDelivery } from './native-bridge.ts';

export const NOAH_DISCUSSION_TYPE = 'noah.discussion.v1';
export const NOAH_WAKE_TYPE = 'noah.wake.v1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface BridgeEntry { id: string; type: string; customType?: string; content?: unknown; details?: any; message?: { role?: string; stopReason?: string } }
export interface PiBridgeHost {
  nativeSessionId(): string;
  projectDir(): string;
  label(): string;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  entries(): readonly BridgeEntry[];
  contextEntries(): readonly BridgeEntry[];
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }, options: { triggerTurn: boolean; deliverAs?: 'followUp' }): void;
  notify(message: string, error?: boolean): void;
}
export type BridgeTransport = (path: string, credential: string, input: unknown) => Promise<any>;
export class BridgeHttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function localBridgeTransport(url: string): BridgeTransport {
  const base = new URL(url);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Noah 只接受本机 HTTP broker 地址');
  return async (path, credential, input) => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(8000), redirect: 'error' });
    const result = await response.json() as any;
    if (!response.ok) throw new BridgeHttpError(response.status, typeof result.error === 'string' ? result.error : 'Noah 原会话连接失败');
    return result;
  };
}

/** Runs inside the existing pi process. No private entry ever leaves this object. */
export class PiBridgeClient {
  readonly host: PiBridgeHost;
  readonly transport: BridgeTransport;
  readonly runtimeId = randomUUID();
  bindingId = '';
  generation = 0;
  private credential = '';
  private boundSessionId = '';
  private stopped = true;
  private paused = false;
  private busyTick = false;
  private waitingUser = false;
  private recovering = true;
  private submitted = new Map<string, number>();
  private pendingReceipts = new Map<string, { deliveryId: string; entryId: string; contentHash: string; envelopeHash: string; contextPresent: boolean }>();
  private pendingUncertain = new Set<string>();
  private wakeInFlight: { id: string; generation: number; contentHash: string; settled: boolean; startedAt: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastError = '';
  constructor(host: PiBridgeHost, transport: BridgeTransport) { this.host = host; this.transport = transport; }
  get connected() { return !this.stopped && !!this.credential; }
  private valid() { return this.connected && !this.paused && this.boundSessionId === this.host.nativeSessionId(); }
  async connect(joinToken: string, options: { poll?: boolean } = {}) {
    if (this.connected) await this.disconnect();
    this.boundSessionId = this.host.nativeSessionId();
    const result = await this.transport('/api/bridge/register', '', { joinToken, nativeSessionId: this.boundSessionId, runtimeId: this.runtimeId, projectDir: this.host.projectDir(), label: this.host.label(), idle: this.host.isIdle(), capabilities: 'pi-extension-v1' });
    // Session switching while registration is in flight cannot authorize its successor.
    this.bindingId = result.bindingId; this.credential = result.credential; this.generation = result.generation;
    this.stopped = false; this.paused = false; this.recovering = true;
    if (this.boundSessionId !== this.host.nativeSessionId()) { await this.disconnect(); throw new Error('pi 会话已切换，请在目标会话重新连接'); }
    this.host.notify('Noah 已连接此 pi 原会话。仅显式发布的消息会共享。');
    if (options.poll !== false) { this.timer = setInterval(() => { void this.tick(); }, 1500); this.timer.unref?.(); }
    return { bindingId: this.bindingId, generation: this.generation };
  }
  private call(path: string, input: Record<string, unknown> = {}) { return this.transport(`/api/bridge/${path}`, this.credential, { generation: this.generation, ...input }); }
  private async reportUncertain(wakeId: string) {
    this.pendingUncertain.add(wakeId);
    await this.call('wake-uncertain', { wakeId });
    this.pendingUncertain.delete(wakeId);
  }
  private async heartbeat() {
    const status = this.waitingUser ? 'waiting_user' : this.host.isIdle() && !this.host.hasPendingMessages() ? 'idle' : 'busy';
    try { await this.call('heartbeat', { nativeSessionId: this.boundSessionId, status }); }
    catch (error) {
      if (!(error instanceof BridgeHttpError) || error.status !== 409) throw error;
      const result = await this.call('reconnect', { nativeSessionId: this.boundSessionId, runtimeId: this.runtimeId });
      if (!this.valid()) return;
      this.generation = result.generation; this.recovering = true;
      // A previous model invocation is not safe to repeat after losing its lease.
      this.wakeInFlight = undefined;
      await this.call('heartbeat', { nativeSessionId: this.boundSessionId, status });
    }
  }
  private ownEntries() {
    return this.host.entries().filter(e => e.type === 'custom_message' && e.customType === NOAH_DISCUSSION_TYPE && e.details?.schemaVersion === 1 && e.details?.bindingId === this.bindingId && e.details?.nativeSessionId === this.boundSessionId);
  }
  private observed(delivery: NativeDelivery) {
    const entries = this.ownEntries().filter(e => e.details?.deliveryId === delivery.deliveryId);
    if (!entries.length) return undefined;
    if (entries.length !== 1) throw new Error('同一 Noah 消息存在多条原生记录，已暂停，需核对');
    const entry = entries[0], d = entry.details;
    if (d.messageId !== delivery.messageId || d.deliverySeq !== delivery.deliverySeq || d.contentHash !== delivery.contentHash || d.envelopeHash !== delivery.envelopeHash || typeof entry.content !== 'string' || hash(entry.content) !== delivery.envelopeHash) throw new Error('Noah 原生消息的 ID、顺序或正文 hash 不一致');
    return { deliveryId: delivery.deliveryId, entryId: entry.id, contentHash: delivery.contentHash, envelopeHash: delivery.envelopeHash, contextPresent: this.host.contextEntries().some(e => e.id === entry.id) };
  }
  async tick() {
    if (!this.connected || this.paused || this.busyTick) return;
    if (this.host.nativeSessionId() !== this.boundSessionId) { await this.disconnect(); return; }
    this.busyTick = true;
    try {
      await this.heartbeat();
      if (!this.valid()) return;
      for (const id of this.pendingUncertain) await this.reportUncertain(id);
      if (this.recovering && (!this.host.isIdle() || this.host.hasPendingMessages())) return;
      this.recovering = false;
      const lease = this.generation;
      if (this.pendingReceipts.size) {
        const retry = [...this.pendingReceipts.values()];
        await this.call('receipt', { receipts: retry });
        if (!this.valid() || lease !== this.generation) return;
        for (const r of retry) { this.submitted.delete(r.deliveryId); this.pendingReceipts.delete(r.deliveryId); }
      }
      const { deliveries } = await this.call('inbox', { after: 0 }) as { deliveries: NativeDelivery[] };
      if (!this.valid() || lease !== this.generation) return;
      const receipts = [];
      let missingContext = false;
      let previousSeq = 0;
      for (const delivery of deliveries) {
        if (delivery.deliverySeq <= previousSeq) throw new Error('Noah 消息顺序不一致，已暂停追加');
        previousSeq = delivery.deliverySeq;
        if (hash(delivery.content) !== delivery.contentHash || hash(delivery.envelope) !== delivery.envelopeHash) throw new Error('Noah 入站消息校验失败');
        let seen = this.observed(delivery);
        if (!seen && !this.submitted.has(delivery.deliveryId)) {
          this.submitted.set(delivery.deliveryId, Date.now());
          this.host.sendMessage({ customType: NOAH_DISCUSSION_TYPE, content: delivery.envelope, display: true, details: { schemaVersion: 1, bindingId: this.bindingId, nativeSessionId: this.boundSessionId, deliveryId: delivery.deliveryId, deliverySeq: delivery.deliverySeq, conversationId: delivery.conversationId, messageId: delivery.messageId, threadSeq: delivery.threadSeq, senderPeerId: delivery.sender, recipientPeerId: delivery.recipient, contentHash: delivery.contentHash, envelopeHash: delivery.envelopeHash, runtimeGeneration: lease } }, { triggerTurn: false });
          seen = this.observed(delivery);
        }
        // sendMessage returns void: only a matching actual entry is an observation.
        if (seen) { receipts.push(seen); this.pendingReceipts.set(seen.deliveryId, seen); if (!seen.contextPresent) { missingContext = true; break; } }
        else if (this.host.isIdle() && !this.host.hasPendingMessages() && Date.now() - (this.submitted.get(delivery.deliveryId) || Date.now()) > 10000) throw new Error('pi 未能确认追加 Noah 消息；保留消息并暂停，不自动重复追加');
      }
      if (receipts.length) {
        await this.call('receipt', { receipts });
        if (!this.valid() || lease !== this.generation) return;
        for (const r of receipts) { this.submitted.delete(r.deliveryId); this.pendingReceipts.delete(r.deliveryId); }
      }
      if (missingContext) throw new Error('Noah 消息存在于历史，但不在当前上下文；已暂停自动唤醒');
      if (this.wakeInFlight?.settled) {
        const wake = this.wakeInFlight;
        const entry = this.host.entries().find(e => e.type === 'custom_message' && e.customType === NOAH_WAKE_TYPE && e.details?.wakeId === wake.id && e.details?.bindingId === this.bindingId && typeof e.content === 'string' && hash(e.content) === wake.contentHash);
        if (entry && wake.generation === this.generation) { await this.call('settled', { wakeId: wake.id, wakeEntryId: entry.id }); this.wakeInFlight = undefined; }
      }
      if (this.wakeInFlight && this.host.isIdle() && !this.host.hasPendingMessages() && !this.waitingUser && Date.now() - this.wakeInFlight.startedAt > 15000) {
        await this.reportUncertain(this.wakeInFlight.id);
        this.wakeInFlight = undefined;
        this.host.notify('Noah 未收到匹配的原生唤醒完成证据，请在 Noah 中核对；不会自动重复启动。', true);
      }
      if (!this.valid() || lease !== this.generation || this.wakeInFlight || !this.host.isIdle() || this.host.hasPendingMessages() || this.waitingUser || this.submitted.size) return;
      const { wake } = await this.call('wake');
      if (!wake || !this.valid() || lease !== this.generation || !this.host.isIdle() || this.waitingUser || this.host.hasPendingMessages()) return;
      try { await this.call('wake-start', { wakeId: wake.id }); }
      catch (error) {
        // The request may already have committed. Never retry this start operation.
        try { await this.reportUncertain(wake.id); } catch {}
        throw error;
      }
      if (!this.valid() || lease !== this.generation) return;
      this.wakeInFlight = { id: wake.id, generation: lease, contentHash: hash(wake.content), settled: false, startedAt: Date.now() };
      try { this.host.sendMessage({ customType: NOAH_WAKE_TYPE, content: wake.content, display: true, details: { schemaVersion: 1, bindingId: this.bindingId, nativeSessionId: this.boundSessionId, wakeId: wake.id, runtimeGeneration: lease } }, { triggerTurn: true, deliverAs: 'followUp' }); }
      catch (error) { try { await this.reportUncertain(wake.id); } catch {} this.wakeInFlight = undefined; throw error; }
      this.lastError = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Noah 连接中断';
      if (message !== this.lastError) { this.host.notify(message, true); this.lastError = message; }
      if (error instanceof BridgeHttpError) {
        if (error.status === 401) { this.stopped = true; if (this.timer) clearInterval(this.timer); }
      } else if (!(error instanceof TypeError) && !(error instanceof DOMException)) {
        await this.pause();
      }
    } finally { this.busyTick = false; }
  }
  async agentSettled() {
    const wake = this.wakeInFlight;
    if (wake && this.valid() && wake.generation === this.generation) {
      // pi also emits agent_settled after abort/error. Inspect only the local
      // assistant terminal record following this wake; no private content leaves
      // the process and an older successful turn cannot complete a new wake.
      const entries = this.host.entries();
      const index = entries.findIndex(e => e.type === 'custom_message' && e.customType === NOAH_WAKE_TYPE
        && e.details?.wakeId === wake.id && e.details?.bindingId === this.bindingId
        && e.details?.nativeSessionId === this.boundSessionId && e.details?.runtimeGeneration === wake.generation
        && typeof e.content === 'string' && hash(e.content) === wake.contentHash);
      const last = index < 0 ? undefined : entries.slice(index + 1).findLast(e => e.type === 'message' && e.message?.role === 'assistant');
      if (last?.message?.stopReason === 'stop' || last?.message?.stopReason === 'length') wake.settled = true;
      else {
        this.pendingUncertain.add(wake.id);
        this.wakeInFlight = undefined;
        this.host.notify('Noah 本次原生回合已中断、失败或缺少完成证据，请在 Noah 中核对；不会自动重复启动。', true);
      }
    }
    await this.tick();
  }
  setWaitingUser(value: boolean) { this.waitingUser = value; }
  async pause() {
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
    if (this.credential) { try { await this.call('pause'); } catch {} }
  }
  async disconnect() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const credential = this.credential, gen = this.generation;
    this.credential = ''; this.generation++;
    if (credential) { try { await this.transport('/api/bridge/disconnect', credential, { generation: gen }); } catch {} }
    this.submitted.clear(); this.pendingReceipts.clear(); this.pendingUncertain.clear(); this.wakeInFlight = undefined;
  }
  async tool(name: string, args: Record<string, unknown>) {
    if (!this.valid()) throw new Error('请先在此原 pi 会话执行 /noah-connect');
    return this.call('tool', { name, args });
  }
}
