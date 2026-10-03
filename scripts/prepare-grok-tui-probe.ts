/**
 * Prepare a manual TUI check; this script never launches or controls Grok.
 * Run: node scripts/prepare-grok-tui-probe.ts [--grok-bin /absolute/path/to/grok]
 * Then follow the printed instructions in a human-controlled terminal.
 *
 * Installed Grok 1.0.41 docs: user-guide/05-configuration.md (agent.definition),
 * 10-hooks.md (/hooks add/reload), 22-permissions-and-safety.md (default mode).
 * The installed TUI help does not expose the newer top-level --no-leader flag:
 * use the isolated [cli] use_leader=false config, not the ACP-only flag.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'smol-toml';
import { Store } from '../src/store.ts';
import { GrokNativeBridge } from '../src/grok-native-bridge.ts';
import { createGrokJoinFiles, shellQuote } from '../src/grok-native-setup.ts';

const MODEL = 'noah-local-probe';
const PRIVATE_MARKER = 'PRIVATE_TUI_HISTORY_MUST_NOT_BE_SHARED';
const ORIGINAL_RESULT = 'NOAH_TUI_ORIGINAL_TOOL_OK';
const AFTER_RESULT = 'NOAH_TUI_AFTER_REVOKE_TOOL_OK';
const PUBLIC_BODY = 'NOAH_TUI_SHARED_中文_🔎\n这两行公开正文必须完整进入原 Grok 会话。';
const PUBLIC_REPLY = 'NOAH_TUI_PUBLIC_REPLY_已读全文_⛵';

interface Page {
  conversationId: string;
  message: { id: string; offset: number; content?: string; contentEncoding?: string; contentChunks?: string[] };
  next: { batchId: string; messageIndex: number; offset: number } | null;
}
interface NativeMessage { role?: string; content?: unknown }
interface ModelInput { stream?: boolean; model?: string; messages?: NativeMessage[]; tools?: Array<{ function?: { name?: string } }> }
type Completion = { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> };

// Parse the real terminal tool result, including its textual exit-status prefix.
function objects(value: unknown, depth = 0): Record<string, any>[] {
  if (depth > 8) return [];
  if (typeof value === 'string') {
    const start = value.indexOf('{');
    if (start < 0) return [];
    try { return objects(JSON.parse(value.slice(start).trim()), depth + 1); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(item => objects(item, depth + 1));
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, any>, ...Object.values(value).flatMap(item => objects(item, depth + 1))];
}
function pagesIn(value: unknown): Page[] {
  return objects(value).filter(value => typeof value.message?.offset === 'number').map(value => ({
    ...value,
    message: { ...value.message, content: value.message.contentEncoding === 'concat' && Array.isArray(value.message.contentChunks)
      ? value.message.contentChunks.join('') : value.message.content },
  })) as Page[];
}
async function body(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 4 * 1024 * 1024) throw new Error('fixture request too large');
  }
  return text ? JSON.parse(text) : {};
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
}
function reply(res: ServerResponse, input: ModelInput, message: Completion, call: number) {
  const base = { id: 'tui-probe-' + call, created: Math.floor(Date.now() / 1000), model: MODEL };
  const finish = message.tool_calls ? 'tool_calls' : 'stop';
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!input.stream) { json(res, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage }); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((tool, index) => ({ index, ...tool })) } : message;
  res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('node scripts/prepare-grok-tui-probe.ts [--grok-bin /absolute/path/to/grok]\nPrepares local servers and manual instructions. Does not launch Grok.');
    return;
  }
  if (argv.length && (argv.length !== 2 || argv[0] !== '--grok-bin')) throw new Error('Use --grok-bin with one absolute executable path.');
  const selectedBinary = argv[1] || process.env.NOAH_GROK_BIN || join(homedir(), '.grok/bin/grok');
  if (!isAbsolute(selectedBinary)) throw new Error('The Grok executable must be an absolute path.');
  // Resolve only the executable; do not discover or read user config/history.
  const grok = realpathSync(selectedBinary); accessSync(grok, constants.X_OK);
  const temp = mkdtempSync(join(tmpdir(), 'noah-grok-tui-probe-'));
  const isolatedHome = join(temp, 'home'), grokHome = join(temp, 'grok-home'), work = join(temp, 'work');
  const statusPath = join(temp, 'status.json'), controlPath = join(temp, 'control.json'), launchPath = join(temp, 'launch.sh');
  const profilePath = join(temp, 'probe-agent.md'), configPath = join(grokHome, 'config.toml');
  const servers: Server[] = [];
  let store: Store | undefined, bridge: GrokNativeBridge | undefined, files: ReturnType<typeof createGrokJoinFiles> | undefined;
  let modelCalls = 0, originalRequested = false, originalObserved = false, originalSessionId = '';
  let joinRequested = false, joinObserved = false, monitorRequested = false, originalBeforeJoin = false;
  let revoked = false, afterRequested = false, afterObserved = false, afterSessionId = '';
  let conversationId = '', batchId = '', callCommand = '', phase = 'prepared', failure = '', controlError = '';
  let collaborationStage = 0, bodyInRequest = false, finishRequested = false, lastStatus = '', finalResult: Record<string, unknown> | undefined;
  const requestModels = new Set<string>(), pageKeys = new Set<string>(), controls = new Set<string>();
  const registrationAttempts: Array<{ status: number; sameID: boolean; projectMatches: boolean }> = [];
  const modelRequests: Array<{ call: number; route: string; stream: boolean; model: string }> = [];
  let initialModelConfig = '';
  const originalCommand = shellQuote(process.execPath) + ' -e ' + shellQuote(
    'process.stdout.write(JSON.stringify({marker:' + JSON.stringify(ORIGINAL_RESULT) + ',nativeSessionId:process.env.GROK_SESSION_ID||null})+"\\n")');
  const afterCommand = shellQuote(process.execPath) + ' -e ' + shellQuote(
    'process.stdout.write(JSON.stringify({marker:' + JSON.stringify(AFTER_RESULT) + ',nativeSessionId:process.env.GROK_SESSION_ID||null})+"\\n")');
  const final = (content: string): Completion => ({ role: 'assistant', content });
  const tool = (name: string, args: unknown): Completion => ({ role: 'assistant', content: null,
    tool_calls: [{ id: 'tui-call-' + modelCalls, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const terminal = (command: string, description: string) => tool('run_terminal_command', { command, description });
  const call = (name: string, args: unknown) => terminal(
    callCommand + " <<'NOAH_JSON'\n" + JSON.stringify({ name, args }) + '\nNOAH_JSON', 'Call isolated Noah TUI bridge');
  const fail = (code: string) => { failure ||= code; phase = 'failed'; return final('隔离检查未通过：' + code + '。请查看 fixture status，不自动重试或更改权限。'); };

  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  }
  function status() {
    const binding = bridge?.list()[0];
    const messages = conversationId ? store!.messages(conversationId) : [];
    const publicReply = messages.some(message => message.sender === 'original' && message.recipient === 'human' && message.content === PUBLIC_REPLY);
    const batch = batchId ? store!.db.prepare('SELECT state FROM grok_bridge_batches WHERE id=?').get(batchId) as { state: string } | undefined : undefined;
    const currentConfig = existsSync(configPath) ? parse(readFileSync(configPath, 'utf8')) : undefined;
    const modelConfigPreserved = !!currentConfig && JSON.stringify({ models: currentConfig.models, model: currentConfig.model }) === initialModelConfig;
    const privateHistoryNotImported = !!store && !JSON.stringify(store.snapshot()).includes(PRIVATE_MARKER) && !JSON.stringify(store.snapshot()).includes(ORIGINAL_RESULT);
    const sameID = !!originalSessionId && binding?.nativeSessionId === originalSessionId;
    const collaborationPassed = originalBeforeJoin && sameID && modelConfigPreserved && privateHistoryNotImported && bodyInRequest && publicReply && batch?.state === 'completed' && collaborationStage === 4 && !failure;
    return {
      phase, failure: failure || null, controlError: controlError || null,
      localScriptedModelCalls: modelCalls, paidModelCalls: 0, requestedModels: [...requestModels], modelRequests,
      originalObserved, originalSessionId: originalSessionId || null, originalBeforeJoin,
      joined: joinObserved, monitorRequested, binding: binding ? { id: binding.id, nativeSessionId: binding.nativeSessionId, status: binding.status } : null,
      registrationAttempts, sameID, modelConfigPreserved, privateHistoryNotImported,
      readyToQueue: originalObserved && joinObserved && monitorRequested && binding?.status === 'idle' && !failure,
      conversationId: conversationId || null, batchId: batchId || null, bodyInRequest, publicReply, uniqueReadPages: pageKeys.size,
      batchState: batch?.state || null, collaborationFinished: collaborationStage === 4,
      collaborationPassed, revoked, originalAfterObserved: afterObserved, originalAfterSameID: afterObserved && afterSessionId === originalSessionId,
      passed: collaborationPassed && revoked && afterObserved && afterSessionId === originalSessionId,
      approvalAutomation: false, uiEvidenceRequired: 'Human must observe TUI hook add/reload and approve actual native tool prompts. This status does not attest which UI buttons were pressed.',
    };
  }
  function writeStatus() {
    if (!store || !bridge) return;
    const text = JSON.stringify(status(), null, 2);
    if (text === lastStatus) return;
    writeFileSync(statusPath + '.tmp', text + '\n', { mode: 0o600 });
    renameSync(statusPath + '.tmp', statusPath); lastStatus = text;
  }
  const onSignal = () => { failure ||= 'fixture_interrupted'; finishRequested = true; };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    for (const path of [isolatedHome, grokHome, work]) mkdirSync(path, { recursive: true, mode: 0o700 });
    store = new Store(join(temp, 'noah.sqlite')); bridge = new GrokNativeBridge(store);
    const brokerUrl = await listen(createServer(async (req, res) => {
      try {
        const input = await body(req);
        const result = await bridge!.handle(req.url || '/', req.method || 'GET', (req.headers.authorization || '').replace(/^Bearer /, ''), input);
        if (req.url === '/api/grok-bridge/register') registrationAttempts.push({ status: result?.status || 404,
          sameID: !!originalSessionId && input.nativeSessionId === originalSessionId, projectMatches: input.projectDir === work });
        json(res, result?.status || 404, result?.body || {}); writeStatus();
      } catch { json(res, 400, { error: 'isolated bridge request failed' }); }
    }));
    const modelUrl = await listen(createServer(async (req, res) => {
      try {
        if (req.method === 'GET' && req.url === '/v1/models') { json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'local-fixture' }] }); return; }
        if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { json(res, 404, { error: { message: 'Only the local scripted model endpoint is available.' } }); return; }
        const input = await body(req) as ModelInput; modelCalls++; requestModels.add(input.model || '');
        if (modelCalls > 30) { failure = 'local_fixture_request_limit'; writeStatus(); json(res, 503, { error: { message: failure } }); return; }
        const names = (input.tools || []).map(item => item.function?.name);
        const messages = input.messages || [], toolResults = messages.filter(message => message.role === 'tool').map(message => message.content);
        const latestUser = JSON.stringify(messages.filter(message => message.role === 'user').at(-1)?.content || '');
        const requestText = JSON.stringify(messages);
        const markedRequest = latestUser.includes('NOAH_TUI_ORIGINAL') || latestUser.includes('NOAH_TUI_JOIN') ||
          (!!conversationId && requestText.includes('Noah peer discussion ' + conversationId));
        // Auxiliary requests can also advertise every tool. Only the streamed,
        // explicitly marked inference path may advance or contribute evidence.
        const candidateRequest = names.includes('run_terminal_command') && names.includes('monitor') && markedRequest;
        const mainRequest = input.stream === true && candidateRequest;
        const records = mainRequest ? objects(toolResults) : [];
        const original = records.find(value => value.marker === ORIGINAL_RESULT && typeof value.nativeSessionId === 'string' && value.nativeSessionId.length > 0);
        if (original) { originalObserved = true; originalSessionId ||= original.nativeSessionId; }
        const after = records.find(value => value.marker === AFTER_RESULT && typeof value.nativeSessionId === 'string' && value.nativeSessionId.length > 0);
        if (after && revoked) { afterObserved = true; afterSessionId ||= after.nativeSessionId; }
        const pages = mainRequest ? pagesIn(toolResults).filter(page => page.conversationId === conversationId) : [];
        const uniquePages = [...new Map(pages.map(page => [page.message.id + ':' + page.message.offset, page])).values()];
        for (const page of uniquePages) pageKeys.add(page.message.id + ':' + page.message.offset);
        // Evidence is reconstructed within this one original model request.
        bodyInRequest ||= uniquePages.sort((a, b) => a.message.offset - b.message.offset).map(page => page.message.content).join('') === PUBLIC_BODY;
        let route = candidateRequest && input.stream !== true ? 'metadata_non_stream_unverified' : 'metadata';
        let message = final(route === 'metadata_non_stream_unverified'
          ? 'Non-streaming TUI inference is unverified; the probe state was not advanced.' : 'Isolated TUI probe metadata.');
        if (mainRequest && latestUser.includes('NOAH_TUI_ORIGINAL_AFTER')) {
          route = 'original_after';
          if (!revoked) message = fail('revoke_before_original_after');
          else if (!afterRequested) { afterRequested = true; phase = 'original_after'; message = terminal(afterCommand, 'Print an independent marker after Noah disconnects'); }
          else if (!afterObserved || afterSessionId !== originalSessionId) message = fail('original_after_tool_or_session_missing');
          else { phase = 'finished'; message = final('NOAH_TUI_ORIGINAL_AFTER_COMPLETE：断开 Noah 后，原会话独立工作继续。'); }
        } else if (mainRequest && conversationId && requestText.includes('Noah peer discussion ' + conversationId)) {
          route = 'discussion';
          batchId ||= requestText.match(/batch ([a-f0-9-]{36})/)?.[1] || '';
          if (!batchId) message = fail('native_notice_batch_missing');
          else if (collaborationStage === 0) { message = call('noah_read', { batchId }); collaborationStage = 1; phase = 'reading'; }
          else if (collaborationStage === 1 && !pages.length) message = fail('native_page_not_parseable');
          else if (collaborationStage === 1 && pages.at(-1)?.next) message = call('noah_read', pages.at(-1)!.next);
          else if (collaborationStage === 1 && bodyInRequest) { message = call('noah_send', { conversationId, recipient: 'human', content: PUBLIC_REPLY, clientKey: 'tui-probe-reply' }); collaborationStage = 2; phase = 'replying'; }
          else if (collaborationStage === 1) message = fail('shared_body_incomplete');
          else if (collaborationStage === 2) {
            if (!status().publicReply) message = fail('public_reply_missing');
            else { message = call('noah_complete', { batchId }); collaborationStage = 3; phase = 'completing'; }
          } else if (collaborationStage === 3) {
            if (status().batchState !== 'completed') message = fail('completion_not_observed');
            else { collaborationStage = 4; phase = 'discussion_complete'; message = final('NOAH_TUI_DISCUSSION_COMPLETE：公开正文已读，回复已回到 Noah。'); }
          } else message = final('NOAH_TUI_DISCUSSION_COMPLETE');
        } else if (mainRequest && latestUser.includes('NOAH_TUI_JOIN')) {
          route = 'join';
          if (!originalObserved || !originalSessionId) message = fail('original_work_evidence_missing');
          else if (!joinRequested) { originalBeforeJoin = bridge!.list().length === 0; joinRequested = true; phase = 'joining'; message = terminal(files!.joinCommand, 'Join this original session to the isolated Noah probe'); }
          else if (!joinObserved) {
            const joined = records.find(value => value.joined === true && value.nativeSessionId === originalSessionId);
            const binding = bridge!.list().find(value => value.nativeSessionId === originalSessionId);
            if (!joined || !binding) message = fail('join_registration_missing_check_manual_hooks');
            else { joinObserved = true; monitorRequested = true; phase = 'monitor_starting';
              message = tool('monitor', { command: files!.monitorCommand, description: 'Noah isolated TUI discussion', persistent: true }); }
          } else { phase = 'waiting_for_queue'; message = final('NOAH_TUI_MONITOR_READY：请从独立控制文件 queue 一条公开消息。'); }
        } else if (mainRequest && latestUser.includes('NOAH_TUI_ORIGINAL')) {
          route = 'original';
          if (!originalRequested) { originalRequested = true; phase = 'original_work'; message = terminal(originalCommand, 'Print a harmless original-session marker'); }
          else if (!originalObserved) message = fail('original_tool_not_observed');
          else { phase = 'original_work_done'; message = final('NOAH_TUI_ORIGINAL_COMPLETE：现在可以通过 /hooks 手动添加 Noah hook。'); }
        }
        modelRequests.push({ call: modelCalls, route, stream: input.stream === true, model: input.model || '' });
        reply(res, input, message, modelCalls); writeStatus();
      } catch { failure ||= 'local_model_fixture_error'; json(res, 500, { error: { message: failure } }); writeStatus(); }
    }));
    const config = {
      agent: { definition: profilePath },
      models: { default: MODEL, session_summary: MODEL, web_search: MODEL },
      model: { [MODEL]: { model: MODEL, api_backend: 'chat_completions', base_url: modelUrl + '/v1', api_key: 'noah-local-test-key',
        context_window: 128000, max_completion_tokens: 1000, max_retries: 0 } },
      cli: { auto_update: false, use_leader: false },
      ui: { permission_mode: 'ask', default_selected_permission: 'allow_once' },
      features: { backend_tools: false, remote_fetch: false, managed_config: false, telemetry: false, feedback: false },
      endpoints: { xai_api_base_url: modelUrl + '/v1', cli_chat_proxy_base_url: modelUrl },
    };
    initialModelConfig = JSON.stringify({ models: config.models, model: config.model });
    writeFileSync(configPath, stringify(config), { mode: 0o600 });
    writeFileSync(profilePath, '---\nname: noah-tui-probe\ndescription: Manual isolated native TUI check\ntools: run_terminal_command, monitor\n---\nUse only the exact local fixture commands. Keep the native approval prompts; do not change permissions or publish private history.\n', { mode: 0o600 });
    files = createGrokJoinFiles({ directory: join(temp, 'join'), url: brokerUrl, ...bridge.issueJoinToken() });
    const grant = JSON.parse(readFileSync(files.grantPath, 'utf8')); callCommand = grant.callCommand;
    // Deliberately do not copy the generated hooks into config, project hooks,
    // plugins, or profiles. Only the human-operated /hooks flow can load them.
    const env = { HOME: isolatedHome, GROK_HOME: grokHome, TMPDIR: temp, PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin',
      SHELL: '/bin/zsh', TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
      XAI_API_KEY: 'noah-local-test-key', NO_PROXY: '127.0.0.1,localhost', GROK_MEMORY: '0', GROK_SUBAGENTS: '0',
      GROK_TELEMETRY_ENABLED: '0', GROK_TELEMETRY_TRACE_UPLOAD: '0', GROK_FEEDBACK_ENABLED: '0' };
    const launch = '#!/bin/sh\nset -eu\numask 077\ncd ' + shellQuote(work) +
      '\nexec /usr/bin/env -i ' + Object.entries(env).map(([key, value]) => shellQuote(key + '=' + value)).join(' ') + ' ' + shellQuote(grok) + ' --permission-mode default -m ' + shellQuote(MODEL) + '\n';
    writeFileSync(launchPath, launch, { mode: 0o700 }); writeFileSync(controlPath, '{}\n', { mode: 0o600 });
    const controlCommand = (action: string) => shellQuote(process.execPath) + ' -e ' + shellQuote(
      'require("node:fs").writeFileSync(' + JSON.stringify(controlPath) + ',' + JSON.stringify(JSON.stringify({ id: action, action })) + ')');
    const setup = {
      launchCommand: '/bin/sh ' + shellQuote(launchPath), hookPath: files.hookPath, statusPath, controlPath,
      originalPrompt: 'NOAH_TUI_ORIGINAL ' + PRIVATE_MARKER + ': 只执行本地假模型返回的无害打印命令，手动确认原生审批。',
      originalAfterPrompt: 'NOAH_TUI_ORIGINAL_AFTER: Noah 已断开；只执行新的独立无害打印命令，手动确认原生审批。',
      joinPrompt: 'NOAH_TUI_JOIN\n' + files.joinPrompt, setupInstruction: files.setupInstruction,
      queueCommand: controlCommand('queue'), revokeCommand: controlCommand('revoke'), finishCommand: controlCommand('finish'), joinGrantExpiresAt: new Date(files.expiresAt).toISOString(),
      originalCommandToReview: originalCommand, originalAfterCommandToReview: afterCommand,
      steps: ['在另一个人工操作的终端运行 launchCommand；保持 fixture 进程运行。', '提交 originalPrompt，按原 TUI 提示逐项允许一次；等待 ORIGINAL_COMPLETE。',
        '在同一 TUI 输入 /hooks，按 a 添加 hookPath，按 r 重载，然后退出 modal。', '提交 joinPrompt，逐项核对并允许本机 join 与 monitor 命令。不要启用 always-approve。',
        'status.json 的 readyToQueue=true 后，在独立终端运行 queueCommand；按 TUI 原权限确认 noah_read/send/complete。',
        'status.json 的 collaborationPassed=true 后运行 revokeCommand；在同一 TUI 提交 originalAfterPrompt 并允许新的无害命令。',
        'status.json 的 passed=true 后先退出这个隔离 TUI，再运行 finishCommand；fixture 清理临时目录并向 stdout 输出最终 JSON。'],
      isolation: { manualTuiOnly: true, userConfigurationRead: false, hooksInitiallyLoaded: false, permissions: 'default (ask)', leader: 'isolated config cli.use_leader=false', provider: 'loopback scripted responses only' },
    };
    writeFileSync(join(temp, 'instructions.json'), JSON.stringify(setup, null, 2) + '\n', { mode: 0o600 });
    writeStatus(); console.log(JSON.stringify({ event: 'prepared', ...setup }, null, 2));
    while (!finishRequested) {
      await delay(500);
      let control: { id?: string; action?: string } = {};
      try { control = JSON.parse(readFileSync(controlPath, 'utf8')); } catch { /* A manual write may be in progress; retry next tick. */ }
      if (control.id && !controls.has(control.id)) {
        controls.add(control.id); controlError = '';
        if (control.action === 'finish') finishRequested = true;
        else if (control.action === 'revoke') {
          if (!status().collaborationPassed) controlError = 'Wait for collaborationPassed, then use a new control id.';
          else { for (const binding of bridge.list()) bridge.revoke(binding.id); revoked = true; phase = 'revoked_ready_for_original_after'; }
        } else if (control.action === 'queue') {
          if (conversationId) controlError = 'The one public fixture message is already queued.';
          else if (!status().readyToQueue) { controlError = 'Wait for readyToQueue, then use a new control id.'; }
          else {
            const binding = bridge.list()[0];
            conversationId = store.create('Manual Grok TUI probe', undefined, undefined, undefined, false,
              [{ id: 'original', harness: 'grok', mode: 'external', bindingId: binding.id }]).id;
            store.send(conversationId, 'human', 'original', PUBLIC_BODY, 'tui-public-input'); phase = 'queued';
          }
        } else controlError = 'Supported actions: queue, revoke, finish.';
      }
      writeStatus();
    }
    finalResult = status();
    if (!finalResult.passed) process.exitCode = 1;
  } catch (error) {
    process.exitCode = 1; finalResult = { passed: false, failure: error instanceof Error ? error.message : 'fixture_setup_failed', localScriptedModelCalls: modelCalls, paidModelCalls: 0 };
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    // Revoke while the broker is still alive so a native monitor can stop itself.
    if (bridge && store) { for (const binding of bridge.list()) bridge.revoke(binding.id); await delay(1700); bridge.close(); }
    await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
    store?.close(); rmSync(temp, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ event: 'finished', ...finalResult, cleanupCompleted: true }, null, 2));
}

void main().catch(() => { process.stderr.write('TUI fixture could not prepare or finish cleanup.\n'); process.exitCode = 1; });
