import type { Store, Message } from './store.ts';

/** Owner-only reads. Never search native transcripts or private run output. */
export function searchMessages(store: Store, query: string, conversationId?: string, limit = 50) {
  const term = query.trim();
  if (!term || term.length > 200) throw new Error('请输入 1–200 字符的搜索词。');
  if (conversationId) store.conversation(conversationId);
  const pattern = `%${term.replace(/[\\%_]/g, value => '\\' + value)}%`;
  const results = store.db.prepare(`SELECT m.*,c.title AS conversation_title,c.status AS conversation_status FROM messages m
    JOIN conversations c ON c.id=m.conversation_id
    WHERE m.content LIKE ? ESCAPE '\\' ${conversationId ? 'AND m.conversation_id=?' : ''}
    ORDER BY m.seq DESC LIMIT ?`).all(...(conversationId ? [pattern, conversationId, limit + 1] : [pattern, limit + 1])) as any[];
  return { query: term, truncated: results.length > limit, results: results.slice(0, limit).map(m => {
    const at = m.content.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
    const start = Math.max(0, at - 70), end = Math.min(m.content.length, Math.max(at, 0) + term.length + 150);
    return { id: m.id, seq: m.seq, conversation_id: m.conversation_id, conversation_title: m.conversation_title,
      sender: m.sender, recipient: m.recipient, created_at: m.created_at, conversation_status: m.conversation_status,
      excerpt: (start ? '…' : '') + m.content.slice(start, end) + (end < m.content.length ? '…' : '') };
  }) };
}

