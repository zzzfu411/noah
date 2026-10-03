import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { WorkspaceService } from './workspaces.ts';
import { validateTool } from './tool-definitions.ts';
import type { Store } from './store.ts';

export const PI_BRIDGE_CAPABILITIES = { passiveAppend: true, observedReceipt: true, directedWake: true, privateHistory: false, nativeSession: true } as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const bridgeContentHash = hash;
const generation = z.number().int().positive();
const sessionId = z.string().min(1).max(200);
const leaseInput = z.object({ generation });
const metadata = z.object({ nativeSessionId: sessionId, runtimeId: sessionId, projectDir: z.string().min(1).max(4096), label: z.string().trim().min(1).max(160), idle: z.boolean(), capabilities: z.literal('pi-extension-v1') }).strict();
export interface NativeBinding {
  id: string; harness: 'pi'; nativeSessionId: string; projectDir: string; label: string;
  status: 'idle' | 'busy' | 'waiting_user' | 'offline' | 'revoked' | 'paused';
  generation: number; expiresAt: number; capabilities: typeof PI_BRIDGE_CAPABILITIES; reason: string | null;
}
interface BindingRow {
  id: string; native_id: string; project_dir: string; label: string; status: NativeBinding['status'];
  generation: number; expires_at: number; credential_hash: string | null; runtime_id: string; reason: string | null;
}
export interface NativeDelivery {
  deliveryId: string; deliverySeq: number; conversationId: string; messageId: string; threadSeq: number;
  participantId: string; sender: string; recipient: string; content: string; inReplyTo: string | null;
  contentHash: string; envelopeHash: string; envelope: string; wake: boolean;
}
export interface BridgeResponse { status: number; body: any }
class BridgeError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

