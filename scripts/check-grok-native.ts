/** One opt-in native-contract probe. Real installed Grok; local scripted model; no paid API. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { GrokNativeBridge } from '../src/grok-native-bridge.ts';
import { createGrokJoinFiles } from '../src/grok-native-setup.ts';
import { shellQuote } from '../src/grok-native-setup.ts';
import { JsonRpcProcess } from '../src/jsonl.ts';
import { discoverHarnesses } from '../src/discovery.ts';
import { parse, stringify } from 'smol-toml';

/** Accept native text blocks and a CLI JSON result, including its escaped newlines. */
function containsFullBody(value: unknown, body: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === 'string') {
    if (value.includes(body)) return true;
    const candidates = [value.trim()];
    const start = value.indexOf('{');
    if (start > 0) candidates.push(value.slice(start).trim());
    for (const candidate of candidates) {
      try { if (containsFullBody(JSON.parse(candidate), body, depth + 1)) return true; } catch { /* Not an embedded JSON result. */ }
    }
    return false;
  }
  if (Array.isArray(value)) {
    const text = value.map(item => typeof item === 'string' ? item : item && typeof item.text === 'string' ? item.text : '').join('');
    return containsFullBody(text, body, depth + 1) || value.some(item => containsFullBody(item, body, depth + 1));
  }
  return !!value && typeof value === 'object' && Object.values(value).some(item => containsFullBody(item, body, depth + 1));
}
function readPages(value: unknown, depth = 0): any[] {
  if (depth > 8) return [];
  if (typeof value === 'string') {
    const start = value.indexOf('{');
    if (start < 0) return [];
    try { return readPages(JSON.parse(value.slice(start).trim()), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(item => readPages(item, depth + 1));
  if (!value || typeof value !== 'object') return [];
  if ('message' in value && typeof (value as any).message?.offset === 'number') {
    const page = value as any;
    const content = page.message.contentEncoding === 'concat' && Array.isArray(page.message.contentChunks) ? page.message.contentChunks.join('') : page.message.content;
    return [{ ...page, message: { ...page.message, content } }];
  }
  return Object.values(value).flatMap(item => readPages(item, depth + 1));
}
// Pure diagnostic check: exit before any temp directory, discovery, server or Grok process.
if (process.argv.includes('--check-text-matcher')) {
  const body = 'NOAH_NATIVE_PUBLIC_PROBE_中文_🔎\nSecond complete line.';
  assert.equal(containsFullBody([{ type: 'text', text: body }], body), true);
  assert.equal(containsFullBody([{ type: 'text', text: body.slice(0, 20) }, { type: 'text', text: body.slice(20) }], body), true);
  assert.equal(containsFullBody([{ type: 'text', text: 'exit: 0\n' + JSON.stringify({ message: { content: body } }) }], body), true);
  assert.equal(containsFullBody(JSON.stringify({ message: { content: 'NOAH_NATIVE_PUBLIC_PROBE_' } }), body), false);
  assert.equal(containsFullBody(body.replace('🔎', ''), body), false);
  console.log('Full-body matcher: raw text, text arrays, escaped CLI JSON, truncated body checks passed; no Grok launched.');
  process.exit(0);
}

const hookSource = process.argv.includes('--hook-source=config') ? 'isolated-config' : 'session-plugin';
const extended = process.argv.includes('--extended');
const busy = process.argv.includes('--busy');
const recovery = process.argv.find(arg => arg.startsWith('--recovery='))?.slice('--recovery='.length);
if (recovery && (!['cancel', 'exit'].includes(recovery) || extended || busy || hookSource !== 'isolated-config')) throw new Error('Use --recovery=cancel|exit with --hook-source=config, separately from --extended and --busy');
const temp = mkdtempSync(join(tmpdir(), 'noah-grok-native-probe-'));
const grok = process.env.NOAH_GROK_BIN || discoverHarnesses().harnesses.find(h => h.id === 'grok')?.executablePath;
if (!grok) throw new Error('Installed Grok is required for the native probe');
const store = new Store(join(temp, 'noah.sqlite')), bridge = new GrokNativeBridge(store);
const servers: Server[] = [];
let rpc: JsonRpcProcess | undefined;
let stage = 0, toolNames: string[] = [], modelCalls = 0, observedFullBody = false, observedSameSession = false;
let lastToolResults: unknown[] = [];
let nativeStderr = '';
let nativeCapabilities: unknown;
let terminalSchema: unknown;
const nativeUpdates = new Set<string>();
const registrationAttempts: Array<{ status: number; nativeSessionMatches: boolean; projectMatches: boolean }> = [];
const turnRequests: Array<{ status: number; hashOnly: boolean }> = [];
const cancellationRequests: Array<{ status: number; identityPresent: boolean; identityKnown: boolean }> = [];
let probeFailure = '', publicMessageQueued = false;
type OriginalPhase = 'allow_before' | 'allow_after' | 'deny';
let originalPhase: 'none' | OriginalPhase = 'none', originalToolRequested = false;
let collaborationFinished = false;
const modelRequestShapes: unknown[] = [];
let allowedOriginal = 0, deniedOriginal = 0, readPermissionWaiting = false, readPermissionReleased = false;
let releaseReadPermission: (() => void) | undefined;
let releaseBusyModel: (() => void) | undefined;
let busyModelHeld = false, busyModelReleased = false, busyModelCall = 0;
let joinPromptSettled = false, busyNotificationQueued = false;
let promptCalls = 0, cancelCalls = 0, promptsAtQueue = 0, cancelsAtQueue = 0;
let discussionAdditionalPrompts = 0, discussionAdditionalCancels = 0;
const busyNativeNoticeEvents = new Set<string>();
let releaseRecoveryModel: (() => void) | undefined;
let recoveryPhase: 'initial' | 'holding' | 'interrupted' | 'loading' | 'rejoining' = 'initial';
let recoveryModelHeld = false, recoveryModelAborted = false;
let recoveryEvidence: Record<string, unknown> | undefined;
let nativeTurnEvidence: Record<string, unknown> | undefined;
const permissionModes = new Set<string>();
const seenPages = new Map<string, any>();
const originalAllowedCommand = `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('NATIVE_ORIGINAL_TOOL_OK')")}`;
const originalAfterCommand = `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('NATIVE_AFTER_REVOKE_TOOL_OK')")}`;
const deniedFile = join(temp, 'must-not-be-written');
const originalDeniedCommand = `${shellQuote(process.execPath)} -e ${shellQuote(`require('node:fs').writeFileSync(${JSON.stringify(deniedFile)}, 'permission failed')`)}`;
let successSummary: Record<string, unknown> | undefined;
let nativeSession = '', batchId = '', conversationId = '', callCommand = '', joinCommand = '', monitorCommand = '';
const allowedCommands = new Set<string>();
const publicBody = extended ? 'a'.repeat(11999) + '🔎' + 'b'.repeat(12001) + '\nNOAH_NATIVE_PUBLIC_PROBE_中文_END' : 'NOAH_NATIVE_PUBLIC_PROBE_中文_🔎\nSecond complete line.';
let activeBody = publicBody, activeSeq = 1, activeReply = 'NATIVE_GROK_PUBLIC_REPLY';
const secondBody = 'SECOND_SHARED_MESSAGE_顺序必须保留';
const privateBody = 'PRIVATE_NATIVE_PROBE_MUST_NOT_BE_AUTO_SHARED';
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function until(check: () => boolean, timeout = 30000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error(`Native probe timed out at stage ${stage}`); await new Promise(r => setTimeout(r, 100)); }
}
function toolCall(name: string, args: unknown) { return { role: 'assistant', content: null, tool_calls: [{ id: `probe-${modelCalls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; }
function cliTool(name: string, args: unknown) {
  const command = `${callCommand} <<'NOAH_JSON'\n${JSON.stringify({ name, args })}\nNOAH_JSON`;
  allowedCommands.add(command);
  return toolCall('run_terminal_command', { command, description: 'Call isolated Noah bridge' });
}
try {
  const brokerUrl = await listen(createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const input = text ? JSON.parse(text) : {};
      const identityPresent = typeof input.promptIdHash === 'string' && /^[a-f0-9]{64}$/.test(input.promptIdHash);
      const identityKnown = req.url === '/api/grok-bridge/pause' && identityPresent &&
        !!store.db.prepare('SELECT 1 FROM grok_bridge_turns WHERE prompt_hash=?').get(input.promptIdHash);
      const result = await bridge.handle(req.url || '/', req.method || 'GET', (req.headers.authorization || '').replace(/^Bearer /, ''), input);
      if (req.url === '/api/grok-bridge/turn') turnRequests.push({ status: result?.status || 404, hashOnly: identityPresent && Object.keys(input).length === 1 });
      if (req.url === '/api/grok-bridge/pause' && input.cause === 'cancelled') cancellationRequests.push({ status: result?.status || 404, identityPresent, identityKnown });
      if (req.url === '/api/grok-bridge/register') {
        const metadata = text ? JSON.parse(text) : {};
        registrationAttempts.push({ status: result?.status || 404, nativeSessionMatches: metadata.nativeSessionId === nativeSession, projectMatches: metadata.projectDir === join(temp, 'work') });
      }
      res.writeHead(result?.status || 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(result?.body || {}));
    } catch { res.writeHead(500); res.end('{}'); }
  }));
  const modelUrl = await listen(createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const input = text ? JSON.parse(text) : {};
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end('{}'); return; }
    modelCalls++; toolNames = (input.tools || []).map((t: any) => t.function?.name);
    terminalSchema = (input.tools || []).find((t: any) => t.function?.name === 'run_terminal_command')?.function?.parameters;
    if (modelCalls > (extended || recovery ? 24 : 12)) { res.writeHead(503); res.end('{"error":{"message":"isolated probe request limit"}}'); return; }
    const latestUser = (input.messages || []).filter((m: any) => m.role === 'user').at(-1)?.content;
    const mainRequest = input.stream === true && toolNames.includes('run_terminal_command') && toolNames.includes('monitor') &&
      (originalPhase !== 'none' ? containsFullBody(latestUser, `NOAH_PROBE_${originalPhase}`) : containsFullBody(latestUser, privateBody) || (stage >= 3 && text.includes('Noah peer discussion')));
    modelRequestShapes.push({ stream: input.stream, tools: toolNames.length, stage, originalPhase, mainRequest, roles: (input.messages || []).slice(-3).map((m: any) => m.role) });
    if (mainRequest) lastToolResults = (input.messages || []).filter((m: any) => m.role === 'tool').map((m: any) => m.content);
    // A marker alone is insufficient: verify the complete body in a tool result.
    observedFullBody ||= lastToolResults.some(value => containsFullBody(value, activeBody));
    const pages = readPages(lastToolResults);
    for (const page of pages) seenPages.set(`${page.message.id}:${page.message.offset}`, page);
    // Reconstruct from a single native model request, not from broker output or
    // pages retained only by this test across separate model requests.
    const requestPages = new Map(pages.map(page => [`${page.message.id}:${page.message.offset}`, page]));
    const assembled = [...requestPages.values()].filter(page => page.message.seq === activeSeq).sort((a, b) => a.message.offset - b.message.offset).map(page => page.message.content).join('');
    observedFullBody ||= assembled === activeBody;
    // Restored history still contains earlier monitor notices. Only the current
    // outstanding batch may advance the scripted discussion to its first read.
    const currentNotice = stage === 3 && publicMessageQueued ? bridge.wakes().find((wake: any) => wake.state === 'notified' && wake.conversation_id === conversationId && text.includes(`batch ${wake.id}`)) as any : undefined;
    let message: any;
    if (!mainRequest || recoveryPhase === 'interrupted' || recoveryPhase === 'loading') message = { role: 'assistant', content: 'Isolated probe metadata response.' };
    else if (busyModelHeld && !busyModelReleased) {
      probeFailure = 'concurrent_main_request_while_original_model_held';
      message = { role: 'assistant', content: 'Unexpected parallel original work request. Stop the isolated probe.' };
    }
    else if (originalPhase !== 'none') {
      if (!originalToolRequested) { originalToolRequested = true; message = toolCall('run_terminal_command', { command: originalPhase === 'allow_before' ? originalAllowedCommand : originalPhase === 'allow_after' ? originalAfterCommand : originalDeniedCommand, description: 'Check original isolated client permission' }); }
      else message = { role: 'assistant', content: 'Original work phase finished.' };
    }
    else if (stage === 0) { message = toolCall('run_terminal_command', { command: joinCommand, description: 'Join isolated Noah probe' }); stage++; }
    else if (stage === 1) {
      if (!bridge.list().some(binding => binding.nativeSessionId === nativeSession)) {
        probeFailure = 'join_registration_missing';
        message = { role: 'assistant', content: 'Join did not register the original session. Stop the probe before starting monitor.' };
      } else { message = toolCall('monitor', { command: monitorCommand, description: 'Noah isolated protocol probe', persistent: true }); stage++; }
    }
    else if (stage === 2) {
      if (busy) {
        busyModelHeld = true; busyModelCall = modelCalls;
        // Hold a real original-session model request after monitor startup.
        // No response bytes leave this HTTP handler until the test releases it.
        await new Promise<void>(resolve => { releaseBusyModel = resolve; });
        busyModelReleased = true;
      }
      message = { role: 'assistant', content: 'Original native monitor ready.' }; stage++;
    }
    else if (stage === 3 && currentNotice) { batchId = currentNotice.id; message = cliTool('noah_read', { batchId }); stage++; }
    else if (stage === 4 && !pages.length) { probeFailure = 'native_page_not_parseable'; message = { role: 'assistant', content: 'Native page could not be parsed. Stop this isolated probe.' }; }
    else if (stage === 4 && pages.at(-1)?.next) message = cliTool('noah_read', pages.at(-1).next);
    else if (stage === 4 && observedFullBody && recovery && recoveryPhase === 'initial') {
      recoveryPhase = 'holding'; recoveryModelHeld = true;
      await new Promise<void>(resolve => { releaseRecoveryModel = resolve; });
      // The held request belongs to the interrupted process, never the resumed
      // writer. Its response must not publish a late reply after cancellation.
      if (recoveryModelAborted) { res.destroy(); return; }
      probeFailure = 'recovery_hold_released_without_interrupt';
      message = { role: 'assistant', content: 'Recovery probe aborted.' };
    }
    else if (stage === 4 && observedFullBody && (!extended || pages.some(page => page.message.content === secondBody))) { message = cliTool('noah_send', { conversationId, recipient: 'human', content: activeReply, clientKey: recoveryPhase === 'rejoining' ? 'recovered-native-probe-reply' : 'native-probe-reply' }); stage++; }
    else if (stage === 5) { message = cliTool('noah_complete', { batchId }); stage++; }
    else { message = { role: 'assistant', content: 'Native bridge probe finished.' }; if (stage === 6) stage = 7; }
    const base = { id: `probe-${modelCalls}`, created: Math.floor(Date.now() / 1000), model: 'noah-local-probe' };
    if (input.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((tc: any) => ({ index: 0, ...tc })) } : message;
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  }));
  const home = join(temp, 'grok-home'), isolatedHome = join(temp, 'home'), work = join(temp, 'work'), plugin = join(temp, 'plugin');
  for (const path of [home, isolatedHome, work, join(plugin, 'hooks')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.toml'), stringify({ models: { default: 'noah-local-probe' }, model: { 'noah-local-probe': { model: 'noah-local-probe', api_backend: 'chat_completions', base_url: modelUrl + '/v1', api_key: 'noah-local-test-key', context_window: 128000, max_completion_tokens: 1000, max_retries: 0 } }, cli: { auto_update: false, use_leader: false }, plugins: { enabled: ['noah-native-probe'] }, features: { backend_tools: false } }), { mode: 0o600 });
  let files = createGrokJoinFiles({ directory: join(temp, 'join'), url: brokerUrl, ...bridge.issueJoinToken() });
  ({ joinCommand, monitorCommand } = files); callCommand = JSON.parse(readFileSync(files.grantPath, 'utf8')).callCommand;
  allowedCommands.add(joinCommand); allowedCommands.add(monitorCommand); allowedCommands.add(originalAllowedCommand); allowedCommands.add(originalAfterCommand);
  writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'noah-native-probe', version: '0.0.1', description: 'Isolated Noah original-process protocol probe' }));
  const observer = join(temp, 'hook-probe.mjs'), observations = join(temp, 'hook-observations.jsonl');
  let bindingPath = JSON.parse(readFileSync(files.grantPath, 'utf8')).bindingPath;
  const writeObserver = () => writeFileSync(observer, `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const log=value=>appendFileSync(${JSON.stringify(observations)},JSON.stringify(value)+'\\n');
log({phase:'bootstrap_started'});
let text='';for await(const chunk of process.stdin)text+=chunk;
try {
  const {runGrokHook}=await import(${JSON.stringify(new URL('../src/grok-native-cli.ts', import.meta.url).href)});
  const e=JSON.parse(text);
  log({phase:'entered',event:e.hookEventName||e.hook_event_name,name:e.toolName,session:e.sessionId,
    permissionMode:e.permissionMode,
    promptIdentityPresent:typeof e.promptId==='string'&&e.promptId.length>0,
    cwdPresent:typeof e.cwd==='string',sessionMatchesEnvironment:e.sessionId===process.env.GROK_SESSION_ID,
    subagentTypePresent:!!e.subagentType,toolInputTruncated:e.toolInputTruncated===true,
    commandMatches:typeof e.toolInput?.command==='string'&&e.toolInput.command.trim()===${JSON.stringify(joinCommand)}});
  await runGrokHook(${JSON.stringify(files.grantPath)},e);
  const bindingExists=existsSync(${JSON.stringify(bindingPath)});
  const binding=bindingExists?JSON.parse(readFileSync(${JSON.stringify(bindingPath)},'utf8')):undefined;
  log({phase:'returned',bindingExists,sessionMatchesBinding:binding?.nativeSessionId===e.sessionId,
    registered:bindingExists&&binding?.nativeSessionId===e.sessionId});
} catch(error) { log({phase:'error',errorClass:error?.constructor?.name,code:error?.code||null}); }
`);
  writeObserver();
  const hooks = JSON.parse(readFileSync(files.hookPath, 'utf8'));
  for (const groups of Object.values(hooks.hooks) as any[]) for (const group of groups) group.hooks[0].command = `${shellQuote(process.execPath)} ${shellQuote(observer)}`;
  writeFileSync(join(plugin, 'hooks', 'hooks.json'), JSON.stringify(hooks));
  if (hookSource === 'isolated-config') {
    const configPath = join(home, 'config.toml');
    writeFileSync(configPath, stringify({ ...parse(readFileSync(configPath, 'utf8')), hooks: hooks.hooks }), { mode: 0o600 });
  }
  // Verify the observer can load Noah's module in the same isolated working
  // directory. A mismatching command must not consume the real join grant.
  execFileSync(process.execPath, [observer], { cwd: work, input: JSON.stringify({ hookEventName: 'pre_tool_use', sessionId: 'observer-self-check', cwd: work, toolName: 'run_terminal_command', toolInput: { command: 'observer-self-check-no-join' } }),
    env: { PATH: process.env.PATH, HOME: isolatedHome, TMPDIR: temp, GROK_HOME: home }, encoding: 'utf8', timeout: 10000 });
  const observerCheck = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(observerCheck.some(row => row.phase === 'entered' && row.commandMatches === false));
  assert.ok(observerCheck.some(row => row.phase === 'returned' && row.registered === false));
  assert.equal(bridge.list().length, 0);
  writeFileSync(observations, '', { mode: 0o600 });
  const profile = join(temp, 'native-probe.md');
  writeFileSync(profile, '---\nname: noah-native-probe\ndescription: Isolated native protocol probe\ntools: run_terminal_command, monitor\n---\nThis is an isolated local transport probe. Only execute the supplied Noah bridge commands.\n');
  const startNative = async () => {
  rpc = new JsonRpcProcess(grok, ['agent', '--no-leader', '--agent-profile', profile, ...(hookSource === 'session-plugin' ? ['--plugin-dir', plugin] : []), '--model', 'noah-local-probe', 'stdio'], { cwd: work,
    env: { PATH: process.env.PATH, HOME: isolatedHome, TMPDIR: temp, GROK_HOME: home, XAI_API_KEY: 'noah-local-test-key', NO_PROXY: '127.0.0.1,localhost' } });
  const nativeSend = rpc.send.bind(rpc);
  rpc.send = (message: unknown) => {
    const method = (message as any)?.method;
    if (method === 'session/prompt') promptCalls++;
    if (method === 'session/cancel') cancelCalls++;
    nativeSend(message);
  };
  rpc.child.stderr.on('data', chunk => { nativeStderr = (nativeStderr + chunk.toString()).slice(-6000); });
  rpc.handleRequest = async (method, params) => {
    if (method !== 'session/request_permission') throw new Error('No probe client capability');
    const commands = (value: unknown): string[] => !value || typeof value !== 'object' ? [] : Object.entries(value).flatMap(([key, item]) => key === 'command' && typeof item === 'string' ? [item] : commands(item));
    const requested = commands(params.toolCall?.rawInput);
    if (requested.includes(originalDeniedCommand)) deniedOriginal++;
    if (!requested.length || requested.some(command => !allowedCommands.has(command))) {
      const deny = params.options?.find((o: any) => o.kind === 'reject_once');
      return { outcome: deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
    }
    const allow = params.options?.find((o: any) => o.kind === 'allow_once');
    if (!allow) throw new Error('No native allow-once choice');
    if (requested.includes(originalAllowedCommand) || requested.includes(originalAfterCommand)) allowedOriginal++;
    if (extended && !readPermissionReleased && requested.some(command => command.includes('"name":"noah_read"'))) {
      readPermissionWaiting = true;
      await new Promise<void>(resolve => { releaseReadPermission = resolve; });
      readPermissionReleased = true;
    }
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  };
  rpc.on('notification', (method, params) => {
    nativeUpdates.add(`${method}:${params?.update?.sessionUpdate || ''}`);
    if (busyModelHeld && !busyModelReleased && publicMessageQueued && JSON.stringify(params).includes('Noah peer discussion')) {
      busyNativeNoticeEvents.add(`${method}:${params?.update?.sessionUpdate || ''}`);
    }
    if (publicMessageQueued && method === 'session/update' && params.sessionId === nativeSession) observedSameSession = true;
    // Monitor-triggered turns have no pending session/prompt RPC to complete.
    // This isolated process owns exactly one session; use its native turn event.
    if (stage === 7 && method === '_x.ai/session_notification' && params?.update?.sessionUpdate === 'turn_completed') collaborationFinished = true;
  });
  const init = await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'noah-native-probe', version: '0.4' }, clientCapabilities: {} });
  nativeCapabilities = { version: init._meta?.agentVersion, hooks: init.agentCapabilities?._meta?.['x.ai/hooks'], pluginDirs: init._meta?.['x.ai/pluginDirs'], model: init._meta?.modelState?.currentModelId, loadSession: init.agentCapabilities?.loadSession };
  if (init.authMethods?.some((a: any) => a.id === 'xai.api_key')) await rpc.request('authenticate', { methodId: 'xai.api_key', _meta: { headless: true } });
  return init;
  };
  const init = await startNative();
  assert.ok(rpc);
  if (recovery) assert.equal(init.agentCapabilities?.loadSession, true, 'Native ACP must advertise session/load before the recovery probe');
  const native = await rpc.request('session/new', { cwd: work, mcpServers: [], ...(hookSource === 'session-plugin' ? { _meta: { pluginDirs: [plugin] } } : {}) }, 60000);
  nativeSession = native.sessionId;
  const originalPid = rpc.child.pid, configBefore = readFileSync(join(home, 'config.toml'), 'utf8');
  const originalWork = async (phase: OriginalPhase) => {
    originalPhase = phase; originalToolRequested = false;
    await rpc!.request('session/prompt', { sessionId: nativeSession, prompt: [{ type: 'text', text: `NOAH_PROBE_${phase}: Run the isolated original permission check.` }] }, 60000);
    originalPhase = 'none';
  };
  if (extended) {
    await originalWork('allow_before');
    assert.ok(lastToolResults.some(value => containsFullBody(value, 'NATIVE_ORIGINAL_TOOL_OK')));
    assert.equal(allowedOriginal, 1);
  }
  const joinTurn = rpc.request('session/prompt', { sessionId: nativeSession, prompt: [{ type: 'text', text: privateBody + '\nJoin the isolated Noah protocol probe using your existing native tools.' }] }, 60000);
  // Observe both outcomes immediately so an early failure is handled while busy
  // mode waits for the HTTP hold; awaiting joinTurn below still reports errors.
  void joinTurn.then(() => { joinPromptSettled = true; }, () => { joinPromptSettled = true; });
  if (busy) {
    await until(() => {
      if (joinPromptSettled) throw new Error('Original prompt ended before its model request could be held');
      return busyModelHeld;
    });
  } else await joinTurn;
  assert.equal(probeFailure, '', 'Hook registration failed; inspect sanitized observer and broker registration diagnostics before any monitor retry');
  await until(() => bridge.list().some(b => b.status === 'idle'));
  const binding = bridge.list()[0]; assert.equal(binding.nativeSessionId, nativeSession);
  if (recovery) {
    // The first UserPromptSubmit precedes explicit registration, and some Grok
    // versions omit promptId on PreToolUse. Keep that unobserved turn unknown;
    // establish a real post-join turn before testing a positive batch floor.
    await originalWork('allow_before');
    assert.ok(lastToolResults.some(value => containsFullBody(value, 'NATIVE_ORIGINAL_TOOL_OK')));
    assert.equal(allowedOriginal, 1);
  }
  const c = store.create('Native isolated probe', undefined, undefined, undefined, false, [{ id: 'original', harness: 'grok', mode: 'external', bindingId: binding.id }]); conversationId = c.id;
  publicMessageQueued = true; promptsAtQueue = promptCalls; cancelsAtQueue = cancelCalls;
  store.send(c.id, 'human', 'original', publicBody, 'native-input');
  if (extended) {
    store.send(c.id, 'human', 'original', secondBody, 'native-input-second');
    store.send(c.id, 'human', 'original', secondBody, 'native-input-second');
    assert.equal(store.messages(c.id).length, 2);
  }
  await until(() => bridge.wakes().length > 0); batchId = String((bridge.wakes()[0] as any).id);
  if (busy) {
    assert.equal(joinPromptSettled, false, 'Original session/prompt must still be pending at notification admission');
    assert.equal(busyModelReleased, false);
    assert.equal(observedFullBody, false);
    assert.equal((bridge.wakes()[0] as any).state, 'notified');
    assert.ok((store.snapshot().deliveries as any[]).filter(d => d.agent === 'original').every(d => d.state === 'monitor_notified'));
    assert.equal((store.db.prepare('SELECT sum(read_chars) AS chars FROM grok_bridge_items').get() as any).chars, 0);
    busyNotificationQueued = true;
    releaseBusyModel!();
  }
  if (extended) {
    await until(() => readPermissionWaiting);
    assert.equal(observedFullBody, false);
    assert.equal(store.messages(c.id).length, 2);
    assert.equal(bridge.wakes().length, 1);
    assert.equal((store.db.prepare('SELECT sum(read_chars) AS chars FROM grok_bridge_items').get() as any).chars, 0);
    releaseReadPermission!();
  }
  if (recovery) {
    await until(() => recoveryModelHeld);
    assert.equal(observedFullBody, true, 'The original model must have received the public body before interruption');
    assert.equal((bridge.wakes()[0] as any).state, 'notified');
    assert.equal(store.messages(c.id).filter(m => m.sender === 'original').length, 0);
    const turnCount = (store.db.prepare('SELECT count(*) AS count FROM grok_bridge_turns WHERE binding_id=?').get(binding.id) as any).count;
    const turnFloor = (store.db.prepare('SELECT observed_turn_floor AS floor FROM grok_bridge_batches WHERE id=?').get(batchId) as any).floor;
    assert.ok(turnCount >= 2, 'Real post-join work and monitor turns must provide distinct observed identities');
    assert.ok(turnFloor > 0, 'The native batch must freeze an observed turn boundary');
    assert.ok(turnRequests.some(request => request.status === 200));
    assert.ok(turnRequests.every(request => request.hashOnly), 'Turn observation must carry only the hashed ID');
    nativeTurnEvidence = { observedDistinctTurnsBeforeInterruption: turnCount, frozenBatchTurnFloor: turnFloor, observationPayloadsHashOnly: true };
    const interruptedBatch = batchId, oldRpc = rpc;
    const oldCredential = JSON.parse(readFileSync(bindingPath, 'utf8')).credential;
    const closeOriginal = async () => {
      await oldRpc.close();
      await until(() => oldRpc.child.exitCode !== null || oldRpc.child.signalCode !== null, 5000);
    };
    recoveryPhase = 'interrupted'; recoveryModelAborted = true;
    if (recovery === 'cancel') {
      oldRpc.notify('session/cancel', { sessionId: nativeSession });
      await until(() => bridge.list()[0].status === 'paused');
      assert.equal(oldRpc.child.exitCode, null, 'Cancelling an original turn must not kill its process');
      const events = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.ok(events.some(event => event.phase === 'entered' && String(event.event).replaceAll('_', '').toLowerCase() === 'stopcancelled' && event.session === nativeSession));
      assert.ok(events.some(event => event.phase === 'entered' && String(event.event).replaceAll('_', '').toLowerCase() === 'userpromptsubmit' && event.promptIdentityPresent));
      assert.ok(cancellationRequests.some(request => request.status === 200 && request.identityPresent && request.identityKnown));
      nativeTurnEvidence = { ...nativeTurnEvidence, nativeSubmitHookObserved: true, cancellationIdentityWasPreviouslyObserved: true };
    } else await closeOriginal();
    await until(() => bridge.wakes().some((wake: any) => wake.id === interruptedBatch && wake.state === 'uncertain'), 35000);
    assert.equal((await bridge.handle('/api/grok-bridge/poll', 'POST', oldCredential, {}))?.status, 401);
    assert.equal(store.conversation(c.id).used_runs, 1, 'The interrupted batch must not be sent again automatically');
    assert.equal((store.snapshot().deliveries as any[]).filter(delivery => delivery.agent === 'original')[0].state, 'uncertain');
    assert.equal(store.messages(c.id).filter(m => m.sender === 'original').length, 0);
    // These are explicit owner decisions. Acknowledging uncertain delivery alone
    // does not reactivate a paused credential or authorize a new native writer.
    bridge.resolveWake(interruptedBatch);
    bridge.revoke(binding.id);
    await closeOriginal();
    const oldProcessExited = oldRpc.child.exitCode !== null || oldRpc.child.signalCode !== null;
    assert.equal(oldProcessExited, true);
    releaseRecoveryModel!();

    files = createGrokJoinFiles({ directory: join(temp, 'join-recovery'), url: brokerUrl, ...bridge.issueJoinToken() });
    ({ joinCommand, monitorCommand } = files);
    const freshGrant = JSON.parse(readFileSync(files.grantPath, 'utf8'));
    callCommand = freshGrant.callCommand; bindingPath = freshGrant.bindingPath;
    allowedCommands.add(joinCommand); allowedCommands.add(monitorCommand);
    // Only the isolated observer changes to the new private grant. Its configured
    // hook command, model, tools and permission settings remain the same.
    writeObserver();
    recoveryPhase = 'loading'; publicMessageQueued = false;
    stage = 0; batchId = ''; collaborationFinished = false;
    activeBody = publicBody + '\nRECOVERED_NEW_PUBLIC_MESSAGE'; activeSeq = 2; activeReply = 'RECOVERED_NATIVE_GROK_PUBLIC_REPLY';
    observedFullBody = false; observedSameSession = false; lastToolResults = []; seenPages.clear();
    const restoredInit = await startNative();
    assert.equal(restoredInit.agentCapabilities?.loadSession, true);
    assert.ok(rpc);
    assert.notEqual(rpc.child.pid, originalPid);
    const loaded = await rpc.request('session/load', { sessionId: nativeSession, cwd: work, mcpServers: [] }, 60000);
    if (loaded.sessionId !== undefined) assert.equal(loaded.sessionId, nativeSession);
    recoveryPhase = 'rejoining';
    await rpc.request('session/prompt', { sessionId: nativeSession, prompt: [{ type: 'text', text: privateBody + '\nThe owner checked the old interrupted batch. Rejoin Noah with the new scoped grant and continue original work.' }] }, 60000);
    await until(() => bridge.list()[0].status === 'idle');
    const restoredBinding = bridge.list()[0], restoredLocal = JSON.parse(readFileSync(bindingPath, 'utf8'));
    assert.equal(restoredBinding.id, binding.id); assert.equal(restoredBinding.nativeSessionId, nativeSession);
    assert.notEqual(restoredLocal.credential, oldCredential);
    assert.equal((await bridge.handle('/api/grok-bridge/poll', 'POST', oldCredential, {}))?.status, 401);
    assert.equal(store.conversation(c.id).used_runs, 1);
    assert.equal((store.db.prepare('SELECT state FROM grok_bridge_batches WHERE id=?').get(interruptedBatch) as any).state, 'cancelled');
    assert.equal((store.snapshot().deliveries as any[]).filter(delivery => delivery.agent === 'original')[0].state, 'cancelled');
    publicMessageQueued = true; promptsAtQueue = promptCalls; cancelsAtQueue = cancelCalls;
    store.send(c.id, 'human', 'original', activeBody, 'recovered-native-input');
    await until(() => bridge.wakes().length > 0);
    batchId = String((bridge.wakes()[0] as any).id);
    assert.notEqual(batchId, interruptedBatch);
    recoveryEvidence = { interruption: recovery, acceptedBodyBeforeInterruption: true, interruptedBatchUncertain: true, noAutomaticReplay: true, ownerAcknowledgedAndRevoked: true, oldProcessExitedBeforeLoad: oldProcessExited, oldCredentialRejectedAfterRejoin: true, sameNativeSessionLoaded: true, sameBindingReused: true };
  }
  await until(() => { if (probeFailure) throw new Error(probeFailure); return store.messages(c.id).some(m => m.content === activeReply); }, 45000);
  await until(() => (store.snapshot().deliveries as any[]).some(d => d.state === 'agent_reported'));
  assert.equal(observedFullBody, true); assert.equal(observedSameSession, true);
  assert.equal(JSON.stringify(store.snapshot()).includes(privateBody), false);
  if (extended || busy || recovery) await until(() => collaborationFinished);
  if (recovery) {
    assert.equal(store.conversation(c.id).used_runs, 2);
    assert.equal((store.snapshot().deliveries as any[]).filter(delivery => delivery.state === 'agent_reported').length, 1);
    assert.equal(promptCalls - promptsAtQueue, 0); assert.equal(cancelCalls - cancelsAtQueue, 0);
    await originalWork('allow_after');
    assert.ok(lastToolResults.some(value => containsFullBody(value, 'NATIVE_AFTER_REVOKE_TOOL_OK')));
    assert.equal(allowedOriginal, 2);
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), configBefore);
    recoveryEvidence = { ...recoveryEvidence, recoveredPublicBodyInOriginalModel: observedFullBody, recoveredReplyAndNativeTurnCompleted: collaborationFinished, additionalRecoveryDiscussionPrompts: 0, additionalRecoveryDiscussionCancels: 0, originalWorkContinuesAfterLoad: true, originalModelAndPermissionConfigPreserved: true };
  }
  if (busy) {
    const joined = await joinTurn;
    assert.notEqual(joined.stopReason, 'cancelled');
    assert.equal(busyNotificationQueued, true);
    assert.equal(busyModelReleased, true);
    assert.equal(rpc.child.pid, originalPid); assert.equal(rpc.child.exitCode, null);
    discussionAdditionalPrompts = promptCalls - promptsAtQueue;
    discussionAdditionalCancels = cancelCalls - cancelsAtQueue;
    assert.equal(discussionAdditionalPrompts, 0);
    assert.equal(discussionAdditionalCancels, 0);
  }
  if (extended) {
    assert.equal(seenPages.size, 4);
    assert.equal((store.snapshot().deliveries as any[]).filter(d => d.state === 'agent_reported').length, 2);
    bridge.revoke(binding.id);
    await originalWork('deny');
    assert.equal(deniedOriginal, 1); assert.equal(existsSync(deniedFile), false);
    await originalWork('allow_after');
    assert.equal(allowedOriginal, 2);
    assert.ok(lastToolResults.some(value => containsFullBody(value, 'NATIVE_AFTER_REVOKE_TOOL_OK')));
    assert.equal(rpc.child.pid, originalPid); assert.equal(rpc.child.exitCode, null);
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), configBefore);
    for (const line of readFileSync(observations, 'utf8').trim().split('\n')) { const event = JSON.parse(line); if (event.permissionMode) permissionModes.add(event.permissionMode); }
    assert.deepEqual([...permissionModes], ['default']);
  }
  successSummary = { installedVersion: nativeCapabilities, hookSource, originalSessionPreserved: binding.nativeSessionId === nativeSession, realHookRegistration: true, realNativeMonitorWake: true, fullSharedBodyInModelRequest: observedFullBody, explicitPublicReply: true, privateHistoryNotImported: true, localScriptedModelCalls: modelCalls, paidModelCalls: 0,
    ...(extended ? { uniquePages: seenPages.size, fullBodyCodeUnits: publicBody.length, approvalWaitPreserved: readPermissionReleased, originalAllowed: allowedOriginal, originalDenied: deniedOriginal, originalContinuesAfterRevoke: true, originalPidAndConfigPreserved: true, hookPermissionModes: [...permissionModes] } : {}),
    ...(busy ? { busyScenario: { heldOriginalModelCall: busyModelCall, monitorQueuedBeforeOriginalPromptReturned: busyNotificationQueued, originalPromptReturnedAfterRelease: joinPromptSettled && busyModelReleased, nativeTurnCompleted: collaborationFinished, additionalPromptCalls: discussionAdditionalPrompts, additionalCancelCalls: discussionAdditionalCancels, nativeNoticeEventsWhileHeld: [...busyNativeNoticeEvents], originalPidPreserved: rpc.child.pid === originalPid } } : {}),
    ...(recovery ? { recoveryScenario: recoveryEvidence, nativeTurnEvidence } : {}),
    verificationBoundary: `Real Grok ACP with ${hookSource} hooks + real built-in tools + scripted loopback provider; interactive TUI hot-loading remains unverified.` };
} catch (error) {
  const toolDiagnostics = lastToolResults.map(value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return { length: text.length, maxLine: Math.max(...text.split('\n').map(line => line.length)), head: text.slice(0, 250), tail: text.slice(-650) }; });
  console.error(JSON.stringify({ stage, hookSource, probeFailure, modelCalls, modelRequestShapes, toolNames, terminalSchema, bindings: bridge.list(), registrationAttempts, turnRequests, cancellationRequests, nativeTurnEvidence, toolDiagnostics, nativeStderr, nativeCapabilities, nativeUpdates: [...nativeUpdates], busyScenario: busy ? { busyModelHeld, busyModelReleased, busyModelCall, joinPromptSettled, busyNotificationQueued, promptCalls, cancelCalls, nativeNoticeEventsWhileHeld: [...busyNativeNoticeEvents] } : undefined, recoveryScenario: recovery ? { recovery, recoveryPhase, recoveryModelHeld, recoveryModelAborted, ...recoveryEvidence } : undefined, hooks: existsSync(join(temp, 'hook-observations.jsonl')) ? readFileSync(join(temp, 'hook-observations.jsonl'), 'utf8') : 'no observer output; does not distinguish unloaded hook from observer launch failure' }, null, 2));
  throw error;
} finally {
  releaseReadPermission?.();
  releaseBusyModel?.();
  recoveryModelAborted = true; releaseRecoveryModel?.();
  await rpc?.close(); bridge.close(); store.close();
  await Promise.all(servers.map(server => new Promise<void>(r => server.close(() => r()))));
  rmSync(temp, { recursive: true, force: true });
}
// A cleanup exception skips this line; never print success before cleanup completes.
if (successSummary) console.log(JSON.stringify({ ...successSummary, cleanupCompleted: true }, null, 2));
