import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { JsonLines } from './jsonl.ts';
import { loadGrokConfig, privateDir, redact, trackSecret } from './config.ts';
import { toolCatalog, systemPrompt } from './tool-definitions.ts';
import { openPiSession } from './pi-session.ts';

let session: AgentSession | undefined;
let channel: { url: string; token: string };
let busy = false;
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params });
async function handle(method: string, params: any): Promise<any> {
  if (method === 'initialize') return { protocolVersion: 'noah.pi-sdk.v1', version: '0.87.0' };
  if (method === 'session/new') {
    if (session) throw new Error('Session already exists');
    const config = loadGrokConfig(params.configPath, params.modelAlias, process.env.NOAH_MODEL_API_KEY);
    const agentDir = privateDir(params.agentDir);
    channel = { url: params.bridgeUrl, token: trackSecret(params.bridgeToken) };
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(agentDir, 'model-cache.json'), allowModelNetwork: false, refreshOnCreate: false,
    });
    const api = { responses: 'openai-responses', chat_completions: 'openai-completions', messages: 'anthropic-messages' }[config.backend];
    runtime.registerProvider('noah-grok', {
      baseUrl: config.baseUrl, api,
      models: [{ id: config.model, name: config.model, reasoning: config.reasoning,
        input: ['text'], contextWindow: config.contextWindow, maxTokens: config.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    await runtime.setRuntimeApiKey('noah-grok', config.apiKey);
    const model = runtime.getModel('noah-grok', config.model);
    if (!model) throw new Error('Pi custom model registration failed');
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: params.cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      appendSystemPrompt: [systemPrompt(params.participantId || 'pi', 'pi')],
    });
    await loader.reload();
    const customTools = toolCatalog.map(def => ({
      name: def.name, label: def.name, description: def.description,
      parameters: Type.Unsafe<Record<string, unknown>>(def.inputSchema),
      execute: async (callId: string, args: Record<string, unknown>) => {
        const response = await fetch(channel.url + '/api/tool', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channel.token}` },
          body: JSON.stringify({ name: def.name, args, callId }), signal: AbortSignal.timeout(15000),
        });
        const result = await response.json() as any;
        if (!response.ok) throw new Error(result.error || 'Noah tool failed');
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: {} };
      },
    }));
    const sm = openPiSession({ cwd: params.cwd, sessionDir: join(agentDir, 'sessions'),
      sessionFile: params.sessionFile, expectedSessionId: params.expectedSessionId });
    const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(config.effort) ? config.effort : 'medium';
    ({ session } = await createAgentSession({
      cwd: params.cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: thinking as any,
      tools: toolCatalog.map(t => t.name), customTools, sessionManager: sm, resourceLoader: loader, settingsManager,
    }));
    session.subscribe(event => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        notify('noah/output', { text: redact(event.assistantMessageEvent.delta) });
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message as any;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          notify('noah/run_error', { error: redact(message.errorMessage || message.stopReason) });
        }
        if (message.usage) notify('noah/usage', { ...message.usage, cost: null, costStatus: 'unknown' });
      }
    });
    return { sessionId: session.sessionId, sessionFile: session.sessionFile, model: config.model, backend: config.backend };
  }
  if (!session) throw new Error('No Pi session');
  if (method === 'session/prompt') {
    if (busy) throw new Error('Pi session busy');
    busy = true;
    try {
      await session.prompt(params.text, { expandPromptTemplates: false,
        preflightResult: accepted => { if (accepted) notify('noah/accepted', { deliveryId: params.deliveryId }); },
      });
      return { stopReason: 'end_turn', sessionFile: session.sessionFile };
    } finally { busy = false; }
  }
  if (method === 'session/cancel') { await session.abort(); return { cancelled: true }; }
  if (method === 'session/state') return { busy, sessionId: session.sessionId, sessionFile: session.sessionFile };
  throw new Error('Unsupported Pi method');
}
const parser = new JsonLines();
process.stdin.on('data', chunk => {
  try {
    for (const msg of parser.feed(chunk)) {
      void handle(msg.method, msg.params || {}).then(result => {
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
      }).catch(error => {
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: redact(error) } });
      });
    }
  } catch { process.exit(1); }
});
const close = async () => { if (session) { await session.abort(); session.dispose(); } process.exit(0); };
process.stdin.on('end', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
