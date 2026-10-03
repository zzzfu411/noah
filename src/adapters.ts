import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { JsonRpcProcess } from './jsonl.ts';
import { loadGrokConfig, childEnv, prepareGrokHome, privateDir, redact, trackSecret } from './config.ts';
import { systemPrompt } from './tool-definitions.ts';
import { discoverHarnesses } from './discovery.ts';
import { AGENTS, type AgentId, type ManagedHarnessId, type SessionRow } from './store.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export interface AdapterEvents { accepted: () => void; output: (text: string) => void; usage: (value: unknown) => void; exit: () => void }
export interface Adapter {
  start(): Promise<{ nativeId: string; nativeFile?: string; capabilities: unknown }>;
  prompt(text: string, deliveryId: string): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
type AdapterSessionRow = Omit<SessionRow, 'harness' | 'label' | 'mode' | 'binding_id' | 'joined_at' | 'removed_at'> & Partial<Pick<SessionRow, 'harness' | 'label' | 'mode' | 'binding_id' | 'joined_at' | 'removed_at'>>;
export interface AdapterOptions { agent: AgentId; row: AdapterSessionRow; dataDir: string; bridgeUrl: string; bridgeToken: string; modelAlias?: string; configPath?: string; events: AdapterEvents }

export class LocalAdapter implements Adapter {
  private options: AdapterOptions & { row: SessionRow };
  private rpc?: JsonRpcProcess;
  private nativeId = '';
  private runError?: string;
  private active = false;
  private closing = false;
  constructor(options: AdapterOptions) {
    const harness = options.row.harness || options.agent as ManagedHarnessId;
    if (!AGENTS.includes(harness)) throw new Error('A harness must be specified for this participant');
    this.options = { ...options, row: { ...options.row, harness, label: options.row.label || options.agent, mode: options.row.mode || 'managed', binding_id: options.row.binding_id || `managed:${options.row.conversation_id}:${options.agent}`, joined_at: options.row.joined_at ?? 0, removed_at: options.row.removed_at ?? null } };
  }
  async start() {
    const o = this.options;
    if (o.row.mode !== 'managed') throw new Error('An external session must remain in its original harness process');
    const config = loadGrokConfig(o.configPath, o.modelAlias);
    const base = privateDir(join(o.dataDir, 'sessions', o.row.conversation_id, o.agent));
    const cwd = privateDir(join(base, 'workspace'));
    let capabilities: unknown;
    let result: any;
    if (o.row.harness === 'grok') {
      const grokHome = prepareGrokHome(join(base, 'grok-home'), config);
      const bindingFile = join(base, 'bridge.json');
      const profile = join(base, 'noah-peer.md');
      // ACP does not apply the headless --tools / --disallowed-tools flags.
      // Request the communication toolset; profile support varies by native
      // version, so this file alone is not proof of tool isolation.
      writeFileSync(profile, `---\nname: noah-peer\ndescription: Independent Noah communication peer\ntools: search_tool, use_tool\n---\n${systemPrompt(o.agent, 'grok')}\n`, { mode: 0o600 });
      trackSecret(o.bridgeToken);
      writeFileSync(bindingFile, JSON.stringify({ url: o.bridgeUrl, token: o.bridgeToken }), { mode: 0o600 });
      const discoveredGrok = discoverHarnesses().harnesses.find(h => h.id === 'grok');
      if (process.env.NOAH_GROK_BIN && discoveredGrok?.executableSource !== 'environment') {
        throw new Error('NOAH_GROK_BIN 指定的 Grok 可执行文件不可用；请核对路径与执行权限。');
      }
      const grokBin = discoveredGrok?.executablePath;
      if (!grokBin) throw new Error('未检测到 Grok 可执行文件；安装后在“本机 Agents”中重新检测。');
      this.rpc = new JsonRpcProcess(grokBin, [
        'agent', '--no-leader', '--agent-profile', profile, '--model', config.alias, 'stdio',
      ], { cwd, env: { ...childEnv(), GROK_HOME: grokHome, NOAH_MODEL_API_KEY: config.apiKey, XAI_API_KEY: config.apiKey } });
      this.rpc.handleRequest = async (method, params) => {
        if (method === 'session/request_permission') {
          // Only the scoped Noah MCP server is installed in this isolated harness home.
          const raw = params.toolCall || {};
          const title = String(raw.title || '');
          const name = String(raw.rawInput?.tool_name || raw.rawInput?.name || raw._meta?.toolName || '');
          const noah = /^(?:noah__|noah_|mcp__noah__)/.test(name) || /^(?:noah__|noah_|mcp__noah__)/.test(title);
          const allow = params.options?.find((p: any) => p.kind === 'allow_once');
          if (noah && allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
          const deny = params.options?.find((p: any) => p.kind === 'reject_once');
          return { outcome: deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' } };
        }
        throw new Error('Noah communication mode does not expose this client capability');
      };
      const init = await this.rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'noah', version: '0.1.0' }, clientCapabilities: {} });
      if (init.protocolVersion !== 1) throw new Error('Unsupported Grok ACP version');
      if (init.authMethods?.some((m: any) => m.id === 'xai.api_key')) await this.rpc.request('authenticate', { methodId: 'xai.api_key', _meta: { headless: true } });
      const mcpEnv = [{ name: 'NOAH_BINDING_FILE', value: bindingFile }];
      if (process.env.ELECTRON_RUN_AS_NODE === '1') mcpEnv.push({ name: 'ELECTRON_RUN_AS_NODE', value: '1' });
      const mcpServers = [{ name: 'noah', command: process.execPath, args: [resolve(root, 'src/mcp-bridge.ts')], env: mcpEnv }];
      result = await this.rpc.request(o.row.native_id ? 'session/load' : 'session/new', {
        ...(o.row.native_id ? { sessionId: o.row.native_id } : {}), cwd, mcpServers,
        _meta: { rules: systemPrompt(o.agent, 'grok'), yoloMode: false, autoMode: false },
      }, 60000);
      this.nativeId = result.sessionId || o.row.native_id;
      capabilities = { harness: 'grok', protocol: 'ACP v1', native: init.agentCapabilities,
        wakeIdle: true, queueWhileBusy: 'Noah queue', steerActiveTurn: 'unverified', cancelRun: true, resumeSession: !!init.agentCapabilities?.loadSession, outboundTools: 'MCP' };
    } else {
      this.rpc = new JsonRpcProcess(process.execPath, [resolve(root, 'src/pi-worker.ts')], { cwd, env: { ...childEnv(), NOAH_MODEL_API_KEY: config.apiKey } });
      const init = await this.rpc.request('initialize');
      result = await this.rpc.request('session/new', {
        configPath: config.source, modelAlias: config.alias, cwd, agentDir: join(base, 'pi-home'),
        bridgeUrl: o.bridgeUrl, bridgeToken: o.bridgeToken, sessionFile: o.row.native_file || undefined,
        expectedSessionId: o.row.native_id || undefined,
        participantId: o.agent,
      }, 60000);
      this.nativeId = result.sessionId;
      capabilities = { harness: 'pi', version: init.version, protocol: init.protocolVersion, wakeIdle: true,
        queueWhileBusy: 'Noah queue', steerActiveTurn: 'unverified', cancelRun: true, resumeSession: true, outboundTools: 'Pi native tools' };
    }
    this.rpc.on('exit', () => { if (!this.closing) o.events.exit(); });
    this.rpc.on('notification', (method, params) => {
      if (!this.active) return;
      if (method === 'noah/accepted') o.events.accepted();
      if (method === 'noah/output') o.events.output(redact(params.text));
      if (method === 'noah/usage') o.events.usage(params);
      if (method === 'noah/run_error') this.runError = redact(params.error);
      if (method === 'session/update') {
        const u = params.update;
        if (u.sessionUpdate === 'agent_message_chunk') { o.events.accepted(); o.events.output(redact(u.content?.text || '')); }
        if (u.sessionUpdate === 'tool_call') o.events.accepted();
        if (u.sessionUpdate === 'usage_update') o.events.usage({ ...u, cost: null, costStatus: 'unknown' });
      }
    });
    return { nativeId: this.nativeId, nativeFile: result.sessionFile, capabilities };
  }
  async prompt(text: string, deliveryId: string) {
    if (!this.rpc) throw new Error('Adapter not started');
    if (this.active) throw new Error('Adapter busy');
    this.active = true; this.runError = undefined;
    try {
      const result = await this.rpc.request('session/prompt', this.options.row.harness === 'grok'
        ? { sessionId: this.nativeId, prompt: [{ type: 'text', text }] }
        : { text, deliveryId }, Number(process.env.NOAH_RUN_TIMEOUT_MS || 180000));
      if (this.runError) throw new Error(this.runError);
      if (result.stopReason === 'cancelled') throw new Error('Run cancelled');
    } finally { this.active = false; }
  }
  async cancel() {
    if (!this.rpc) return;
    if (this.options.row.harness === 'grok') this.rpc.notify('session/cancel', { sessionId: this.nativeId });
    else await this.rpc.request('session/cancel', {}, 10000);
  }
  async close() { this.closing = true; await this.rpc?.close(); }
}
