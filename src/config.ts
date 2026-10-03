import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { parse, stringify } from 'smol-toml';

const secrets = new Set<string>();
export function redact(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|xai-)[A-Za-z0-9_-]{12,}/g, '[redacted]');
}
export function trackSecret(secret: string): string { secrets.add(secret); return secret; }
export interface GrokModelConfig {
  source: string; alias: string; model: string; baseUrl: string; apiKey: string;
  backend: 'responses' | 'chat_completions' | 'messages';
  contextWindow: number; maxTokens: number; reasoning: boolean; effort: string;
}
function configPath(source: string): string {
  return source.startsWith('~/') ? resolve(homedir(), source.slice(2)) : resolve(source);
}
export function loadGrokConfig(source = process.env.NOAH_GROK_CONFIG || join(homedir(), '.grok/config.toml'), aliasOverride?: string, resolvedKey?: string): GrokModelConfig {
  source = configPath(source);
  let data: any;
  try { data = parse(readFileSync(source, 'utf8')); }
  catch { throw new Error('无法读取或解析 Grok config.toml；用 NOAH_GROK_CONFIG 指定配置文件。'); }
  const alias = aliasOverride || process.env.NOAH_MODEL || data.models?.default;
  const m = data.model?.[alias];
  if (!alias || !m) throw new Error('Grok 配置中没有选中模型的 [model] 定义。');
  let key = m.api_key;
  if (typeof key === 'string') {
    const match = key.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    if (match) key = process.env[match[1]];
  }
  if (!key && typeof m.env_key === 'string') key = process.env[m.env_key];
  if (!key) key = resolvedKey;
  if (typeof key !== 'string' || !key.trim()) throw new Error('所选 Grok 模型未配置可用的 api_key / env_key。');
  trackSecret(key);
  let url: URL;
  try { url = new URL(m.base_url); } catch { throw new Error('Grok 模型缺少有效 base_url。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('模型地址必须是无内嵌凭证、查询参数或片段的 HTTP(S) base URL。');
  }
  const backend = m.api_backend || 'responses';
  if (!['responses', 'chat_completions', 'messages'].includes(backend)) throw new Error('所选 api_backend 尚未支持。');
  return {
    source: resolve(source), alias, model: m.model || alias, baseUrl: url.href.replace(/\/$/, ''), apiKey: key,
    backend, contextWindow: m.context_window || 128000, maxTokens: m.max_completion_tokens || 8192,
    reasoning: m.supports_reasoning_effort === true,
    effort: m.reasoning_effort || data.models?.default_reasoning_effort || 'medium',
  };
}
export function modelSummary(config: GrokModelConfig) {
  return { model: config.model, alias: config.alias, backend: config.backend, source: config.source, keyConfigured: true };
}
export function listGrokModels(source = process.env.NOAH_GROK_CONFIG || join(homedir(), '.grok/config.toml')) {
  const data: any = parse(readFileSync(configPath(source), 'utf8'));
  return Object.entries(data.model || {}).map(([alias, m]: [string, any]) => ({ alias, model: m.model || alias, backend: m.api_backend || 'responses' }));
}
export function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path;
}
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.NODE_USE_ENV_PROXY = '1';
  // A packaged desktop app uses its bundled Electron binary as Node for workers.
  if (process.env.ELECTRON_RUN_AS_NODE === '1') env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
export function prepareGrokHome(path: string, config: GrokModelConfig): string {
  privateDir(path);
  // Only the selected model is copied. Credentials remain in child-process memory.
  const text = stringify({
    models: { default: config.alias, default_reasoning_effort: config.effort },
    model: { [config.alias]: {
      model: config.model, name: config.alias, base_url: config.baseUrl,
      api_backend: config.backend, env_key: 'NOAH_MODEL_API_KEY', context_window: config.contextWindow,
      supports_reasoning_effort: config.reasoning, reasoning_effort: config.effort,
      max_completion_tokens: config.maxTokens, max_retries: 0,
    } },
    cli: { auto_update: false, use_leader: false },
    ui: { permission_mode: 'ask', yolo: false },
    subagents: { enabled: false },
    permission: { deny: ['Bash', 'Read', 'Edit', 'Grep', 'WebFetch', 'WebSearch'], allow: ['MCPTool(noah__*)'] },
    features: { backend_tools: false, video_gen: false },
  });
  writeFileSync(join(path, 'config.toml'), text, { mode: 0o600 });
  return path;
}
