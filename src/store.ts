import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import { existsSync, statSync, chmodSync } from 'node:fs';
import { privateDir } from './config.ts';

export type ManagedHarnessId = 'grok' | 'pi';
export type AgentId = string;
export type SessionMode = 'managed' | 'external';
/** Legacy default participants. Runtime identities are session instances, not harness names. */
export const AGENTS: ManagedHarnessId[] = ['grok', 'pi'];
export interface ParticipantInput { id?: string; harness: ManagedHarnessId; label?: string; mode?: SessionMode; bindingId?: string }
export interface Conversation { id: string; title: string; status: string; max_runs: number; used_runs: number; expires_at: number; limits_enabled: 0 | 1; created_at: number; reason: string | null; model_alias: string | null; archived_at: number | null; context_budget_bytes: number | null; context_used_bytes: number }
export interface Message { seq: number; id: string; conversation_id: string; sender: string; recipient: string; content: string; in_reply_to: string | null; client_key: string; created_at: number }
export interface SessionRow { conversation_id: string; agent: AgentId; harness: ManagedHarnessId; label: string; mode: SessionMode; binding_id: string; native_id: string | null; native_file: string | null; status: string; error: string | null; capabilities: string | null; joined_at: number; removed_at: number | null }
export type OutcomeKind = 'conclusion' | 'disagreement' | 'open_question';
export interface OutcomeInput { kind: OutcomeKind; title: string; content: string; evidenceMessageIds: string[]; clientKey?: string }
export interface OutcomeRevisionInput { title: string; content: string; evidenceMessageIds: string[]; expectedRevision: number }
interface CreateOperation { clientKey?: string; prepare?: () => string | undefined }
export interface Work { id: string; message_id: string; conversation_id: string; agent: AgentId; state: string; wake: 0 | 1; run_id: string | null; message: Message }
export interface WorkBatch extends Work { deliveries: Work[] }
function participantRecord(conversationId: string, input: ParticipantInput) {
  const agent = input.id || randomUUID();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(agent) || ['human', 'all'].includes(agent)) throw new Error('Invalid participant ID');
  if (!AGENTS.includes(input.harness)) throw new Error('Unsupported harness');
  const mode = input.mode ?? 'managed';
  if (mode !== 'managed' && mode !== 'external') throw new Error('Invalid session mode');
  const label = input.label?.trim() || (input.harness === 'grok' ? 'Grok' : 'pi');
  if (label.length > 80) throw new Error('Participant label exceeds 80 characters');
  if (mode === 'external' && (!input.bindingId || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/.test(input.bindingId))) throw new Error('External participant requires a valid binding ID');
  return { agent, harness: input.harness, label, mode, binding: mode === 'external' ? input.bindingId! : `managed:${conversationId}:${agent}` };
}
export class Store extends EventEmitter {
  db: DatabaseSync;
  constructor(path: string) {
    super();
    if (path !== ':memory:') privateDir(dirname(path));
    const existed = path !== ':memory:' && existsSync(path) && statSync(path).size > 0;
    this.db = new DatabaseSync(path);
    try { this.initializeSchema(path, existed); }
    catch (error) { this.db.close(); throw error; }
  }
  private initializeSchema(path: string, existed: boolean) {
    const previousVersion = (this.db.prepare('PRAGMA user_version').get() as any).user_version as number;
    if (previousVersion > 5) throw new Error(`此 Noah 数据由更新版本的应用创建（数据库版本 ${previousVersion}，本应用支持到 5）。请更新应用后再打开；原数据未修改。`);
    // VACUUM INTO includes committed WAL contents. Never mutate an existing v3 database
    // unless its consistent, uniquely named backup has completed successfully.
    if (existed && previousVersion < 5) {
      const backup = `${path}.pre-v${previousVersion < 4 ? 4 : 5}-${Date.now()}-${randomUUID()}.bak`;
      this.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,max_runs INTEGER NOT NULL,used_runs INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,limits_enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,reason TEXT);
      CREATE TABLE IF NOT EXISTS sessions(conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,agent TEXT NOT NULL,harness TEXT NOT NULL,label TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'managed',binding_id TEXT NOT NULL,native_id TEXT,native_file TEXT,status TEXT NOT NULL DEFAULT 'offline',error TEXT,capabilities TEXT,PRIMARY KEY(conversation_id,agent));
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,sender TEXT NOT NULL,recipient TEXT NOT NULL,content TEXT NOT NULL,in_reply_to TEXT,client_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(conversation_id,sender,client_key));
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,agent TEXT NOT NULL,state TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL,wake INTEGER NOT NULL DEFAULT 1,run_id TEXT,UNIQUE(message_id,agent));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,status TEXT NOT NULL,output TEXT NOT NULL DEFAULT '',usage TEXT,started_at INTEGER NOT NULL,ended_at INTEGER,input_bytes INTEGER NOT NULL DEFAULT 0,message_bytes INTEGER NOT NULL DEFAULT 0,message_count INTEGER NOT NULL DEFAULT 0,prompt_starts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS materials(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,name TEXT NOT NULL,content TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT,kind TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS message_conversation_seq ON messages(conversation_id,seq);
      `);
    // Rebuild the old UNIQUE(message_id) table without cascading away its runs.
    // Foreign keys must be disabled outside the transaction, then checked before commit.
    this.db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
      const columns = (table: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(c => c.name as string);
      const conversationColumns = columns('conversations');
      if (!conversationColumns.includes('model_alias')) this.db.exec('ALTER TABLE conversations ADD COLUMN model_alias TEXT');
      if (!conversationColumns.includes('limits_enabled')) this.db.exec('ALTER TABLE conversations ADD COLUMN limits_enabled INTEGER NOT NULL DEFAULT 1');
      if (!conversationColumns.includes('archived_at')) this.db.exec('ALTER TABLE conversations ADD COLUMN archived_at INTEGER');
      if (!conversationColumns.includes('context_budget_bytes')) this.db.exec('ALTER TABLE conversations ADD COLUMN context_budget_bytes INTEGER');
      if (!conversationColumns.includes('context_used_bytes')) this.db.exec('ALTER TABLE conversations ADD COLUMN context_used_bytes INTEGER NOT NULL DEFAULT 0');
      const sessionColumns = columns('sessions');
      if (!sessionColumns.includes('harness')) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN harness TEXT NOT NULL DEFAULT 'pi';
          ALTER TABLE sessions ADD COLUMN label TEXT NOT NULL DEFAULT '';
          ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'managed';
          ALTER TABLE sessions ADD COLUMN binding_id TEXT NOT NULL DEFAULT '';
          UPDATE sessions SET harness=agent,label=CASE WHEN agent='grok' THEN 'Grok' ELSE 'pi' END,binding_id='managed:' || conversation_id || ':' || agent;`);
      }
      if (!sessionColumns.includes('joined_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN joined_at INTEGER NOT NULL DEFAULT 0; UPDATE sessions SET joined_at=(SELECT created_at FROM conversations WHERE id=conversation_id)');
      if (!sessionColumns.includes('removed_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN removed_at INTEGER');
      if (previousVersion < 4) {
        // Very early databases could have discussions but no session rows yet.
        this.db.exec(`INSERT INTO sessions(conversation_id,agent,harness,label,mode,binding_id)
          SELECT c.id,h.id,h.id,h.label,'managed','managed:' || c.id || ':' || h.id
          FROM conversations c CROSS JOIN (SELECT 'grok' AS id,'Grok' AS label UNION ALL SELECT 'pi','pi') h
          WHERE NOT EXISTS(SELECT 1 FROM sessions s WHERE s.conversation_id=c.id);`);
      }
      if (!columns('deliveries').includes('wake')) {
        this.db.exec(`CREATE TABLE deliveries_v4(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,agent TEXT NOT NULL,state TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL,wake INTEGER NOT NULL DEFAULT 1,run_id TEXT,UNIQUE(message_id,agent));
          INSERT INTO deliveries_v4 SELECT d.*,1,CASE WHEN EXISTS(SELECT 1 FROM runs r WHERE r.id=d.id) THEN d.id ELSE NULL END FROM deliveries d;
          DROP TABLE deliveries;
          ALTER TABLE deliveries_v4 RENAME TO deliveries;`);
      }
      const runColumns = columns('runs');
      for (const name of ['input_bytes', 'message_bytes', 'message_count', 'prompt_starts']) {
        if (!runColumns.includes(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
      }
      const materialColumns = columns('materials');
      if (!materialColumns.includes('family_id')) this.db.exec("ALTER TABLE materials ADD COLUMN family_id TEXT NOT NULL DEFAULT ''; UPDATE materials SET family_id=id");
      if (!materialColumns.includes('revision')) this.db.exec('ALTER TABLE materials ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      if (!materialColumns.includes('previous_id')) this.db.exec('ALTER TABLE materials ADD COLUMN previous_id TEXT');
      if (!materialColumns.includes('created_at')) this.db.exec('ALTER TABLE materials ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS material_family_revision ON materials(family_id,revision);
        CREATE TABLE IF NOT EXISTS outcomes(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),kind TEXT NOT NULL,author TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',current_revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,confirmed_revision INTEGER,client_key TEXT NOT NULL,UNIQUE(conversation_id,author,client_key));
        CREATE TABLE IF NOT EXISTS outcome_revisions(outcome_id TEXT NOT NULL REFERENCES outcomes(id),revision INTEGER NOT NULL,author TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,evidence_message_ids TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(outcome_id,revision));
        CREATE TABLE IF NOT EXISTS outcome_decisions(id INTEGER PRIMARY KEY AUTOINCREMENT,outcome_id TEXT NOT NULL REFERENCES outcomes(id),revision INTEGER NOT NULL,decision TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS context_charges(conversation_id TEXT NOT NULL REFERENCES conversations(id),charge_key TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(conversation_id,charge_key));`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS owner_operations(scope TEXT NOT NULL,client_key TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(scope,client_key));`);
      this.db.exec('CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(conversation_id,agent,state,wake); CREATE INDEX IF NOT EXISTS sessions_binding ON sessions(binding_id);');
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database migration failed its foreign key check');
      if (previousVersion < 5) this.db.exec('PRAGMA user_version=5');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.db.exec('PRAGMA foreign_keys=ON'); }
  }
  transaction<T>(fn: () => T, conversationId?: string): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    let changed = false;
    try {
      const before = (this.db.prepare('SELECT total_changes() AS n').get() as any).n;
      result = fn();
      changed = (this.db.prepare('SELECT total_changes() AS n').get() as any).n !== before;
      if (changed) this.db.prepare('INSERT INTO events(conversation_id,kind,created_at) VALUES(?,?,?)').run(conversationId || null, 'changed', Date.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (changed) this.emit('change', conversationId); return result;
  }
  recover() {
    this.transaction(() => {
      this.db.exec(`UPDATE deliveries SET state='uncertain',error='服务重启：上次执行结果待核对' WHERE state IN ('dispatching','context_accepted');
        UPDATE runs SET status='uncertain' WHERE status='running';
        UPDATE sessions SET status='offline';
        UPDATE conversations SET status='paused',reason='服务重启，请确认后继续排队消息' WHERE status='active';`);
    });
  }
  conversation(id: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as Conversation;
    if (!row) throw new Error('Task not found'); return row;
  }
  private ownerOperation(scope: string, clientKey: string | undefined, request: string): Conversation | undefined {
    if (clientKey === undefined) return;
    if (!clientKey || clientKey.length > 160) throw new Error('操作重试标识须为 1–160 个字符。');
    const previous = this.db.prepare('SELECT request,result FROM owner_operations WHERE scope=? AND client_key=?').get(scope, clientKey) as { request: string; result: string } | undefined;
    if (!previous) return;
    if (previous.request !== request) throw new Error('此操作重试标识已用于不同内容；请为新的操作重新生成标识。');
    return JSON.parse(previous.result) as Conversation;
  }
  private recordOwnerOperation(scope: string, clientKey: string | undefined, request: string, result: Conversation) {
    if (clientKey !== undefined) this.db.prepare('INSERT INTO owner_operations VALUES(?,?,?,?,?)').run(scope, clientKey, request, JSON.stringify(result), Date.now());
    return result;
  }
  create(title: string, maxRuns?: number, minutes?: number, modelAlias?: string, limitsEnabled?: boolean, participants?: ParticipantInput[], contextBudgetBytes?: number | null, operation?: CreateOperation): Conversation {
    const id = randomUUID();
    const inputs: ParticipantInput[] = participants ?? AGENTS.map(harness => ({ id: harness, harness }));
    const members = inputs.map(input => participantRecord(id, input));
    if (!members.length || members.length > 16) throw new Error('A discussion needs 1–16 participants');
    if (new Set(members.map(m => m.agent)).size !== members.length) throw new Error('Duplicate participant ID');
    if (new Set(members.map(m => m.binding)).size !== members.length) throw new Error('A native session can join a discussion only once');
    // Explicit positional bounds remain compatible with existing callers.
    const enabled = limitsEnabled ?? (maxRuns !== undefined || minutes !== undefined);
    this.validateContextBudget(contextBudgetBytes);
    const request = JSON.stringify({ title, maxRuns: maxRuns ?? 12, minutes: minutes ?? 20, modelAlias: modelAlias || null, limitsEnabled: enabled,
      participants: inputs.map(input => ({ id: input.id ?? null, harness: input.harness, label: input.label?.trim() || (input.harness === 'grok' ? 'Grok' : 'pi'),
        mode: input.mode ?? 'managed', bindingId: input.mode === 'external' ? input.bindingId : null })), contextBudgetBytes: contextBudgetBytes ?? null });
    const previous = this.ownerOperation('create', operation?.clientKey, request);
    if (previous) return previous;
    // Existing results do not depend on today's model config or bridge lease.
    // Live checks may reconcile bridge state, so run them outside this transaction.
    const resolvedAlias = operation?.prepare ? operation.prepare() : modelAlias;
    return this.transaction(() => {
      const previous = this.ownerOperation('create', operation?.clientKey, request);
      if (previous) return previous;
      this.db.prepare('INSERT INTO conversations(id,title,status,max_runs,expires_at,limits_enabled,created_at,model_alias,context_budget_bytes) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, title, 'active', maxRuns ?? 12, Date.now() + (minutes ?? 20) * 60000, enabled ? 1 : 0, Date.now(), resolvedAlias || null, contextBudgetBytes ?? null);
      for (const m of members) this.db.prepare('INSERT INTO sessions(conversation_id,agent,harness,label,mode,binding_id,joined_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, m.agent, m.harness, m.label, m.mode, m.binding, Date.now());
      return this.recordOwnerOperation('create', operation?.clientKey, request, this.conversation(id));
    }, id);
  }
  control(id: string, action: 'pause' | 'resume' | 'archive' | 'restore', additionalRuns = 0, minutes = 20, limitsEnabled?: boolean, contextBudgetBytes?: number | null, clientKey?: string): Conversation {
    this.conversation(id);
    this.validateContextBudget(contextBudgetBytes);
    if (clientKey !== undefined && action !== 'resume') throw new Error('操作重试标识目前仅用于新建和继续讨论。');
    const request = JSON.stringify({ action, additionalRuns, minutes, limitsEnabled, contextBudgetBytes });
    return this.transaction(() => {
      const previous = this.ownerOperation(`resume:${id}`, clientKey, request);
      if (previous) return previous;
      const c = this.conversation(id);
      if (action === 'archive') {
        this.db.prepare("UPDATE conversations SET status='archived',archived_at=coalesce(archived_at,?),reason='用户归档；历史保留，停止新派发' WHERE id=?").run(Date.now(), id);
        return this.conversation(id);
      }
      if (action === 'restore') {
        if (c.status !== 'archived') throw new Error('讨论尚未归档。');
        this.db.prepare("UPDATE conversations SET status='paused',archived_at=NULL,reason='从归档恢复；确认后手动继续' WHERE id=?").run(id);
        return this.conversation(id);
      }
      if (c.status === 'archived') throw new Error('请先恢复归档的讨论。');
      if (contextBudgetBytes !== undefined) this.db.prepare('UPDATE conversations SET context_budget_bytes=? WHERE id=?').run(contextBudgetBytes, id);
      if (action === 'pause') {
        this.db.prepare("UPDATE conversations SET status='paused',reason='用户暂停' WHERE id=?").run(id);
        return this.conversation(id);
      }
      const enabled = limitsEnabled === undefined ? c.limits_enabled : limitsEnabled ? 1 : 0;
      const maxRuns = enabled && !c.limits_enabled ? c.used_runs + additionalRuns : c.max_runs + additionalRuns;
      this.db.prepare("UPDATE conversations SET status='active',reason=NULL,max_runs=?,expires_at=?,limits_enabled=? WHERE id=?")
        .run(maxRuns, Date.now() + minutes * 60000, enabled, id);
      return this.recordOwnerOperation(`resume:${id}`, clientKey, request, this.conversation(id));
    }, id);
  }
  pause(id: string, reason: string) {
    this.transaction(() => { this.db.prepare("UPDATE conversations SET status='paused',reason=? WHERE id=? AND status!='archived'").run(reason, id); }, id);
  }
  private validateContextBudget(value?: number | null) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024)) throw new Error('上下文预算须为 1–1073741824 个 UTF-8 字节，或 null 表示不限。');
  }
  private chargeContextBytes(id: string, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid context byte count');
    const c = this.conversation(id);
    if (c.status !== 'active') return false;
    if (c.context_budget_bytes !== null && c.context_used_bytes + bytes > c.context_budget_bytes) {
      this.db.prepare("UPDATE conversations SET status='paused',reason='本次完整输入将超出你设置的新增上下文字节预算；正文保留，请调整预算后继续' WHERE id=?").run(id);
      return false;
    }
    this.db.prepare('UPDATE conversations SET context_used_bytes=context_used_bytes+? WHERE id=?').run(bytes, id);
    return true;
  }
  /** Durable reservation; repeated delivery attempts reuse one charge key, not the budget. */
  reserveContextBytes(id: string, chargeKey: string, bytes: number): boolean {
    if (!chargeKey || chargeKey.length > 240 || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid context reservation');
    const reserve = () => {
      const previous = this.db.prepare('SELECT bytes FROM context_charges WHERE conversation_id=? AND charge_key=?').get(id, chargeKey) as any;
      if (previous) {
        if (previous.bytes !== bytes) throw new Error('Context reservation key conflict');
        return true;
      }
      if (!this.chargeContextBytes(id, bytes)) return false;
      this.db.prepare('INSERT INTO context_charges VALUES(?,?,?,?)').run(id, chargeKey, bytes, Date.now());
      return true;
    };
    return this.db.isTransaction ? reserve() : this.transaction(reserve, id);
  }
  addParticipant(id: string, input: ParticipantInput, shareHistory: boolean, modelAlias?: string) {
    const m = participantRecord(id, input);
    return this.transaction(() => {
      const c = this.conversation(id);
      if (c.status === 'archived') throw new Error('请先恢复归档的讨论。');
      const members = this.sessions(id);
      if (members.length >= 16) throw new Error('讨论最多可有 16 位当前成员。');
      if (this.db.prepare('SELECT 1 FROM sessions WHERE conversation_id=? AND agent=?').get(id, m.agent)) throw new Error('Participant ID is already used; historical identities cannot be replaced');
      if (members.some(s => s.binding_id === m.binding)) throw new Error('A native session can join a discussion only once');
      if (modelAlias && c.model_alias && modelAlias !== c.model_alias) throw new Error('新增成员使用本讨论既有的新建模型配置。');
      if (modelAlias && !c.model_alias) this.db.prepare('UPDATE conversations SET model_alias=? WHERE id=?').run(modelAlias, id);
      this.db.prepare('INSERT INTO sessions(conversation_id,agent,harness,label,mode,binding_id,joined_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, m.agent, m.harness, m.label, m.mode, m.binding, Date.now());
      if (shareHistory) {
        const insert = this.db.prepare("INSERT INTO deliveries(id,message_id,conversation_id,agent,state,updated_at,wake) VALUES(?,?,?,?,'queued',?,0)");
        for (const message of this.db.prepare('SELECT id FROM messages WHERE conversation_id=? ORDER BY seq').all(id) as any[]) insert.run(randomUUID(), message.id, id, m.agent, Date.now());
      }
      return this.session(id, m.agent);
    }, id);
  }
  removeParticipant(id: string, agent: string) {
    return this.transaction(() => {
      if (this.conversation(id).status === 'archived') throw new Error('请先恢复归档的讨论。');
      const row = this.session(id, agent);
      if (row.removed_at !== null) return row;
      this.db.prepare('UPDATE sessions SET removed_at=? WHERE conversation_id=? AND agent=?').run(Date.now(), id, agent);
      // Retain in-flight execution and its receipts. Removing membership only withdraws future work.
      const nativeActive = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_bridge_wakes'").get()
        ? " AND id NOT IN (SELECT n.delivery_id FROM native_bridge_deliveries n JOIN native_bridge_wakes w ON w.id=n.wake_id WHERE w.state IN ('starting','uncertain'))" : '';
      this.db.prepare("UPDATE deliveries SET state='cancelled',error='成员已退出讨论；未启动的投递不再派发',updated_at=? WHERE conversation_id=? AND agent=? AND state IN ('queued','transcript_observed')" + nativeActive).run(Date.now(), id, agent);
      return this.session(id, agent);
    }, id);
  }
  assertMember(id: string, agent: string) {
    if (agent !== 'human' && !this.sessions(id).some(s => s.agent === agent)) throw new Error('成员已退出或不属于此讨论。');
  }
  send(conversationId: string, sender: string, recipient: string, content: string, clientKey: string, replyTo?: string): Message {
    this.conversation(conversationId);
    const members = this.sessions(conversationId);
    const ids = members.map(member => member.agent);
    if (!['human', ...ids].includes(sender) || !['human', 'all', ...ids].includes(recipient) || sender === recipient) throw new Error('Invalid sender or recipient');
    if (!content.trim() || Buffer.byteLength(content) > 65536) throw new Error('Message must contain 1–65536 UTF-8 bytes');
    if (!clientKey || clientKey.length > 160) throw new Error('Message idempotency key must contain 1–160 characters');
    if (replyTo && !this.db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(replyTo, conversationId)) throw new Error('Reply target is outside this task');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sender=? AND client_key=?').get(conversationId, sender, clientKey) as unknown as Message | undefined;
      if (old) {
        if (old.recipient !== recipient || old.content !== content || old.in_reply_to !== (replyTo || null)) throw new Error('Idempotency key conflict');
        return old;
      }
      if (this.conversation(conversationId).status === 'archived') throw new Error('请先恢复归档的讨论。');
      const id = randomUUID();
      this.db.prepare('INSERT INTO messages(id,conversation_id,sender,recipient,content,in_reply_to,client_key,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, conversationId, sender, recipient, content, replyTo || null, clientKey, Date.now());
      // One shared message, one durable inbox entry per other participant. An
      // observer remains queued until a later directed turn; receipt is not inferred.
      const insertDelivery = this.db.prepare('INSERT INTO deliveries(id,message_id,conversation_id,agent,state,error,updated_at,wake) VALUES(?,?,?,?,?,?,?,?)');
      for (const member of members) {
        if (member.agent === sender) continue;
        insertDelivery.run(randomUUID(), id, conversationId, member.agent, 'queued', null, Date.now(), recipient === 'all' || recipient === member.agent ? 1 : 0);
      }
      return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as unknown as Message;
    }, conversationId);
  }
  messages(id: string, after = 0, limit = 50): Message[] {
    this.conversation(id);
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit) as unknown as Message[];
  }
  queued(mode: SessionMode = 'managed', includePassive = false): Work[] {
    const rows = this.db.prepare(`SELECT d.* FROM deliveries d JOIN conversations c ON c.id=d.conversation_id JOIN messages m ON m.id=d.message_id
      JOIN sessions s ON s.conversation_id=d.conversation_id AND s.agent=d.agent
      WHERE d.state='queued' AND c.status='active' AND s.removed_at IS NULL AND s.mode=? AND (?=1 OR d.wake=1) ORDER BY m.seq,d.agent`).all(mode, includePassive ? 1 : 0) as unknown as Work[];
    return rows.map(row => ({ ...row, message: this.db.prepare('SELECT * FROM messages WHERE id=?').get(row.message_id) as unknown as Message }));
  }
  claim(id: string): Work | undefined {
    const batch = this.claimWork(id, 'managed', false);
    return batch ? batch.deliveries[0] : undefined;
  }
  claimBatch(id: string, mode: SessionMode = 'managed'): WorkBatch | undefined {
    return this.claimWork(id, mode, true);
  }
  private claimWork(id: string, mode: SessionMode, collectPending: boolean): WorkBatch | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id=? AND state='queued'").get(id) as unknown as Work | undefined;
    if (!row || !row.wake) return;
    const member = this.session(row.conversation_id, row.agent);
    if (member.mode !== mode || member.removed_at !== null) return;
    return this.transaction(() => {
      const c = this.conversation(row.conversation_id);
      if (c.status !== 'active') return;
      if (c.limits_enabled && (c.used_runs >= c.max_runs || c.expires_at <= Date.now())) {
        this.db.prepare("UPDATE conversations SET status='paused',reason=? WHERE id=?").run(c.used_runs >= c.max_runs ? '自动运行额度已用完' : '自动运行时间窗口已结束', c.id);
        return;
      }
      const binding = this.session(c.id, row.agent).binding_id;
      const busy = this.db.prepare(`SELECT d.id FROM deliveries d JOIN sessions s ON s.conversation_id=d.conversation_id AND s.agent=d.agent
        WHERE s.binding_id=? AND d.state IN ('dispatching','context_accepted','uncertain') LIMIT 1`).get(binding);
      if (busy) return;
      const pending = (collectPending
        ? this.db.prepare(`SELECT d.* FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.conversation_id=? AND d.agent=? AND d.state='queued' ORDER BY m.seq`).all(c.id, row.agent)
        : [row]) as unknown as Work[];
      if (!pending.some(item => item.id === id)) return;
      const claim = this.db.prepare("UPDATE deliveries SET state='dispatching',run_id=?,updated_at=? WHERE id=? AND state='queued'");
      for (const item of pending) claim.run(id, Date.now(), item.id);
      this.db.prepare('UPDATE conversations SET used_runs=used_runs+1 WHERE id=?').run(c.id);
      this.db.prepare('INSERT INTO runs(id,status,started_at) VALUES(?,?,?)').run(id, 'running', Date.now());
      const deliveries = pending.map(item => ({ ...item, state: 'dispatching', run_id: id, message: this.db.prepare('SELECT * FROM messages WHERE id=?').get(item.message_id) as unknown as Message }));
      return { ...deliveries.find(item => item.id === id)!, deliveries };
    }, row.conversation_id);
  }
  delivery(id: string, state: string, error?: string) {
    const row = this.db.prepare('SELECT conversation_id,run_id FROM deliveries WHERE id=?').get(id) as any;
    if (!row) throw new Error('Delivery not found');
    if (row.run_id) { this.deliveryBatch(row.run_id, state, error); return; }
    this.transaction(() => {
      this.db.prepare('UPDATE deliveries SET state=?,error=?,updated_at=? WHERE id=?').run(state, error || null, Date.now(), id);
      if (['completed', 'failed', 'cancelled', 'uncertain'].includes(state)) this.db.prepare('UPDATE runs SET status=?,ended_at=? WHERE id=?').run(state, Date.now(), id);
    }, row.conversation_id);
  }
  deliveryBatch(runId: string, state: string, error?: string) {
    const row = this.db.prepare('SELECT conversation_id FROM deliveries WHERE run_id=? LIMIT 1').get(runId) as any;
    if (!row) throw new Error('Delivery batch not found');
    this.transaction(() => {
      this.db.prepare('UPDATE deliveries SET state=?,error=?,updated_at=? WHERE run_id=?').run(state, error || null, Date.now(), runId);
      if (['completed', 'failed', 'cancelled', 'uncertain'].includes(state)) this.db.prepare('UPDATE runs SET status=?,ended_at=? WHERE id=?').run(state, Date.now(), runId);
    }, row.conversation_id);
  }
  /** Exact bytes submitted to the adapter, not a token estimate or a native-storage receipt. */
  recordInjection(runId: string, input: string, deliveries: Work[]): boolean {
    const run = this.db.prepare("SELECT r.*,d.conversation_id FROM runs r JOIN deliveries d ON d.id=r.id WHERE r.id=? AND r.status='running' AND r.prompt_starts=0").get(runId) as any;
    if (!run) throw new Error('Prompt submission was already recorded or run is inactive');
    return this.transaction(() => {
      if (!this.reserveContextBytes(run.conversation_id, `managed:${runId}`, Buffer.byteLength(input))) {
        this.db.prepare("UPDATE deliveries SET state='queued',run_id=NULL,updated_at=? WHERE run_id=?").run(Date.now(), runId);
        this.db.prepare('DELETE FROM runs WHERE id=?').run(runId);
        this.db.prepare('UPDATE conversations SET used_runs=max(0,used_runs-1) WHERE id=?').run(run.conversation_id);
        return false;
      }
      this.db.prepare(`UPDATE runs SET input_bytes=?,message_bytes=?,message_count=?,prompt_starts=1 WHERE id=?`)
        .run(Buffer.byteLength(input), deliveries.reduce((sum, work) => sum + Buffer.byteLength(work.message.content), 0), deliveries.length, runId);
      return true;
    }, run.conversation_id);
  }
  sessions(conversationId: string, includeRemoved = false): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions WHERE conversation_id=? AND (?=1 OR removed_at IS NULL) ORDER BY rowid').all(conversationId, includeRemoved ? 1 : 0) as unknown as SessionRow[];
  }
  session(conversationId: string, agent: AgentId): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE conversation_id=? AND agent=?').get(conversationId, agent) as unknown as SessionRow | undefined;
    if (!row) throw new Error('Participant not found in this discussion');
    return row;
  }
  updateSession(conversationId: string, agent: AgentId, data: Partial<SessionRow>) {
    const old = this.session(conversationId, agent);
    const r = { ...old, ...data };
    this.transaction(() => {
      this.db.prepare('UPDATE sessions SET native_id=?,native_file=?,status=?,error=?,capabilities=? WHERE conversation_id=? AND agent=?')
        .run(r.native_id, r.native_file, r.status, r.error, r.capabilities, conversationId, agent);
    }, conversationId);
  }
  output(id: string, text: string) {
    this.db.prepare('UPDATE runs SET output=substr(output || ?,1,65536) WHERE id=?').run(text, id);
  }
  usage(id: string, value: unknown) { this.db.prepare('UPDATE runs SET usage=? WHERE id=?').run(JSON.stringify(value), id); }
  addMaterial(conversationId: string, name: string, content: string) {
    if (this.conversation(conversationId).status === 'archived') throw new Error('请先恢复归档的讨论。');
    if (Buffer.byteLength(content) > 10 * 1024 * 1024) throw new Error('Material exceeds 10 MiB');
    const id = randomUUID(), sha = createHash('sha256').update(content).digest('hex');
    this.transaction(() => this.db.prepare('INSERT INTO materials(id,conversation_id,name,content,sha256,family_id,revision,created_at) VALUES(?,?,?,?,?,?,1,?)').run(id, conversationId, name, content, sha, id, Date.now()), conversationId);
    return { id, name, sha256: sha, family_id: id, revision: 1, previous_id: null };
  }
  reviseMaterial(conversationId: string, previousId: string, name: string, content: string) {
    if (Buffer.byteLength(content) > 10 * 1024 * 1024) throw new Error('Material exceeds 10 MiB');
    return this.transaction(() => {
      if (this.conversation(conversationId).status === 'archived') throw new Error('请先恢复归档的讨论。');
      const old = this.db.prepare('SELECT * FROM materials WHERE id=? AND conversation_id=?').get(previousId, conversationId) as any;
      if (!old) throw new Error('Material not shared with this task');
      const latest = this.db.prepare('SELECT id FROM materials WHERE family_id=? ORDER BY revision DESC LIMIT 1').get(old.family_id) as any;
      if (latest.id !== previousId) throw new Error('资料已有更新版本，请重新载入后再提交。');
      const id = randomUUID(), sha = createHash('sha256').update(content).digest('hex'), revision = old.revision + 1;
      this.db.prepare('INSERT INTO materials(id,conversation_id,name,content,sha256,family_id,revision,previous_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, conversationId, name, content, sha, old.family_id, revision, previousId, Date.now());
      return { id, name, sha256: sha, family_id: old.family_id, revision, previous_id: previousId };
    }, conversationId);
  }
  material(conversationId: string, id: string, offset = 0) {
    const row = this.db.prepare('SELECT * FROM materials WHERE id=? AND conversation_id=?').get(id, conversationId) as any;
    if (!row) throw new Error('Material not shared with this task');
    return { id, name: row.name, sha256: row.sha256, family_id: row.family_id, revision: row.revision, previous_id: row.previous_id, created_at: row.created_at, content: row.content.slice(offset, offset + 16000), nextOffset: offset + 16000 < row.content.length ? offset + 16000 : null };
  }
  private outcomeContent(id: string, title: string, content: string, evidenceIds: string[]) {
    if (!title.trim() || title.length > 160 || !content.trim() || Buffer.byteLength(content) > 65536) throw new Error('提议需要标题及不超过 65536 字节的正文。');
    if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.length > 50) throw new Error('请引用 1–50 条本讨论的公开消息作为依据。');
    const evidence = [...new Set(evidenceIds)];
    const find = this.db.prepare('SELECT 1 FROM messages WHERE id=? AND conversation_id=?');
    if (evidence.some(messageId => typeof messageId !== 'string' || !find.get(messageId, id))) throw new Error('依据消息必须属于同一讨论。');
    return { title: title.trim(), content, evidence };
  }
  proposeOutcome(id: string, author: string, input: OutcomeInput) {
    const key = input.clientKey || randomUUID();
    if (!['conclusion', 'disagreement', 'open_question'].includes(input.kind) || key.length > 160) throw new Error('Invalid outcome kind or idempotency key');
    return this.transaction(() => {
      this.assertMember(id, author);
      if (this.conversation(id).status === 'archived') throw new Error('请先恢复归档的讨论。');
      const value = this.outcomeContent(id, input.title, input.content, input.evidenceMessageIds);
      const old = this.db.prepare('SELECT o.id,o.kind,r.title,r.content,r.evidence_message_ids FROM outcomes o JOIN outcome_revisions r ON r.outcome_id=o.id AND r.revision=1 WHERE o.conversation_id=? AND o.author=? AND o.client_key=?').get(id, author, key) as any;
      if (old) {
        if (old.kind !== input.kind || old.title !== value.title || old.content !== value.content || old.evidence_message_ids !== JSON.stringify(value.evidence)) throw new Error('Outcome idempotency key conflict');
        return this.outcome(id, old.id);
      }
      const outcomeId = randomUUID(), now = Date.now();
      this.db.prepare('INSERT INTO outcomes(id,conversation_id,kind,author,created_at,updated_at,client_key) VALUES(?,?,?,?,?,?,?)').run(outcomeId, id, input.kind, author, now, now, key);
      this.db.prepare('INSERT INTO outcome_revisions VALUES(?,1,?,?,?,?,?)').run(outcomeId, author, value.title, value.content, JSON.stringify(value.evidence), now);
      return this.outcome(id, outcomeId);
    }, id);
  }
  reviseOutcome(id: string, outcomeId: string, author: string, input: OutcomeRevisionInput) {
    return this.transaction(() => {
      this.assertMember(id, author);
      if (this.conversation(id).status === 'archived') throw new Error('请先恢复归档的讨论。');
      const old = this.outcome(id, outcomeId);
      if (old.author !== author) throw new Error('只能修订自己提出的立场；可另建提议，不能覆盖其他成员。');
      const value = this.outcomeContent(id, input.title, input.content, input.evidenceMessageIds);
      if (old.current_revision !== input.expectedRevision) throw new Error('提议已有更新版本，请重新载入后再提交。');
      const revision = old.current_revision + 1, now = Date.now();
      this.db.prepare('INSERT INTO outcome_revisions VALUES(?,?,?,?,?,?,?)').run(outcomeId, revision, author, value.title, value.content, JSON.stringify(value.evidence), now);
      this.db.prepare("UPDATE outcomes SET current_revision=?,updated_at=?,status='proposed',confirmed_revision=NULL WHERE id=?").run(revision, now, outcomeId);
      return this.outcome(id, outcomeId);
    }, id);
  }
  decideOutcome(id: string, outcomeId: string, decision: 'confirmed' | 'reopened', expectedRevision: number) {
    return this.transaction(() => {
      if (this.conversation(id).status === 'archived') throw new Error('请先恢复归档的讨论。');
      const old = this.outcome(id, outcomeId);
      if (old.current_revision !== expectedRevision) throw new Error('提议已有更新版本，请先阅读新版。');
      const status = decision === 'confirmed' ? 'confirmed' : 'proposed';
      if (old.status === status) return old;
      this.db.prepare('INSERT INTO outcome_decisions(outcome_id,revision,decision,created_at) VALUES(?,?,?,?)').run(outcomeId, expectedRevision, decision, Date.now());
      this.db.prepare('UPDATE outcomes SET status=?,confirmed_revision=?,updated_at=? WHERE id=?').run(status, decision === 'confirmed' ? expectedRevision : null, Date.now(), outcomeId);
      return this.outcome(id, outcomeId);
    }, id);
  }
  outcomes(id?: string): any[] {
    const rows = this.db.prepare(`SELECT o.id,o.conversation_id,o.kind,o.author,o.status,o.current_revision,o.current_revision AS revision_count,o.created_at,o.updated_at,o.confirmed_revision,r.title,r.content,r.evidence_message_ids
      FROM outcomes o JOIN outcome_revisions r ON r.outcome_id=o.id AND r.revision=o.current_revision ${id ? 'WHERE o.conversation_id=?' : ''} ORDER BY o.updated_at DESC`).all(...(id ? [id] : [])) as any[];
    return rows.map(row => ({ ...row, evidence_message_ids: JSON.parse(row.evidence_message_ids) }));
  }
  outcome(id: string, outcomeId: string) {
    const value = this.outcomes(id).find(row => row.id === outcomeId);
    if (!value) throw new Error('提议不属于本讨论。');
    return value;
  }
  outcomeRevisions(id?: string): any[] {
    const rows = this.db.prepare(`SELECT r.*,o.conversation_id FROM outcome_revisions r JOIN outcomes o ON o.id=r.outcome_id ${id ? 'WHERE o.conversation_id=?' : ''} ORDER BY r.created_at,r.revision`).all(...(id ? [id] : [])) as any[];
    return rows.map(row => ({ ...row, evidence_message_ids: JSON.parse(row.evidence_message_ids) }));
  }
  snapshot(options: { compact?: boolean } = {}) {
    const compact = options.compact === true;
    return {
      conversations: this.db.prepare('SELECT * FROM conversations ORDER BY created_at DESC').all(),
      sessions: this.db.prepare('SELECT * FROM sessions').all(),
      messages: this.db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT ?').all(compact ? 200 : 1000).reverse(),
      deliveries: this.db.prepare(compact ? "SELECT * FROM deliveries WHERE message_id IN (SELECT id FROM messages ORDER BY seq DESC LIMIT 200) OR id IN (SELECT id FROM deliveries ORDER BY updated_at DESC,rowid DESC LIMIT 200) OR state IN ('dispatching','context_accepted','uncertain')" : 'SELECT * FROM deliveries').all(),
      runs: this.db.prepare(compact ? `SELECT r.id,r.status,r.started_at,r.ended_at,r.input_bytes,r.message_bytes,r.message_count,r.prompt_starts,
        d.agent,d.conversation_id,length(r.output)>0 AS output_available FROM runs r JOIN deliveries d ON d.id=r.id
        WHERE r.id IN (SELECT id FROM runs ORDER BY rowid DESC LIMIT 100) OR r.status IN ('running','uncertain')` : 'SELECT * FROM runs').all(),
      runMetrics: this.db.prepare(`SELECT d.conversation_id,sum(r.input_bytes) AS input_bytes,sum(r.message_bytes) AS message_bytes,sum(r.message_count) AS message_count,
        sum(r.prompt_starts) AS prompt_starts,count(*) AS run_count,sum(CASE WHEN r.prompt_starts>0 THEN 1 ELSE 0 END) AS measured_runs
        FROM runs r JOIN deliveries d ON d.id=r.id GROUP BY d.conversation_id`).all(),
      deliveryCounts: this.db.prepare('SELECT conversation_id,agent,state,count(*) AS count FROM deliveries GROUP BY conversation_id,agent,state').all(),
      materials: this.db.prepare('SELECT id,conversation_id,name,sha256,family_id,revision,previous_id,created_at FROM materials ORDER BY revision').all(),
      outcomes: this.outcomes(), outcomeRevisions: compact ? [] : this.outcomeRevisions(),
      compact, recentMessageLimit: compact ? 200 : 1000,
      eventId: (this.db.prepare('SELECT max(id) AS id FROM events').get() as any).id || 0,
    };
  }
  resolveUncertain(id: string) {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id=? AND state='uncertain'").get(id) as any;
    if (!row) throw new Error('No uncertain delivery');
    this.delivery(id, 'cancelled', '用户已核对上次运行；不重发旧消息');
  }
  close() { this.db.close(); }
}
