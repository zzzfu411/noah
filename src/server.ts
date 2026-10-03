import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from './store.ts';
import { Engine } from './engine.ts';
import { loadGrokConfig, listGrokModels, modelSummary, privateDir, redact, trackSecret } from './config.ts';
import { discoverHarnesses, type HarnessDiscoveryReport } from './discovery.ts';
import { NativeBridge } from './native-bridge.ts';
import { GrokNativeBridge } from './grok-native-bridge.ts';
import { createGrokJoinFiles } from './grok-native-setup.ts';
import { WorkspaceService } from './workspaces.ts';
import { searchMessages, messagePage, activityPage, exportDiscussion, diagnostics } from './queries.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const recipient = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(value => value !== 'human');
const participant = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(), harness: z.enum(['grok', 'pi']), label: z.string().trim().min(1).max(80).optional(), mode: z.enum(['managed', 'external']).optional(), bindingId: z.string().min(1).max(160).optional() }).strict();
const contextBudgetBytes = z.number().int().min(1).max(1024 * 1024 * 1024).nullable().optional();
const outcomeContent = { title: z.string().trim().min(1).max(160), content: z.string().min(1).max(64000), evidenceMessageIds: z.array(z.string().uuid()).min(1).max(50) };
const schemas = {
  create: z.object({ title: z.string().trim().min(1).max(160), participants: z.array(participant).min(1).max(16).optional(), modelAlias: z.string().min(1).max(200).optional(), limitsEnabled: z.boolean().optional(), maxRuns: z.number().int().min(1).max(100).optional(), minutes: z.number().int().min(1).max(240).optional(), contextBudgetBytes, clientKey: z.string().min(1).max(160).optional() }).strict(),
  send: z.object({ recipient, content: z.string().min(1).max(64000), clientKey: z.string().min(1).max(160), inReplyTo: z.string().optional() }).strict(),
  control: z.object({ action: z.enum(['pause', 'resume', 'stop', 'archive', 'restore']), limitsEnabled: z.boolean().optional(), additionalRuns: z.number().int().min(0).max(100).default(0), minutes: z.number().int().min(1).max(240).default(20), contextBudgetBytes, clientKey: z.string().min(1).max(160).optional() }).strict().refine(input => input.clientKey === undefined || input.action === 'resume'),
  addParticipant: z.object({ participant, shareHistory: z.boolean(), modelAlias: z.string().min(1).max(200).optional() }).strict(),
  outcome: z.object({ kind: z.enum(['conclusion', 'disagreement', 'open_question']), ...outcomeContent, clientKey: z.string().min(1).max(160).optional() }).strict(),
  reviseOutcome: z.object({ ...outcomeContent, expectedRevision: z.number().int().positive() }).strict(),
  decideOutcome: z.object({ decision: z.enum(['confirmed', 'reopened']), expectedRevision: z.number().int().positive() }).strict(),
  material: z.object({ name: z.string().min(1).max(200), content: z.string().max(10 * 1024 * 1024) }).strict(),
  tool: z.object({ name: z.string().max(80), args: z.unknown(), callId: z.string().min(1).max(200) }).strict(),
};
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  let size = 0; const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length; if (size > 11 * 1024 * 1024) throw new Error('Request too large');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function reply(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
export async function startServer(options: { dataDir?: string; port?: number; modelCheck?: boolean; discovery?: () => HarnessDiscoveryReport; engineFactory?: (store: Store, dataDir: string) => Engine } = {}) {
  const dataDir = privateDir(resolve(options.dataDir || process.env.NOAH_DATA_DIR || join(root, '.noah')));
  const lock = join(dataDir, 'server.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid server.lock; check the previous process before removing it');
    let alive = true;
    try { process.kill(pid, 0); } catch (error: any) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Noah 已在使用此数据目录；请打开已有实例。');
    unlinkSync(lock);
  }
  const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  const token = trackSecret(randomBytes(32).toString('hex'));
  const store = (() => {
    let opened: Store | undefined;
    try {
      opened = new Store(join(dataDir, 'noah.sqlite'));
      opened.recover();
      return opened;
    } catch (error) {
      opened?.close();
      // Initialization never acquired a usable service. Do not leave a live-PID
      // lock that would prevent a corrected configuration/version from retrying.
      unlinkSync(lock);
      throw error;
    }
  })();
  const engine = options.engineFactory ? options.engineFactory(store, dataDir) : new Engine(store, dataDir);
  const bridge = new NativeBridge(store);
  const grokBridge = new GrokNativeBridge(store);
  const workspaces = new WorkspaceService(store);
  const nativeSessions = () => [...bridge.list(), ...grokBridge.list()];
  const nativeWakes = () => [...bridge.wakes(), ...grokBridge.wakes()];
  const scanHarnesses = options.discovery || discoverHarnesses;
  let discovery: HarnessDiscoveryReport | undefined;
  const inventory = (refresh = false) => {
    if (!discovery || refresh) discovery = scanHarnesses();
    return discovery;
  };
  const streams = new Set<ServerResponse>();
  let url = '', port = 0;
  let changeTimer: NodeJS.Timeout | undefined;
  const notify = () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      const eventId = (store.db.prepare('SELECT max(id) AS id FROM events').get() as any).id || 0;
      for (const res of streams) {
        if (res.writableLength > 2 * 1024 * 1024) { res.end(); streams.delete(res); continue; }
        res.write(`id: ${eventId}\nevent: changed\ndata: {}\n\n`);
      }
    }, 150);
  };
  store.on('change', notify); store.on('output', notify);
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host || '')) return reply(res, 403, { error: 'Invalid host' });
      const origin = req.headers.origin;
      if (origin && ![url, `http://localhost:${port}`].includes(origin)) return reply(res, 403, { error: 'Cross-origin request denied' });
      const requestUrl = new URL(req.url || '/', url);
      const path = requestUrl.pathname;
      const staticTypes: Record<string, string> = {
        '/': 'text/html', '/app.js': 'text/javascript', '/maturity.js': 'text/javascript', '/rich-text.js': 'text/javascript', '/style.css': 'text/css',
        '/assets/noah/logo.png': 'image/png', '/assets/noah/favicon.png': 'image/png',
        '/assets/harnesses/grok.svg': 'image/svg+xml', '/assets/harnesses/pi.svg': 'image/svg+xml',
        '/assets/harnesses/codex.png': 'image/png', '/assets/harnesses/claude.png': 'image/png',
        '/assets/harnesses/gemini.png': 'image/png', '/assets/harnesses/opencode.svg': 'image/svg+xml',
        '/assets/harnesses/opencode-dark.svg': 'image/svg+xml',
      };
      if (req.method === 'GET' && Object.hasOwn(staticTypes, path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        res.writeHead(200, { 'Content-Type': staticTypes[path] + (staticTypes[path] === 'image/png' ? '' : '; charset=utf-8'), 'Cache-Control': 'no-store' });
        return res.end(readFileSync(join(root, 'public', file)));
      }
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
      if (path.startsWith('/api/grok-bridge/')) {
        const result = await grokBridge.handle(path, req.method || 'GET', bearer, req.method === 'POST' ? await body(req) : {});
        return reply(res, result?.status || 404, result?.body || { error: 'Unknown Grok bridge operation' });
      }
      if (path.startsWith('/api/bridge/')) {
        const result = await bridge.handle(path, req.method || 'GET', bearer, req.method === 'POST' ? await body(req) : {});
        if (result) return reply(res, result.status, result.body);
        return reply(res, 404, { error: 'Unknown bridge operation' });
      }
      if (path === '/api/tool' && req.method === 'POST') {
        const input = schemas.tool.parse(await body(req));
        try { return reply(res, 200, await engine.invoke(bearer, input.name, input.args, input.callId)); }
        catch (e) { return reply(res, 403, { error: redact(e) }); }
      }
      const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('noah_owner='))?.slice(11) || '';
      if (!sameSecret(bearer || cookie, token)) return reply(res, 401, { error: '请从 Noah 桌面应用打开；网页开发模式请使用 npm run open:web。' });
      if (path === '/api/pair' && req.method === 'POST') {
        res.setHeader('Set-Cookie', `noah_owner=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return reply(res, 200, { paired: true });
      }
      if (path === '/api/state' && req.method === 'GET') {
        const query = z.object({ compact: z.enum(['0', '1']).optional() }).strict().parse(Object.fromEntries(requestUrl.searchParams));
        let config: unknown;
        try { config = options.modelCheck === false ? { model: 'test', models: [] } : { ...modelSummary(loadGrokConfig()), models: listGrokModels() }; }
        catch (error) { config = { error: redact(error) }; }
        const messageCounts = store.db.prepare('SELECT conversation_id,count(*) AS count FROM messages GROUP BY conversation_id').all();
        return reply(res, 200, { ...store.snapshot({ compact: query.compact === '1' }), config, discovery: inventory(), nativeSessions: nativeSessions(), nativeWakes: nativeWakes(), nativeMetrics: bridge.metrics(), messageCounts });
      }
      if (path === '/api/native-sessions' && req.method === 'GET') return reply(res, 200, { sessions: nativeSessions() });
      if (path === '/api/grok-bridge-grants' && req.method === 'POST') {
        z.object({}).strict().parse(await body(req));
        return reply(res, 201, { ...createGrokJoinFiles({ directory: join(dataDir, 'grok-bridge-grants', randomUUID()), url, ...grokBridge.issueJoinToken() }), experimental: true, verification: 'Hook/CLI transport verified; original Grok session end-to-end not yet verified.' });
      }
      if (path === '/api/bridge-grants' && req.method === 'POST') {
        z.object({}).strict().parse(await body(req));
        const grant = bridge.issueJoinToken({});
        const directory = privateDir(join(dataDir, 'bridge-grants'));
        const grantPath = join(directory, `pi-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
        writeFileSync(grantPath, JSON.stringify({ url, joinToken: grant.joinToken }), { mode: 0o600 });
        return reply(res, 201, { grantPath, expiresAt: grant.expiresAt, extensionPath: join(root, 'extensions/noah-pi.ts'), connectCommand: `/noah-connect ${grantPath}` });
      }
      const revoke = path.match(/^\/api\/native-sessions\/([a-zA-Z0-9_-]+)\/revoke$/);
      if (revoke && req.method === 'POST') { z.object({}).strict().parse(await body(req)); const broker = grokBridge.list().some(b => b.id === revoke[1]) ? grokBridge : bridge; broker.revoke(revoke[1]!); return reply(res, 200, { revoked: true }); }
      const resolveNative = path.match(/^\/api\/native-wakes\/([a-f0-9-]+)\/resolve$/);
      if (resolveNative && req.method === 'POST') { z.object({}).strict().parse(await body(req)); const broker = grokBridge.wakes().some((w: any) => w.id === resolveNative[1]) ? grokBridge : bridge; broker.resolveWake(resolveNative[1]!); return reply(res, 200, { resolved: true, replayed: false }); }
      if (path === '/api/search' && req.method === 'GET') {
        const query = z.object({ q: z.string().min(1).max(200), conversationId: z.string().uuid().optional() }).strict().parse(Object.fromEntries(requestUrl.searchParams));
        return reply(res, 200, searchMessages(store, query.q, query.conversationId));
      }
      if (path === '/api/diagnostics' && req.method === 'GET') return reply(res, 200, { ...diagnostics(store), discovery: inventory(), nativeSessions: nativeSessions(), nativeWakes: nativeWakes(), nativeMetrics: bridge.metrics() });
      if (path === '/api/harnesses' && req.method === 'GET') {
        return reply(res, 200, inventory(true));
      }
      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        // The stream invalidates a query; every reconnect rehydrates from durable state.
        res.write('event: changed\ndata: {}\n\n'); streams.add(res);
        req.on('close', () => streams.delete(res)); return;
      }
      if (path === '/api/conversations' && req.method === 'POST') {
        const input = schemas.create.parse(await body(req));
        return reply(res, 201, store.create(input.title, input.maxRuns, input.minutes, input.modelAlias, input.limitsEnabled, input.participants, input.contextBudgetBytes, {
          clientKey: input.clientKey, prepare: () => {
            const managed = !input.participants || input.participants.some(p => p.mode !== 'external');
            for (const member of input.participants || []) {
              if (member.mode !== 'external') continue;
              if (!member.bindingId || !(member.harness === 'grok' ? grokBridge : bridge).get(member.bindingId)) throw new Error('原会话已断开，请重新连接后选择。');
            }
            return options.modelCheck === false || !managed ? input.modelAlias : loadGrokConfig(undefined, input.modelAlias).alias;
          },
        }));
      }
      const addMember = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/participants$/);
      if (addMember && req.method === 'POST') {
        const v = schemas.addParticipant.parse(await body(req)), c = store.conversation(addMember[1]!);
        if (v.participant.mode === 'external') {
          if (!v.participant.bindingId || !(v.participant.harness === 'grok' ? grokBridge : bridge).get(v.participant.bindingId)) throw new Error('原会话已断开，请重新连接后选择。');
        }
        const alias = v.participant.mode === 'external' || options.modelCheck === false ? v.modelAlias : loadGrokConfig(undefined, v.modelAlias || c.model_alias || undefined).alias;
        return reply(res, 201, store.addParticipant(c.id, v.participant, v.shareHistory, alias));
      }
      const removeMember = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/participants\/([A-Za-z0-9_-]+)\/remove$/);
      if (removeMember && req.method === 'POST') { z.object({}).strict().parse(await body(req)); return reply(res, 200, store.removeParticipant(removeMember[1]!, removeMember[2]!)); }
      const budget = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/context-budget$/);
      if (budget && req.method === 'POST') {
        const v = z.object({ contextBudgetBytes: contextBudgetBytes.unwrap() }).strict().parse(await body(req)), id = budget[1]!;
        if (store.conversation(id).archived_at) throw new Error('请先恢复归档讨论。');
        store.transaction(() => { store.db.prepare('UPDATE conversations SET context_budget_bytes=? WHERE id=?').run(v.contextBudgetBytes, id); }, id);
        return reply(res, 200, store.conversation(id));
      }
      const workspace = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/workspaces(?:\/([a-f0-9-]+)\/revoke)?$/);
      if (workspace) {
        const [, id, grantId] = workspace;
        if (req.method === 'GET' && !grantId) return reply(res, 200, workspaces.list(id!));
        if (req.method === 'POST' && !grantId) return reply(res, 201, workspaces.grant(id!, await body(req)));
        if (req.method === 'POST' && grantId) { z.object({}).strict().parse(await body(req)); return reply(res, 200, workspaces.revoke(id!, grantId)); }
      }
      const intent = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/work-intents(?:\/([a-f0-9-]+)\/release)?$/);
      if (intent && req.method === 'POST') {
        if (!intent[2]) return reply(res, 201, workspaces.declare(intent[1]!, 'human', await body(req)));
        z.object({}).strict().parse(await body(req)); return reply(res, 200, workspaces.release(intent[1]!, 'human', intent[2]));
      }
      const singleMessage = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/messages\/([a-f0-9-]+)$/);
      if (singleMessage && req.method === 'GET') {
        const message = store.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND id=?').get(singleMessage[1]!, singleMessage[2]!);
        return reply(res, message ? 200 : 404, message ? { message } : { error: '本讨论中未找到这条消息。' });
      }
      const materialRevision = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/materials\/([a-f0-9-]+)\/revisions$/);
      if (materialRevision && req.method === 'POST') { const v = schemas.material.parse(await body(req)); return reply(res, 201, store.reviseMaterial(materialRevision[1]!, materialRevision[2]!, v.name, v.content)); }
      const outcomes = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/outcomes(?:\/([a-f0-9-]+)\/(revisions|decision))?$/);
      if (outcomes) {
        const [, id, outcomeId, action] = outcomes; store.conversation(id!);
        if (req.method === 'GET' && !action) return reply(res, 200, { outcomes: store.outcomes(id), revisions: store.outcomeRevisions(id), decisions: store.db.prepare('SELECT d.* FROM outcome_decisions d JOIN outcomes o ON o.id=d.outcome_id WHERE o.conversation_id=? ORDER BY d.id').all(id!) });
        if (req.method === 'POST' && !action) return reply(res, 201, store.proposeOutcome(id!, 'human', schemas.outcome.parse(await body(req))));
        if (req.method === 'POST' && action === 'revisions') return reply(res, 201, store.reviseOutcome(id!, outcomeId!, 'human', schemas.reviseOutcome.parse(await body(req))));
        if (req.method === 'POST' && action === 'decision') { const v = schemas.decideOutcome.parse(await body(req)); return reply(res, 200, store.decideOutcome(id!, outcomeId!, v.decision, v.expectedRevision)); }
      }
      const materialMatch = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/materials\/([a-f0-9-]+)$/);
      if (materialMatch && req.method === 'GET') {
        const query = z.object({ offset: z.coerce.number().int().min(0).optional() }).strict().parse(Object.fromEntries(requestUrl.searchParams));
        store.conversation(materialMatch[1]!);
        return reply(res, 200, store.material(materialMatch[1]!, materialMatch[2]!, query.offset));
      }
      const activity = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/(runs|deliveries)$/);
      if (activity && req.method === 'GET') {
        const query = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(activity[2] === 'runs' ? 50 : 200).optional(), agent: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(), messageIds: z.string().transform(v => z.array(z.string().uuid()).min(1).max(100).parse(v.split(','))).optional() }).strict().parse(Object.fromEntries(requestUrl.searchParams));
        if (query.messageIds && activity[2] !== 'deliveries') throw new Error('消息定位仅用于回执查询。');
        return reply(res, 200, activityPage(store, activity[1]!, activity[2] as 'runs' | 'deliveries', query));
      }
      const match = path.match(/^\/api\/conversations\/([a-f0-9-]+)(?:\/(messages|control|materials|export))?$/);
      if (match) {
        const [, id, action] = match; store.conversation(id);
        if (action === 'messages' && req.method === 'GET') {
          const page = z.object({ before: z.coerce.number().int().positive().optional(), around: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict().parse(Object.fromEntries(requestUrl.searchParams));
          if (page.before !== undefined && page.around !== undefined) throw new Error('before 与 around 不能同时使用。');
          return reply(res, 200, messagePage(store, id, page));
        }
        if (action === 'messages' && req.method === 'POST') {
          const v = schemas.send.parse(await body(req));
          return reply(res, 201, store.send(id, 'human', v.recipient, v.content, v.clientKey, v.inReplyTo));
        }
        if (action === 'control' && req.method === 'POST') {
          const v = schemas.control.parse(await body(req));
          if (v.action === 'stop') { await engine.stopConversation(id); return reply(res, 200, store.conversation(id)); }
          return reply(res, 200, store.control(id, v.action, v.additionalRuns, v.minutes, v.limitsEnabled, v.contextBudgetBytes, v.clientKey));
        }
        if (action === 'materials' && req.method === 'POST') {
          const v = schemas.material.parse(await body(req));
          return reply(res, 201, store.addMaterial(id, v.name, v.content));
        }
        if (action === 'export' && req.method === 'GET') {
          if (requestUrl.searchParams.get('format') === 'json') {
            res.setHeader('Content-Disposition', 'attachment; filename="noah-discussion.json"');
            return reply(res, 200, { ...exportDiscussion(store, id), workspaceCoordination: workspaces.list(id) });
          }
          const c = store.conversation(id);
          const messages = store.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq').all(id) as any[];
          const content = `# ${c.title}\n\n` + messages.map(m => `## ${m.sender} → ${m.recipient}\n\n${m.content}\n\nMessage: ${m.id}\n`).join('\n')
            + '\n## 结论与问题\n\n' + store.outcomes(id).map(o => `### ${o.title}\n\n作者：${o.author} · ${o.kind} · v${o.current_revision} · ${o.status === 'confirmed' ? '用户确认此版本；不代表全员共识' : '待确认'}\n\n${o.content}\n\n依据：${o.evidence_message_ids.join(', ')}\n`).join('\n') + '\n完整版本与决定记录请导出 JSON。\n';
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="noah-conversation.md"' }); return res.end(content);
        }
      }
      const uncertain = path.match(/^\/api\/deliveries\/([a-f0-9-]+)\/resolve$/);
      if (uncertain && req.method === 'POST') { store.resolveUncertain(uncertain[1]); return reply(res, 200, { resolved: true }); }
      reply(res, 404, { error: 'Not found' });
    } catch (error) { reply(res, 400, { error: error instanceof z.ZodError ? '请求字段无效或超出允许范围。' : redact(error) }); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(process.env.PORT || 4317), '127.0.0.1', resolve); });
  } catch (e) { store.close(); unlinkSync(lock); throw e; }
  port = (server.address() as any).port; url = `http://127.0.0.1:${port}`; engine.url = url;
  writeFileSync(join(dataDir, 'connection.json'), JSON.stringify({ url, token, pid: process.pid }), { mode: 0o600 });
  const heartbeats = setInterval(() => {
    // Expiration must notify an already-open UI even after the native process disappears.
    // This only reconciles leases; it never starts a model or resumes a discussion.
    bridge.list(); grokBridge.list();
    for (const res of streams) res.write(': keepalive\n\n');
  }, 15000);
  const close = async () => {
    clearInterval(heartbeats); if (changeTimer) clearTimeout(changeTimer);
    for (const res of streams) res.end(); streams.clear();
    await engine.close();
    bridge.close(); grokBridge.close();
    if (changeTimer) clearTimeout(changeTimer);
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    if (existsSync(lock)) unlinkSync(lock);
    if (existsSync(join(dataDir, 'connection.json'))) unlinkSync(join(dataDir, 'connection.json'));
  };
  return { url, token, store, engine, bridge, grokBridge, workspaces, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(app => {
    console.log(`Noah 网页开发服务：${app.url}\n运行 npm run open:web 打开已配对的调试界面。`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (!stopping) { stopping = true; void app.close().then(() => process.exit(0)); }
    });
  }).catch(error => { console.error(redact(error)); process.exitCode = 1; });
}