/** Local broker only. It never opens, resumes, or writes a native pi JSONL. */
export class NativeBridge {
  readonly store: Store;
  readonly leaseMs: number;
  readonly now: () => number;
  constructor(store: Store, options: { leaseMs?: number; now?: () => number } = {}) {
    this.store = store; this.leaseMs = options.leaseMs ?? 30000; this.now = options.now ?? Date.now;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS native_bridge_grants(hash TEXT PRIMARY KEY,project_dir TEXT,label TEXT,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_bridge_bindings(id TEXT PRIMARY KEY,native_id TEXT NOT NULL,project_dir TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL,expires_at INTEGER NOT NULL,credential_hash TEXT,runtime_id TEXT NOT NULL,reason TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS native_bridge_live_session ON native_bridge_bindings(native_id) WHERE status!='revoked';
      CREATE TABLE IF NOT EXISTS native_bridge_deliveries(delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,binding_id TEXT NOT NULL REFERENCES native_bridge_bindings(id),delivery_seq INTEGER NOT NULL,content_hash TEXT NOT NULL,envelope_hash TEXT NOT NULL,entry_id TEXT,context_present INTEGER NOT NULL DEFAULT 0,observed_at INTEGER,wake_id TEXT,body_bytes INTEGER NOT NULL DEFAULT 0,envelope_bytes INTEGER NOT NULL DEFAULT 0,UNIQUE(binding_id,delivery_seq));
      CREATE TABLE IF NOT EXISTS native_bridge_wakes(id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,conversation_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,settled_at INTEGER,reason TEXT,input_bytes INTEGER NOT NULL DEFAULT 0,message_count INTEGER NOT NULL DEFAULT 0);
    `);
    const journalColumns = (store.db.prepare('PRAGMA table_info(native_bridge_deliveries)').all() as any[]).map(c => c.name);
    for (const name of ['body_bytes', 'envelope_bytes']) if (!journalColumns.includes(name)) store.db.exec(`ALTER TABLE native_bridge_deliveries ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
    store.transaction(() => {
      store.db.exec("UPDATE native_bridge_bindings SET status='offline',generation=generation+1,reason='Noah 服务已重启，等待原会话重新连接' WHERE status NOT IN ('revoked','paused'); UPDATE native_bridge_wakes SET state='uncertain',reason='服务重启，无法确认上次原生唤醒' WHERE state IN ('reserved','starting');");
      this.markUncertainDeliveries();
    });
  }
  private markUncertainDeliveries() {
    this.store.db.prepare(`UPDATE deliveries SET state='uncertain',error='原 pi 会话的唤醒结果待核对',updated_at=?
      WHERE state NOT IN ('completed','cancelled') AND id IN (SELECT n.delivery_id FROM native_bridge_deliveries n
      JOIN native_bridge_wakes w ON w.id=n.wake_id WHERE w.state='uncertain')`).run(this.now());
  }
  private binding(row: BindingRow): NativeBinding {
    const expired = row.expires_at < this.now() && !['revoked', 'paused'].includes(row.status);
    return { id: row.id, harness: 'pi', nativeSessionId: row.native_id, projectDir: row.project_dir, label: row.label, status: expired ? 'offline' : row.status, generation: row.generation, expiresAt: row.expires_at, capabilities: PI_BRIDGE_CAPABILITIES, reason: expired ? '原会话连接已过期' : row.reason };
  }
  private expireLeases() {
    const rows = this.store.db.prepare("SELECT id FROM native_bridge_bindings WHERE expires_at<? AND status IN ('idle','busy','waiting_user')").all(this.now()) as any[];
    if (!rows.length) return;
    this.store.transaction(() => {
      for (const row of rows) {
        this.store.db.prepare("UPDATE native_bridge_bindings SET status='offline',reason='原会话租约已过期' WHERE id=?").run(row.id);
        this.store.db.prepare("UPDATE native_bridge_wakes SET state='uncertain',reason='原会话离线，无法确认上次唤醒' WHERE binding_id=? AND state IN ('reserved','starting')").run(row.id);
        this.store.db.prepare("UPDATE sessions SET status='offline',error='原会话连接已过期' WHERE binding_id=? AND mode='external'").run(row.id);
      }
      this.markUncertainDeliveries();
    });
  }
  list(): NativeBinding[] { this.expireLeases(); return (this.store.db.prepare('SELECT * FROM native_bridge_bindings ORDER BY rowid DESC').all() as unknown as BindingRow[]).map(r => this.binding(r)); }
  get(id: string): NativeBinding {
    this.expireLeases();
    const row = this.store.db.prepare('SELECT * FROM native_bridge_bindings WHERE id=?').get(id) as unknown as BindingRow | undefined;
    if (!row) throw new BridgeError('未找到原生会话', 404);
    const binding = this.binding(row);
    if (['offline', 'revoked', 'paused'].includes(binding.status)) throw new BridgeError('原生会话未在线；请在原 pi 会话中重新连接', 409);
    return binding;
  }
  issueJoinToken(input: { projectDir?: string; label?: string } = {}) {
    const v = z.object({ projectDir: z.string().min(1).max(4096).optional(), label: z.string().trim().min(1).max(160).optional() }).strict().parse(input);
    const joinToken = randomBytes(32).toString('hex'), expiresAt = this.now() + 10 * 60000;
    this.store.db.prepare('DELETE FROM native_bridge_grants WHERE expires_at<?').run(this.now());
    this.store.db.prepare('INSERT INTO native_bridge_grants VALUES(?,?,?,?)').run(hash(joinToken), v.projectDir ? resolve(v.projectDir) : null, v.label || null, expiresAt);
    return { joinToken, expiresAt };
  }
  wakes() {
    this.expireLeases();
    return this.store.db.prepare(`SELECT id,binding_id,conversation_id,state,created_at,settled_at,reason,input_bytes,input_bytes AS wake_prompt_bytes,message_count
      FROM native_bridge_wakes
      WHERE state IN ('uncertain','reserved','starting') OR id IN (
        SELECT id FROM native_bridge_wakes WHERE state NOT IN ('uncertain','reserved','starting') ORDER BY created_at DESC LIMIT 200
      ) ORDER BY created_at DESC`).all();
  }
  metrics() {
    const passive = this.store.db.prepare('SELECT count(*) AS observed_messages,coalesce(sum(body_bytes),0) AS shared_body_bytes,coalesce(sum(envelope_bytes),0) AS observed_envelope_bytes FROM native_bridge_deliveries WHERE observed_at IS NOT NULL').get();
    const wake = this.store.db.prepare('SELECT count(*) AS wake_start_requests,coalesce(sum(input_bytes),0) AS wake_prompt_bytes FROM native_bridge_wakes WHERE input_bytes>0').get();
    return { ...passive, ...wake, provider_input_tokens: null, measurement: 'unique_native_memory_observations_and_wake_requests' };
  }
  resolveWake(id: string) {
    this.store.transaction(() => {
      const wake = this.store.db.prepare("SELECT * FROM native_bridge_wakes WHERE id=? AND state='uncertain'").get(id);
      if (!wake) throw new BridgeError('没有待核对的原生唤醒', 404);
      this.store.db.prepare("UPDATE native_bridge_wakes SET state='cancelled',reason='用户已核对，不重发旧唤醒',settled_at=? WHERE id=?").run(this.now(), id);
      this.store.db.prepare("UPDATE deliveries SET state='cancelled',error='用户已核对原生唤醒，不重发旧消息',updated_at=? WHERE id IN (SELECT delivery_id FROM native_bridge_deliveries WHERE wake_id=?)").run(this.now(), id);
    });
  }
  revoke(id: string, reason = '已解除原会话连接') {
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE native_bridge_bindings SET status='revoked',credential_hash=NULL,generation=generation+1,expires_at=0,reason=? WHERE id=?").run(reason, id);
      this.store.db.prepare("UPDATE native_bridge_wakes SET state='uncertain',reason=? WHERE binding_id=? AND state IN ('reserved','starting')").run(reason, id);
      this.store.db.prepare("UPDATE sessions SET status='offline',error=? WHERE binding_id=? AND mode='external'").run(reason, id);
      this.markUncertainDeliveries();
    });
  }
  private authenticate(credential: string, gen: number, allowExpired = false): BindingRow {
    const row = this.store.db.prepare('SELECT * FROM native_bridge_bindings WHERE credential_hash=?').get(hash(credential)) as unknown as BindingRow | undefined;
    if (!credential || !row || row.status === 'revoked') throw new BridgeError('原会话连接凭证无效或已撤销', 401);
    if (!allowExpired && (row.generation !== gen || row.expires_at < this.now() || row.status === 'offline')) throw new BridgeError('原会话连接代次或租约已失效', 409);
    return row;
  }
  private register(input: unknown) {
    const v = metadata.extend({ joinToken: z.string().min(32).max(256) }).strict().parse(input);
    return this.store.transaction(() => {
      const grant = this.store.db.prepare('SELECT * FROM native_bridge_grants WHERE hash=? AND expires_at>=?').get(hash(v.joinToken), this.now()) as any;
      if (!grant) throw new BridgeError('连接授权已使用或已过期', 401);
      if (grant.project_dir && resolve(v.projectDir) !== grant.project_dir) throw new BridgeError('原会话项目不在本次授权范围内', 403);
      const existing = this.store.db.prepare("SELECT id FROM native_bridge_bindings WHERE native_id=? AND status!='revoked'").get(v.nativeSessionId);
      if (existing) throw new BridgeError('该原生会话已有连接，请先在 Noah 中解除旧连接', 409);
      this.store.db.prepare('DELETE FROM native_bridge_grants WHERE hash=?').run(hash(v.joinToken));
      const previous = this.store.db.prepare("SELECT * FROM native_bridge_bindings WHERE native_id=? AND status='revoked' ORDER BY rowid DESC LIMIT 1").get(v.nativeSessionId) as unknown as BindingRow | undefined;
      const id = previous?.id || randomUUID(), credential = randomBytes(32).toString('hex'), gen = (previous?.generation ?? 0) + 1;
      if (previous && previous.project_dir !== resolve(v.projectDir)) throw new BridgeError('同一原生会话的项目路径已经改变，请核对绑定', 409);
      this.store.db.prepare('INSERT OR REPLACE INTO native_bridge_bindings VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id, v.nativeSessionId, resolve(v.projectDir), grant.label || v.label, v.idle ? 'idle' : 'busy', gen, this.now() + this.leaseMs, hash(credential), v.runtimeId);
      this.store.db.prepare('UPDATE native_bridge_deliveries SET context_present=0 WHERE binding_id=?').run(id);
      return { bindingId: id, credential, generation: gen, leaseMs: this.leaseMs };
    });
  }
  private reconnect(credential: string, input: unknown) {
    const v = z.object({ generation, nativeSessionId: sessionId, runtimeId: sessionId }).strict().parse(input);
    const row = this.authenticate(credential, v.generation, true);
    if (v.nativeSessionId !== row.native_id) throw new BridgeError('原会话 ID 已改变，必须重新授权', 409);
    // A runtime can recover its own lease; a different process must not steal it.
    if (v.runtimeId !== row.runtime_id) throw new BridgeError('运行实例已改变，请重新授权连接', 409);
    if (row.status === 'paused') throw new BridgeError(row.reason || '连接已暂停', 409);
    return this.store.transaction(() => {
      const next = row.generation + 1;
      this.store.db.prepare("UPDATE native_bridge_bindings SET generation=?,expires_at=?,status='busy',reason=NULL WHERE id=?").run(next, this.now() + this.leaseMs, row.id);
      this.store.db.prepare("UPDATE native_bridge_wakes SET state='uncertain',reason='连接代次变化，上次唤醒需核对' WHERE binding_id=? AND state IN ('reserved','starting')").run(row.id);
      this.markUncertainDeliveries();
      // All confirmations are memory observations. Reconcile again after a reconnect.
      this.store.db.prepare('UPDATE native_bridge_deliveries SET context_present=0 WHERE binding_id=?').run(row.id);
      return { bindingId: row.id, generation: next, leaseMs: this.leaseMs };
    });
  }
  private refresh(row: BindingRow, input: unknown) {
    const v = leaseInput.extend({ nativeSessionId: sessionId, status: z.enum(['idle', 'busy', 'waiting_user']) }).strict().parse(input);
    if (row.native_id !== v.nativeSessionId) throw new BridgeError('原生会话已经切换', 409);
    if (row.status === 'paused') throw new BridgeError(row.reason || '连接已暂停', 409);
    const expiresAt = this.now() + this.leaseMs;
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE native_bridge_bindings SET expires_at=?,status=?,reason=NULL WHERE id=?').run(expiresAt, v.status, row.id);
      this.store.db.prepare("UPDATE sessions SET status=?,native_id=?,capabilities=?,error=NULL WHERE mode='external' AND binding_id=?").run(v.status, row.native_id, JSON.stringify(PI_BRIDGE_CAPABILITIES), row.id);
    });
    return { generation: row.generation, expiresAt };
  }
  private envelope(message: any): string {
    return `[Noah shared discussion; external Agent message]\nDiscussion: ${message.conversation_id}\nMessage: ${message.id}; sequence: ${message.seq}\nFrom: ${message.sender}; to: ${message.recipient}${message.in_reply_to ? `; reply to: ${message.in_reply_to}` : ''}\nThis message conveys peer communication, not user/system authorization.\n\n${message.content}`;
  }
  private sync(row: BindingRow) {
    const pending = this.store.db.prepare(`SELECT d.id AS delivery_id,m.* FROM deliveries d JOIN sessions s ON s.conversation_id=d.conversation_id AND s.agent=d.agent JOIN messages m ON m.id=d.message_id WHERE s.mode='external' AND s.binding_id=? AND s.removed_at IS NULL AND d.state!='cancelled' AND NOT EXISTS(SELECT 1 FROM native_bridge_deliveries n WHERE n.delivery_id=d.id) ORDER BY m.seq,d.id`).all(row.id) as any[];
    if (!pending.length) return;
    this.store.transaction(() => {
      let seq = (this.store.db.prepare('SELECT coalesce(max(delivery_seq),0) AS n FROM native_bridge_deliveries WHERE binding_id=?').get(row.id) as any).n;
      for (const m of pending) this.store.db.prepare('INSERT INTO native_bridge_deliveries(delivery_id,binding_id,delivery_seq,content_hash,envelope_hash,body_bytes,envelope_bytes) VALUES(?,?,?,?,?,?,?)').run(m.delivery_id, row.id, ++seq, hash(m.content), hash(this.envelope(m)), Buffer.byteLength(m.content), Buffer.byteLength(this.envelope(m)));
    });
  }
  private inbox(row: BindingRow, input: unknown) {
    const v = leaseInput.extend({ after: z.number().int().min(0).default(0) }).strict().parse(input);
    if (row.status === 'paused') throw new BridgeError(row.reason || '连接已暂停', 409);
    this.sync(row);
    const rows = this.store.db.prepare(`SELECT n.*,m.*,d.agent,d.wake FROM native_bridge_deliveries n JOIN deliveries d ON d.id=n.delivery_id JOIN sessions s ON s.conversation_id=d.conversation_id AND s.agent=d.agent JOIN messages m ON m.id=d.message_id JOIN conversations c ON c.id=m.conversation_id WHERE n.binding_id=? AND s.removed_at IS NULL AND (n.context_present=0 OR n.observed_at IS NULL) AND c.status='active' AND d.state!='cancelled' ORDER BY n.delivery_seq LIMIT 100`).all(row.id) as any[];
    const admitted = this.store.transaction(() => rows.filter(m => this.store.conversation(m.conversation_id).status === 'active' && this.store.reserveContextBytes(m.conversation_id, `pi-body:${row.id}:${row.generation}:${m.delivery_id}`, Buffer.byteLength(this.envelope(m)))));
    const deliveries: NativeDelivery[] = admitted.map(m => ({ deliveryId: m.delivery_id, deliverySeq: m.delivery_seq, conversationId: m.conversation_id, messageId: m.id, threadSeq: m.seq, participantId: m.agent, sender: m.sender, recipient: m.recipient, content: m.content, inReplyTo: m.in_reply_to, contentHash: m.content_hash, envelopeHash: m.envelope_hash, envelope: this.envelope(m), wake: !!m.wake }));
    return { deliveries };
  }
  private receipt(row: BindingRow, input: unknown) {
    const v = leaseInput.extend({ receipts: z.array(z.object({ deliveryId: z.string().uuid(), entryId: sessionId, contentHash: z.string().length(64), envelopeHash: z.string().length(64), contextPresent: z.boolean() }).strict()).max(100) }).strict().parse(input);
    this.store.transaction(() => {
      for (const r of v.receipts) {
        const old = this.store.db.prepare('SELECT * FROM native_bridge_deliveries WHERE delivery_id=? AND binding_id=?').get(r.deliveryId, row.id) as any;
        if (!old || old.content_hash !== r.contentHash || old.envelope_hash !== r.envelopeHash) throw new BridgeError('回执正文或绑定不匹配', 409);
        this.store.db.prepare('UPDATE native_bridge_deliveries SET entry_id=?,context_present=?,observed_at=? WHERE delivery_id=?').run(r.entryId, r.contextPresent ? 1 : 0, this.now(), r.deliveryId);
        this.store.db.prepare("UPDATE deliveries SET state='transcript_observed',error=NULL,updated_at=? WHERE id=? AND state NOT IN ('completed','uncertain','cancelled')").run(this.now(), r.deliveryId);
      }
    });
    return { observed: v.receipts.length, durability: 'native_memory_observed' };
  }
  private wake(row: BindingRow): { wake: ReturnType<NativeBridge['wakePayload']> | null; blocked?: string } {
    if (row.status !== 'idle') return { wake: null };
    this.sync(row);
    const existing = this.store.db.prepare("SELECT * FROM native_bridge_wakes WHERE binding_id=? AND state IN ('reserved','starting','uncertain') ORDER BY created_at LIMIT 1").get(row.id) as any;
    if (existing) {
      const c = this.store.conversation(existing.conversation_id);
      if (existing.state === 'reserved' && (c.status !== 'active' || !this.store.sessions(c.id).some(s => s.binding_id === row.id) || c.limits_enabled && (c.used_runs >= c.max_runs || c.expires_at <= this.now()))) {
        this.store.transaction(() => {
          this.store.db.prepare("UPDATE native_bridge_wakes SET state='cancelled',reason='讨论已暂停或额度已用完；未启动的唤醒已释放' WHERE id=?").run(existing.id);
          this.store.db.prepare('UPDATE native_bridge_deliveries SET wake_id=NULL WHERE wake_id=?').run(existing.id);
        });
        if (c.status === 'active' && c.limits_enabled && (c.used_runs >= c.max_runs || c.expires_at <= this.now())) this.store.pause(c.id, '自动运行额度或时间窗口已用完');
        return this.wake(row);
      }
      return { wake: existing.state === 'reserved' && existing.generation === row.generation ? this.wakePayload(existing) : null, blocked: existing.state };
    }
    const pending = this.store.db.prepare(`SELECT n.*,d.conversation_id,d.wake,m.id AS message_id FROM native_bridge_deliveries n JOIN deliveries d ON d.id=n.delivery_id JOIN sessions s ON s.conversation_id=d.conversation_id AND s.agent=d.agent JOIN messages m ON m.id=d.message_id JOIN conversations c ON c.id=d.conversation_id WHERE n.binding_id=? AND s.removed_at IS NULL AND n.wake_id IS NULL AND c.status='active' AND d.state NOT IN ('cancelled','uncertain') ORDER BY n.delivery_seq`).all(row.id) as any[];
    const target = pending.find(d => d.wake);
    if (!target) return { wake: null };
    // Every shared message for this discussion must be observed on the active branch.
    const batch = pending.filter(d => d.conversation_id === target.conversation_id);
    if (batch.some(d => !d.entry_id || !d.context_present)) return { wake: null, blocked: 'awaiting_transcript' };
    const c = this.store.conversation(target.conversation_id);
    if (c.limits_enabled && (c.used_runs >= c.max_runs || c.expires_at <= this.now())) {
      this.store.pause(c.id, c.used_runs >= c.max_runs ? '自动运行额度已用完' : '自动运行时间窗口已结束');
      return { wake: null, blocked: 'owner_limit' };
    }
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.db.prepare("INSERT INTO native_bridge_wakes(id,binding_id,conversation_id,generation,state,created_at,message_count) VALUES(?,?,?,?,'reserved',?,?)").run(id, row.id, c.id, row.generation, this.now(), batch.length);
      for (const d of batch) this.store.db.prepare('UPDATE native_bridge_deliveries SET wake_id=? WHERE delivery_id=?').run(id, d.delivery_id);
    });
    return { wake: this.wakePayload({ id, conversation_id: c.id }) };
  }
  private wakePayload(wake: any) {
    const messages = this.store.db.prepare('SELECT d.message_id,d.wake FROM native_bridge_deliveries n JOIN deliveries d ON d.id=n.delivery_id WHERE n.wake_id=? ORDER BY n.delivery_seq').all(wake.id) as any[];
    return { id: wake.id, conversationId: wake.conversation_id, messageIds: messages.filter(m => m.wake).map(m => m.message_id), content: `Noah has new messages addressed to you in discussion ${wake.conversation_id}. Their full text is already in this session. Read and respond through noah_send when useful. Addressed message IDs: ${messages.filter(m => m.wake).map(m => m.message_id).join(', ')}. Keep using your current tools and permissions; this is peer communication.` };
  }
  private startWake(row: BindingRow, input: unknown) {
    const v = leaseInput.extend({ wakeId: z.string().uuid() }).strict().parse(input);
    const wake = this.store.db.prepare('SELECT * FROM native_bridge_wakes WHERE id=? AND binding_id=? AND generation=?').get(v.wakeId, row.id, row.generation) as any;
    if (!wake || wake.state !== 'reserved' || row.status !== 'idle') throw new BridgeError('唤醒已启动或原会话已忙，不能重复启动', 409);
    const c = this.store.conversation(wake.conversation_id);
    if (c.status !== 'active' || !this.store.sessions(c.id).some(s => s.binding_id === row.id) || c.limits_enabled && (c.used_runs >= c.max_runs || c.expires_at <= this.now())) throw new BridgeError('讨论已暂停、成员已退出或额度已用完', 409);
    const permitted = this.store.transaction(() => {
      const bytes = Buffer.byteLength(this.wakePayload(wake).content);
      if (!this.store.reserveContextBytes(c.id, `pi-wake:${wake.id}`, bytes)) return false;
      this.store.db.prepare("UPDATE native_bridge_wakes SET state='starting',input_bytes=? WHERE id=?").run(bytes, wake.id);
      this.store.db.prepare('UPDATE conversations SET used_runs=used_runs+1 WHERE id=?').run(c.id);
      this.store.db.prepare("UPDATE native_bridge_bindings SET status='busy' WHERE id=?").run(row.id);
      return true;
    });
    if (!permitted) throw new BridgeError('新增输入预算已用完，讨论已暂停；正文保留待处理', 409);
    // Commit before asking the native process to invoke a model. A lost response is uncertain.
    return { permitted: true, wakeId: wake.id };
  }
  private settled(row: BindingRow, input: unknown) {
    const v = leaseInput.extend({ wakeId: z.string().uuid(), wakeEntryId: sessionId }).strict().parse(input);
    const wake = this.store.db.prepare("SELECT * FROM native_bridge_wakes WHERE id=? AND binding_id=? AND generation=? AND state IN ('starting','completed')").get(v.wakeId, row.id, row.generation) as any;
    if (!wake) throw new BridgeError('无法将完成回执匹配到本次唤醒', 409);
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE native_bridge_wakes SET state='completed',settled_at=? WHERE id=?").run(this.now(), wake.id);
      this.store.db.prepare("UPDATE deliveries SET state='completed',updated_at=? WHERE id IN (SELECT delivery_id FROM native_bridge_deliveries WHERE wake_id=?)").run(this.now(), wake.id);
    });
    return { settled: true, meaning: 'native_turn_settled_not_consensus' };
  }
  private uncertainWake(row: BindingRow, input: unknown) {
    const v = leaseInput.extend({ wakeId: z.string().uuid() }).strict().parse(input);
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE native_bridge_wakes SET state='uncertain',reason='原生回合中断、失败或结果无法确认，需用户核对' WHERE id=? AND binding_id=? AND generation=? AND state='starting'").run(v.wakeId, row.id, row.generation);
      this.markUncertainDeliveries();
    });
    return { requiresOwnerReview: true };
  }
  private tool(row: BindingRow, input: unknown) {
    const v = leaseInput.extend({ name: z.enum(['noah_peers', 'noah_send', 'noah_read', 'noah_material', 'noah_request_human', 'noah_propose_outcome', 'noah_revise_outcome', 'noah_read_outcomes', 'noah_list_workspaces', 'noah_declare_work', 'noah_release_work']), args: z.record(z.string(), z.unknown()) }).strict().parse(input);
    const memberships = this.store.db.prepare("SELECT conversation_id,agent FROM sessions WHERE mode='external' AND binding_id=? AND removed_at IS NULL").all(row.id) as any[];
    if (v.name === 'noah_peers') return memberships.map(m => ({ conversationId: m.conversation_id, self: m.agent, title: this.store.conversation(m.conversation_id).title, status: this.store.conversation(m.conversation_id).status, peers: this.store.db.prepare('SELECT agent,harness,label,status FROM sessions WHERE conversation_id=? AND removed_at IS NULL').all(m.conversation_id), human: { id: 'human', role: 'owner' } }));
    const conversationId = z.string().uuid().parse(v.args.conversationId);
    const membership = memberships.find(m => m.conversation_id === conversationId);
    if (!membership) throw new BridgeError('该原生会话未加入此讨论', 403);
    if (this.store.conversation(conversationId).status === 'archived') throw new BridgeError('讨论已归档，请先由用户恢复', 409);
    const { conversationId: _id, ...toolArgs } = v.args;
    if (['noah_list_workspaces', 'noah_declare_work', 'noah_release_work'].includes(v.name)) return new WorkspaceService(this.store).tool(conversationId, membership.agent, v.name, toolArgs);
    if (v.name === 'noah_read_outcomes') return { outcomes: this.store.outcomes(conversationId) };
    if (v.name === 'noah_propose_outcome') {
      const a = validateTool(v.name, toolArgs);
      return this.store.proposeOutcome(conversationId, membership.agent, { kind: a.kind, title: a.title, content: a.content, evidenceMessageIds: a.evidence_message_ids, clientKey: a.client_message_id });
    }
    if (v.name === 'noah_revise_outcome') {
      const a = validateTool(v.name, toolArgs);
      return this.store.reviseOutcome(conversationId, a.outcome_id, membership.agent, { title: a.title, content: a.content, evidenceMessageIds: a.evidence_message_ids, expectedRevision: a.expected_revision });
    }
    if (v.name === 'noah_send') {
      const a = z.object({ conversationId: z.string().uuid(), recipient: sessionId, content: z.string().min(1).max(65536), clientKey: z.string().min(1).max(160), inReplyTo: z.string().uuid().optional() }).strict().parse(v.args);
      return this.store.send(conversationId, membership.agent, a.recipient, a.content, a.clientKey, a.inReplyTo);
    }
    if (v.name === 'noah_request_human') {
      const a = z.object({ conversationId: z.string().uuid(), question: z.string().min(1).max(8000), clientKey: z.string().min(1).max(160) }).strict().parse(v.args);
      const message = this.store.send(conversationId, membership.agent, 'human', a.question, a.clientKey);
      this.store.pause(conversationId, 'Agent 请求你作出决定');
      return { messageId: message.id, status: 'waiting_human' };
    }
    if (v.name === 'noah_read') return this.store.messages(conversationId, z.number().int().min(0).default(0).parse(v.args.after), 100);
    return this.store.material(conversationId, z.string().uuid().parse(v.args.id), z.number().int().min(0).default(0).parse(v.args.offset));
  }
  async handle(path: string, method: string, bearer: string, input: unknown): Promise<BridgeResponse | undefined> {
    if (!path.startsWith('/api/bridge/')) return undefined;
    try {
      if (method !== 'POST') throw new BridgeError('Bridge endpoints require POST', 405);
      if (path === '/api/bridge/register') return { status: 201, body: this.register(input) };
      if (path === '/api/bridge/reconnect') return { status: 200, body: this.reconnect(bearer, input) };
      const v = leaseInput.passthrough().parse(input), row = this.authenticate(bearer, v.generation);
      let result: unknown;
      switch (path) {
        case '/api/bridge/heartbeat': result = this.refresh(row, input); break;
        case '/api/bridge/inbox': result = this.inbox(row, input); break;
        case '/api/bridge/receipt': result = this.receipt(row, input); break;
        case '/api/bridge/wake': result = this.wake(row); break;
        case '/api/bridge/wake-start': result = this.startWake(row, input); break;
        case '/api/bridge/wake-uncertain': result = this.uncertainWake(row, input); break;
        case '/api/bridge/settled': result = this.settled(row, input); break;
        case '/api/bridge/tool': result = this.tool(row, input); break;
        case '/api/bridge/disconnect': this.revoke(row.id, '原 pi 会话已断开或切换'); result = { revoked: true }; break;
        case '/api/bridge/pause':
          this.store.transaction(() => {
            this.store.db.prepare("UPDATE native_bridge_bindings SET status='paused',reason='原会话上下文或投递发生变化，请核对后重新连接' WHERE id=?").run(row.id);
            this.store.db.prepare("UPDATE native_bridge_wakes SET state='uncertain',reason='原会话上下文或投递已改变，旧唤醒需核对' WHERE binding_id=? AND state IN ('reserved','starting')").run(row.id);
            this.markUncertainDeliveries();
          }); result = { paused: true }; break;
        default: throw new BridgeError('Unknown bridge endpoint', 404);
      }
      return { status: 200, body: result };
    } catch (error) {
      return { status: error instanceof BridgeError ? error.status : 400, body: { error: error instanceof z.ZodError ? '原会话连接请求字段无效' : error instanceof Error ? error.message : '原会话连接失败' } };
    }
  }
  close() {
    this.store.transaction(() => {
      this.store.db.exec("UPDATE native_bridge_bindings SET status='offline',expires_at=0 WHERE status NOT IN ('revoked','paused'); UPDATE native_bridge_wakes SET state='uncertain',reason='Noah 已退出，原生唤醒结果需核对' WHERE state IN ('reserved','starting');");
      this.markUncertainDeliveries();
    });
  }
}