export function messagePage(store: Store, id: string, options: { before?: number; around?: number; limit?: number } = {}) {
  store.conversation(id);
  const limit = options.limit ?? 100;
  let rows: Message[];
  if (options.around !== undefined) {
    if (!store.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND seq=?').get(id, options.around)) throw new Error('这条消息不属于当前讨论。');
    const left = store.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq<=? ORDER BY seq DESC LIMIT ?').all(id, options.around, Math.ceil(limit / 2)) as unknown as Message[];
    const right = store.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, options.around, Math.floor(limit / 2)) as unknown as Message[];
    rows = [...left.reverse(), ...right];
  } else {
    rows = store.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(id, options.before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as Message[];
    rows.reverse();
  }
  const total = (store.db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(id) as any).n as number;
  const hasOlder = !!rows.length && !!store.db.prepare('SELECT seq FROM messages WHERE conversation_id=? AND seq<? LIMIT 1').get(id, rows[0]!.seq);
  const hasNewer = !!rows.length && !!store.db.prepare('SELECT seq FROM messages WHERE conversation_id=? AND seq>? LIMIT 1').get(id, rows.at(-1)!.seq);
  return { messages: rows, total, hasOlder, hasNewer, before: rows[0]?.seq ?? null };
}

/** Stable local row cursors page private execution details separately from shared messages. */
export function activityPage(store: Store, id: string, kind: 'runs' | 'deliveries', options: { before?: number; limit?: number; agent?: string; messageIds?: string[] } = {}): { runs?: any[]; deliveries?: any[]; hasOlder: boolean; nextBefore: string | null } {
  store.conversation(id);
  if (kind === 'deliveries' && options.messageIds) {
    const ids = [...new Set(options.messageIds)];
    if (!ids.length || ids.length > 100) throw new Error('回执定位需要 1–100 个消息 ID。');
    const rows = store.db.prepare(`SELECT rowid AS cursor,* FROM deliveries WHERE conversation_id=? AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`).all(id, ...ids);
    return { deliveries: rows, hasOlder: false, nextBefore: null };
  }
  const limit = options.limit ?? (kind === 'runs' ? 20 : 100);
  const memberFilter = options.agent ? [options.agent] : [];
  const rows = (kind === 'runs'
    ? store.db.prepare(`SELECT r.rowid AS cursor,r.*,d.agent,d.conversation_id FROM runs r JOIN deliveries d ON d.id=r.id WHERE d.conversation_id=? ${options.agent ? 'AND d.agent=?' : ''} AND r.rowid<? ORDER BY r.rowid DESC LIMIT ?`).all(id, ...memberFilter, options.before ?? Number.MAX_SAFE_INTEGER, limit + 1)
    : store.db.prepare(`SELECT rowid AS cursor,* FROM deliveries WHERE conversation_id=? ${options.agent ? 'AND agent=?' : ''} AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(id, ...memberFilter, options.before ?? Number.MAX_SAFE_INTEGER, limit + 1)) as any[];
  const page = rows.slice(0, limit);
  return { [kind]: page, hasOlder: rows.length > limit, nextBefore: rows.length > limit ? String(page.at(-1)!.cursor) : null };
}

export function exportDiscussion(store: Store, id: string) {
  const c = store.conversation(id);
  const discussion = { id: c.id, title: c.title, created_at: c.created_at, status: c.status,
    limits_enabled: c.limits_enabled, max_runs: c.max_runs, used_runs: c.used_runs, model_alias: c.model_alias,
    archived_at: c.archived_at, context_budget_bytes: c.context_budget_bytes, context_used_bytes: c.context_used_bytes };
  const participants = (store.db.prepare('SELECT * FROM sessions WHERE conversation_id=?').all(id) as any[]).map(s => ({
    id: s.agent, harness: s.harness || s.agent, label: s.label || s.agent, mode: s.mode || 'managed',
  }));
  const messages = (store.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq').all(id) as any[]).map(m => ({
    id: m.id, seq: m.seq, sender: m.sender, recipient: m.recipient, content: m.content, in_reply_to: m.in_reply_to, created_at: m.created_at,
  }));
  // Error text and native paths are deliberately omitted from a portable public transcript.
  const deliveries = (store.db.prepare('SELECT * FROM deliveries WHERE conversation_id=?').all(id) as any[]).map(d => ({
    message_id: d.message_id, participant_id: d.agent, state: d.state, updated_at: d.updated_at,
  }));
  const materials = store.db.prepare('SELECT id,name,content,sha256,family_id,revision,previous_id,created_at FROM materials WHERE conversation_id=? ORDER BY family_id,revision').all(id);
  const membership = store.sessions(id, true).map(s => ({ participant_id: s.agent, joined_at: s.joined_at, removed_at: s.removed_at }));
  const outcomes = store.outcomes(id), outcomeRevisions = store.outcomeRevisions(id);
  const outcomeDecisions = store.db.prepare('SELECT d.outcome_id,d.revision,d.decision,d.created_at FROM outcome_decisions d JOIN outcomes o ON o.id=d.outcome_id WHERE o.conversation_id=? ORDER BY d.id').all(id);
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), discussion, participants, messages, deliveries, materials,
    membership, outcomes, outcomeRevisions, outcomeDecisions,
    scope: 'Shared discussion and explicitly shared materials only. Not a native-session backup.' };
}

export function diagnostics(store: Store) {
  const deliveryCounts = store.db.prepare('SELECT state,count(*) AS count FROM deliveries GROUP BY state').all();
  const unresolved = store.db.prepare("SELECT d.id,d.conversation_id,d.agent,c.title FROM deliveries d JOIN conversations c ON c.id=d.conversation_id WHERE d.state='uncertain' ORDER BY d.updated_at DESC LIMIT 50").all();
  const quickCheck = store.db.prepare('PRAGMA quick_check(1)').get() as any;
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), database: Object.values(quickCheck || {})[0] === 'ok' ? 'ok' : 'needs_attention',
    deliveryCounts, unresolved, inferenceStarted: false,
    guidance: unresolved.length ? '先核对原会话是否已执行，再结束旧投递；不会自动重跑。' : '诊断不会启动 Agent。暂停的讨论需要你手动继续。' };
}
