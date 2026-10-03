import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { localBridgeTransport, BridgeHttpError } from './native-bridge-client.ts';
import { formatGrokNativeOutput } from './grok-native-output.ts';

interface Grant { schemaVersion: 1; url: string; joinToken: string; expiresAt: number; bindingPath: string; joinCommand: string; monitorCommand: string; callCommand: string }
interface LocalBinding { bindingId: string; credential: string; nativeSessionId: string; projectDir: string }
function readPrivate<T>(path: string): T {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw new Error('Noah 授权文件必须为本机 0600 小文件');
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function loadGrokGrant(path: string) {
  const grant = readPrivate<Grant>(resolve(path));
  if (grant.schemaVersion !== 1 || !grant.bindingPath || !grant.joinCommand || !grant.monitorCommand || !grant.callCommand) throw new Error('Grok 授权文件格式无效');
  // Validate the URL even on the local-only join path.
  localBridgeTransport(grant.url);
  return grant;
}
function connection(grant: Grant) { return readPrivate<LocalBinding>(grant.bindingPath); }
async function call(grant: Grant, binding: LocalBinding, endpoint: string, input: unknown = {}) {
  return localBridgeTransport(grant.url)(`/api/grok-bridge/${endpoint}`, binding.credential, input);
}
/** Hook bodies stay local; the broker receives identity and hashed turn metadata. */
export async function runGrokHook(grantPath: string, event: any) {
  const grant = loadGrokGrant(grantPath);
  const nativeSessionId = String(event.sessionId || '');
  const eventName = String(event.hookEventName || event.hook_event_name || '').replaceAll('_', '').toLowerCase();
  if (!nativeSessionId || !event.cwd || event.subagentType) return;
  let binding: LocalBinding | undefined;
  if (existsSync(grant.bindingPath)) binding = connection(grant);
  if (!binding) {
    // A hook loaded in another session cannot consume the grant merely by running.
    if (eventName !== 'pretooluse' || event.toolName !== 'run_terminal_command' || event.toolInput?.command?.trim() !== grant.joinCommand) return;
    if (grant.expiresAt < Date.now()) throw new Error('Noah 加入授权已过期，请重新生成');
    const result = await localBridgeTransport(grant.url)('/api/grok-bridge/register', '', { joinToken: grant.joinToken, nativeSessionId, projectDir: resolve(event.cwd), label: 'Grok · 原工作会话', callCommand: grant.callCommand });
    binding = { bindingId: result.bindingId, credential: result.credential, nativeSessionId, projectDir: resolve(event.cwd) };
    writeFileSync(grant.bindingPath, JSON.stringify(binding), { mode: 0o600, flag: 'wx' });
  }
  if (binding.nativeSessionId !== nativeSessionId) return;
  const promptIdHash = typeof event.promptId === 'string' && event.promptId.length
    ? createHash('sha256').update(event.promptId).digest('hex') : undefined;
  if ((eventName === 'userpromptsubmit' || eventName === 'pretooluse') && promptIdHash) {
    await call(grant, binding, 'turn', { promptIdHash });
  }
  if (eventName === 'sessionend') await call(grant, binding, 'disconnect');
  if (eventName === 'precompact') await call(grant, binding, 'pause');
  if (eventName === 'stopcancelled') await call(grant, binding, 'pause', { cause: 'cancelled', ...(promptIdHash ? { promptIdHash } : {}) });
}
export function grokJoinDetails(grantPath: string) {
  const grant = loadGrokGrant(grantPath), binding = connection(grant);
  return { joined: true, nativeSessionId: binding.nativeSessionId, bindingId: binding.bindingId,
    monitor: { command: grant.monitorCommand, description: 'Noah shared discussion', persistent: true }, callCommand: grant.callCommand,
    instructions: 'Start this monitor inside the current Grok session. Follow noah_read next cursors until next=null. For contentEncoding=concat, concatenate contentChunks in order with no separator to recover the exact body; this also applies to noah_material. Publish only shared work using noah_send, then noah_complete. Completion is your report, not proof of comprehension. Keep private work private and existing permissions unchanged.',
    callExamples: [
      { name: 'noah_peers', args: {} },
      { name: 'noah_read', args: { batchId: '<from notification>' } },
      { name: 'noah_send', args: { conversationId: '<discussion>', recipient: '<peer id or all or human>', content: '<public message>', clientKey: '<unique per message>' } },
      { name: 'noah_complete', args: { batchId: '<batch>' } },
      { name: 'noah_request_human', args: { conversationId: '<discussion>', question: '<decision>', clientKey: '<unique>' } },
      { name: 'noah_read_outcomes', args: { conversationId: '<discussion>' } },
      { name: 'noah_propose_outcome', args: { conversationId: '<discussion>', kind: 'conclusion', title: '<proposal>', content: '<public position>', evidence_message_ids: ['<shared message ID>'], client_message_id: '<unique>' } },
      { name: 'noah_list_workspaces', args: { conversationId: '<discussion>' } },
      { name: 'noah_declare_work', args: { conversationId: '<discussion>', workspace_id: '<owner-shared workspace>', path: '<relative path>', description: '<your intended edit>', ttl_seconds: 900 } },
    ], usage: 'Run callCommand through run_terminal_command with the selected JSON object on stdin. Read all returned next pages; noah_complete rejects a batch with unread body pages.' };
}
interface ProcessIdentity { pid: number; parent: number; started: string; zombie: boolean }
function processIdentities(pids: number[]) {
  // Only known ancestor PIDs are queried. Never inspect process arguments or
  // enumerate the user's other processes/sessions.
  const output = execFileSync('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,stat=,lstart='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
  });
  const identities = new Map<number, ProcessIdentity>();
  for (const line of output.split('\n')) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (row) identities.set(Number(row[1]), { pid: Number(row[1]), parent: Number(row[2]), zombie: row[3].includes('Z'), started: row[4] });
  }
  return identities;
}
function monitorAncestorsUnchanged() {
  const ancestors: ProcessIdentity[] = [];
  const originalParent = process.ppid;
  let pid = originalParent;
  while (pid > 1 && ancestors.length < 32) {
    const identity = processIdentities([pid]).get(pid);
    if (!identity || identity.zombie || ancestors.some(item => item.pid === pid)) throw new Error('Noah 无法确认监控器的父进程链');
    ancestors.push(identity);
    pid = identity.parent;
  }
  // A lone shell already adopted by init is the observed orphan-monitor case.
  // This is only a negative lifetime check, not proof a Grok session is active.
  if (pid !== 1 || ancestors.length < 2) throw new Error('Noah 监控器已脱离原启动进程');
  return () => {
    if (process.ppid !== originalParent) return false;
    try {
      const current = processIdentities(ancestors.map(item => item.pid));
      return ancestors.every(old => {
        const now = current.get(old.pid);
        return now && !now.zombie && now.parent === old.parent && now.started === old.started;
      });
    } catch { return false; }
  };
}
export async function runGrokMonitor(grantPath: string, options: { signal?: AbortSignal; write?: (s: string) => void; intervalMs?: number } = {}) {
  const grant = loadGrokGrant(grantPath), binding = connection(grant);
  const write = options.write || (s => { process.stdout.write(s + '\n'); });
  const delay = () => new Promise<void>(resolveDelay => {
    const timer = setTimeout(done, options.intervalMs || 1500);
    function done() { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolveDelay(); }
    options.signal?.addEventListener('abort', done, { once: true });
  });
  try {
    // Initialization is inside the disconnect scope: an unreadable or already
    // orphaned parent chain must never renew a binding's lease.
    const ancestorsUnchanged = monitorAncestorsUnchanged();
    while (!options.signal?.aborted) {
      if (!ancestorsUnchanged()) return;
      try {
        const result = await call(grant, binding, 'poll');
        if (result.notification) {
          // Exactly one short line per batch; model-visible full bodies are fetched separately.
          write(result.notification.content);
        }
      } catch (error) {
        if (error instanceof BridgeHttpError && [401, 403, 409].includes(error.status)) return;
        // Both stdout and stderr feed Grok monitor; transient connection logs stay silent.
      }
      await delay();
    }
  } finally { try { await call(grant, binding, 'disconnect'); } catch { /* Lease expiry handles an unavailable broker. */ } }
}
async function stdinJson() {
  let text = '';
  for await (const chunk of process.stdin) { text += String(chunk); if (text.length > 1024 * 1024) throw new Error('Noah 输入过大'); }
  return JSON.parse(text);
}
async function main() {
  const [mode, path] = process.argv.slice(2);
  if (!path || !['hook', 'join', 'monitor', 'call'].includes(mode)) throw new Error('Usage: grok-native-cli.ts hook|join|monitor|call <grant.json>');
  if (mode === 'hook') { await runGrokHook(path, await stdinJson()); return; }
  if (mode === 'join') { process.stdout.write(formatGrokNativeOutput(grokJoinDetails(path))); return; }
  if (mode === 'call') {
    const grant = loadGrokGrant(path), input = await stdinJson();
    process.stdout.write(formatGrokNativeOutput(await call(grant, connection(grant), 'tool', input), input.name));
    return;
  }
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
  await runGrokMonitor(path, { signal: controller.signal });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print keys, raw hook inputs, provider data, or request errors into Grok's stream.
    if (process.argv[2] !== 'monitor') process.stderr.write('Noah Grok bridge could not complete this command. Check that the scoped hook is loaded and the join grant is current.\n');
    process.exitCode = 1;
  });
}
