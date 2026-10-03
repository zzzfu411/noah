import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import { z } from 'zod';
import { Store } from './store.ts';

const declaration = z.object({
  workspace_id: z.string().uuid(), path: z.string().trim().min(1).max(1024),
  description: z.string().trim().min(1).max(500), ttl_seconds: z.number().int().min(60).max(3600).default(900),
}).strict();
type Intent = { id: string; conversation_id: string; workspace_id: string; agent: string; path: string; description: string; created_at: number; expires_at: number; released_at: number | null; revoked_at: number | null; removed_at: number | null; root: string };

/** Advisory coordination only. This service never reads project contents or locks a file. */
export class WorkspaceService {
  private store: Store;
  private now: () => number;
  constructor(store: Store, now = Date.now) {
    this.store = store; this.now = now;
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_grants(
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),root TEXT NOT NULL,label TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS work_intents(
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),workspace_id TEXT NOT NULL REFERENCES workspace_grants(id),agent TEXT NOT NULL,path TEXT NOT NULL,description TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,released_at INTEGER);
      CREATE INDEX IF NOT EXISTS work_intent_discussion ON work_intents(conversation_id,expires_at);`);
  }
  private writable(id: string, actor: string) {
    if (this.store.conversation(id).archived_at) throw new Error('请先恢复归档讨论。');
    if (actor !== 'human' && !this.store.sessions(id).some(s => s.agent === actor)) throw new Error('此成员已退出或不属于本讨论。');
  }
  grant(id: string, input: unknown) {
    const v = z.object({ path: z.string().trim().min(1).max(4096), label: z.string().trim().min(1).max(80).optional() }).strict().parse(input);
    this.writable(id, 'human');
    if (!isAbsolute(v.path)) throw new Error('请输入项目目录的完整路径。');
    const root = realpathSync(v.path);
    if (!statSync(root).isDirectory()) throw new Error('工作区必须是一个存在的目录。');
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT * FROM workspace_grants WHERE conversation_id=? AND root=? AND revoked_at IS NULL').get(id, root);
      if (old) return old;
      const grantId = randomUUID();
      this.store.db.prepare('INSERT INTO workspace_grants VALUES(?,?,?,?,?,NULL)').run(grantId, id, root, v.label || posix.basename(root) || root, this.now());
      return this.store.db.prepare('SELECT * FROM workspace_grants WHERE id=?').get(grantId);
    }, id);
  }
  revoke(id: string, grantId: string) {
    this.writable(id, 'human');
    return this.store.transaction(() => {
      const result = this.store.db.prepare('UPDATE workspace_grants SET revoked_at=coalesce(revoked_at,?) WHERE id=? AND conversation_id=?').run(this.now(), grantId, id);
      if (!result.changes) throw new Error('未找到本讨论的工作区授权。');
      return { revoked: true };
    }, id);
  }
  declare(id: string, actor: string, input: unknown) {
    this.writable(id, actor);
    const v = declaration.parse(input);
    // Segment comparisons, not string prefixes: src/a does not collide with src/ab.
    if (isAbsolute(v.path) || v.path.includes('\\') || v.path.includes('\0') || v.path.split('/').includes('..')) throw new Error('请使用工作区内的相对路径，不能包含 ..。');
    const path = posix.normalize(v.path).replace(/\/$/, '');
    const grant = this.store.db.prepare('SELECT id FROM workspace_grants WHERE id=? AND conversation_id=? AND revoked_at IS NULL').get(v.workspace_id, id);
    if (!grant) throw new Error('工作区尚未获得本讨论授权，或授权已撤销。');
    const intentId = this.store.transaction(() => {
      // Re-declaring one's same path renews the advisory lease, not a new lock.
      const old = this.store.db.prepare('SELECT id FROM work_intents WHERE conversation_id=? AND workspace_id=? AND agent=? AND path=? AND released_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(id, v.workspace_id, actor, path, this.now());
      const intentId = old?.id as string || randomUUID();
      if (old) this.store.db.prepare('UPDATE work_intents SET description=?,expires_at=? WHERE id=?').run(v.description, this.now() + v.ttl_seconds * 1000, intentId);
      else this.store.db.prepare('INSERT INTO work_intents VALUES(?,?,?,?,?,?,?,?,NULL)').run(intentId, id, v.workspace_id, actor, path, v.description, this.now(), this.now() + v.ttl_seconds * 1000);
      return intentId;
    }, id);
    const view = this.list(id);
    return { intent: view.intents.find(i => i.id === intentId), conflicts: view.conflicts.filter(c => c.intentIds.includes(intentId)), advisoryOnly: true };
  }
  release(id: string, actor: string, intentId: string) {
    this.writable(id, actor);
    return this.store.transaction(() => {
      const intent = this.store.db.prepare('SELECT agent FROM work_intents WHERE id=? AND conversation_id=?').get(intentId, id);
      if (!intent || intent.agent !== actor) throw new Error('只能释放自己声明的工作意图。');
      this.store.db.prepare('UPDATE work_intents SET released_at=coalesce(released_at,?) WHERE id=?').run(this.now(), intentId);
      return { released: true, advisoryOnly: true };
    }, id);
  }
  list(id: string) {
    const c = this.store.conversation(id);
    const grants = this.store.db.prepare('SELECT * FROM workspace_grants WHERE conversation_id=? ORDER BY created_at').all(id);
    const rows = this.store.db.prepare(`SELECT i.*,g.revoked_at,g.root,s.removed_at FROM work_intents i
      JOIN workspace_grants g ON g.id=i.workspace_id LEFT JOIN sessions s ON s.conversation_id=i.conversation_id AND s.agent=i.agent
      WHERE i.conversation_id=? AND ((i.released_at IS NULL AND i.expires_at>? AND g.revoked_at IS NULL AND s.removed_at IS NULL AND ?=0)
        OR i.id IN (SELECT id FROM work_intents WHERE conversation_id=? ORDER BY created_at DESC LIMIT 300))
      ORDER BY i.created_at DESC`).all(id, this.now(), c.archived_at ? 1 : 0, id) as unknown as Intent[];
    const intents = rows.map(i => ({ ...i, state: i.released_at ? 'released' : i.revoked_at ? 'revoked' : i.removed_at ? 'left' : c.archived_at ? 'archived' : i.expires_at <= this.now() ? 'expired' : 'active' }));
    const active = intents.filter(i => i.state === 'active');
    const conflicts: { intentIds: string[]; path: string; actors: string[] }[] = [];
    const overlaps = (a: string, b: string) => a === b || a === '/' || b === '/' || a.startsWith(b + '/') || b.startsWith(a + '/');
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!, b = active[j]!;
      const aPath = posix.resolve(a.root, a.path), bPath = posix.resolve(b.root, b.path);
      if (a.agent !== b.agent && overlaps(aPath, bPath)) conflicts.push({ intentIds: [a.id, b.id], path: aPath.length < bPath.length ? aPath : bPath, actors: [a.agent, b.agent] });
    }
    return { grants, intents, conflicts, advisoryOnly: true, scope: '本讨论中全部有效意图及最近 300 条历史声明；未扫描文件，不检测其他程序写入，符号链接别名可能无法识别。' };
  }
  tool(id: string, actor: string, name: string, args: unknown) {
    this.writable(id, actor);
    if (name === 'noah_list_workspaces') return this.list(id);
    if (name === 'noah_declare_work') return this.declare(id, actor, args);
    if (name === 'noah_release_work') return this.release(id, actor, z.object({ intent_id: z.string().uuid() }).strict().parse(args).intent_id);
    throw new Error('未知工作区工具。');
  }
}
