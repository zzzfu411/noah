import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type HarnessId = 'grok' | 'pi' | 'codex' | 'claude' | 'gemini' | 'opencode';
export type ExecutableSource = 'environment' | 'path' | 'common_location';

export interface HarnessDiscoveryItem {
  id: HarnessId;
  label: string;
  /** An executable candidate exists; its identity, version and health are not verified. */
  executableInstalled: boolean;
  executablePath: string | null;
  executableSource: ExecutableSource | null;
  /** File presence only: never implies valid configuration or authentication. */
  configPresent: boolean;
  configPaths: string[];
  bundledRuntime: { kind: 'pi_sdk'; present: boolean; path: string | null } | null;
  managedCreation: {
    supported: boolean;
    runtimePresent: boolean;
    modelConfigPresent: boolean;
    explanation: string;
  };
  liveAttach: { capability: 'bridge_required' | 'unknown'; explanation: string };
  explanation: string;
}

export interface HarnessDiscoveryReport {
  schemaVersion: 1;
  harnesses: HarnessDiscoveryItem[];
  inspection: {
    filesystemOnly: true;
    executablesLaunched: false;
    configurationContentsRead: false;
    sessionsInspected: false;
  };
}

export interface HarnessDiscoveryOptions {
  home?: string;
  /** Absolute PATH entries only; empty/relative entries are deliberately not searched. */
  path?: string | readonly string[];
  /** Replaces process.env, rather than merging with it, for deterministic callers/tests. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Noah's application package, not the user's current working directory. */
  packageRoot?: string;
  /** Overrides the fixed system locations; [] keeps tests off the host's installations. */
  systemBinDirs?: readonly string[];
}

const labels: Record<HarnessId, string> = {
  grok: 'Grok', pi: 'pi', codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', opencode: 'OpenCode',
};
const ids = Object.keys(labels) as HarnessId[];
const defaultSystemBins = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin'];
const defaultPackageRoot = fileURLToPath(new URL('../', import.meta.url));

// No file contents, directory enumeration, shell startup files or executable probes.
function fileStat(path: string) {
  try { const result = statSync(path); return result.isFile() ? result : null; }
  catch { return null; }
}
function executableStat(path: string) {
  const stat = fileStat(path);
  if (!stat || !(stat.mode & 0o111)) return null;
  try { accessSync(path, constants.X_OK); return stat; }
  catch { return null; }
}
function absolutePath(value: string | undefined, home: string): string | null {
  if (!value || value.includes('\0')) return null;
  if (value === '~') return home;
  if (value.startsWith('~/')) return resolve(home, value.slice(2));
  return isAbsolute(value) ? resolve(value) : null;
}
function unique(paths: (string | null | undefined)[]): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}
function within(path: string, directory: string): boolean {
  const tail = relative(directory, path);
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
}

/**
 * Bounded, read-only installation hints. Never attach to a process or import a SDK
 * here: even importing a harness can load extensions or mutate its global state.
 */
export function discoverHarnesses(options: HarnessDiscoveryOptions = {}): HarnessDiscoveryReport {
  const env = options.env ?? process.env;
  const home = resolve(options.home ?? env.HOME ?? homedir());
  const root = resolve(options.packageRoot ?? defaultPackageRoot);
  const pathValue = options.path ?? env.PATH ?? '';
  const pathEntries = typeof pathValue === 'string' ? pathValue.split(delimiter) : [...pathValue];
  const pathDirs = unique(pathEntries.map(path => absolutePath(path, home)));
  const npmPrefix = absolutePath(env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix, home);
  const commonDirs = unique([
    ...(options.systemBinDirs ?? defaultSystemBins).map(path => absolutePath(path, home)),
    join(home, '.local/bin'), join(home, '.npm-global/bin'), join(home, '.npm/bin'),
    join(home, '.bun/bin'), join(home, '.volta/bin'), join(home, '.nvm/current/bin'),
    join(home, '.local/share/mise/shims'), join(home, '.asdf/shims'),
    npmPrefix ? join(npmPrefix, 'bin') : null,
  ]);
  const grokConfig = absolutePath(env.NOAH_GROK_CONFIG, home) ?? join(home, '.grok/config.toml');
  const piDir = absolutePath(env.PI_CODING_AGENT_DIR, home) ?? join(home, '.pi/agent');
  const codexDir = absolutePath(env.CODEX_HOME, home) ?? join(home, '.codex');
  const claudeDir = absolutePath(env.CLAUDE_CONFIG_DIR, home) ?? join(home, '.claude');
  const geminiHome = absolutePath(env.GEMINI_CLI_HOME, home) ?? home;
  const xdgConfig = absolutePath(env.XDG_CONFIG_HOME, home) ?? join(home, '.config');
  const opencodeDir = absolutePath(env.OPENCODE_CONFIG_DIR, home);
  const configCandidates: Record<HarnessId, string[]> = {
    grok: [grokConfig],
    pi: [join(piDir, 'settings.json'), join(piDir, 'models.json')],
    codex: [join(codexDir, 'config.toml')],
    claude: [join(claudeDir, 'settings.json'), join(claudeDir, 'settings.local.json')],
    gemini: [join(geminiHome, '.gemini/settings.json')],
    opencode: unique([
      absolutePath(env.OPENCODE_CONFIG, home),
      opencodeDir ? join(opencodeDir, 'opencode.json') : null,
      opencodeDir ? join(opencodeDir, 'opencode.jsonc') : null,
      join(xdgConfig, 'opencode/opencode.json'), join(xdgConfig, 'opencode/opencode.jsonc'),
    ]),
  };
  const piPackage = join(root, 'node_modules/@earendil-works/pi-coding-agent');
  const piSdkPresent = Boolean(fileStat(join(piPackage, 'package.json')) && fileStat(join(piPackage, 'dist/index.js')));
  const piWorkerPresent = Boolean(fileStat(join(root, 'src/pi-worker.ts'))
    && fileStat(join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
  const bundledPiCli = fileStat(join(piPackage, 'dist/cli.js'));
  const sharedModelConfigPresent = Boolean(fileStat(grokConfig));

  const harnesses = ids.map((id): HarnessDiscoveryItem => {
    const candidates: { path: string; source: ExecutableSource }[] = [];
    if (id === 'grok') {
      const override = absolutePath(env.NOAH_GROK_BIN, home);
      if (override) candidates.push({ path: override, source: 'environment' });
      // A bare command override is resolved as a literal filename, never a shell expression.
      else if (env.NOAH_GROK_BIN && /^[\w.+-]+$/.test(env.NOAH_GROK_BIN)) {
        for (const dir of pathDirs) candidates.push({ path: join(dir, env.NOAH_GROK_BIN), source: 'environment' });
      }
    }
    for (const dir of pathDirs) candidates.push({ path: join(dir, id), source: 'path' });
    const ownDirs = id === 'grok' ? [join(home, '.grok/bin')]
      : id === 'claude' ? [join(home, '.claude/local')]
        : id === 'opencode' ? [join(home, '.opencode/bin')] : [];
    for (const dir of [...ownDirs, ...commonDirs]) candidates.push({ path: join(dir, id), source: 'common_location' });
    const seen = new Set<string>();
    const executable = candidates.find(candidate => {
      if (seen.has(candidate.path)) return false;
      seen.add(candidate.path);
      // npm adds Noah's own .bin to PATH in development. That is not a user pi installation.
      if (id === 'pi' && within(candidate.path, join(root, 'node_modules'))) return false;
      const stat = executableStat(candidate.path);
      if (!stat) return false;
      // stat follows symlinks without reading them; also reject an external alias of bundled pi.
      return !(id === 'pi' && bundledPiCli && stat.dev === bundledPiCli.dev && stat.ino === bundledPiCli.ino);
    });
    const configPaths = unique(configCandidates[id]).filter(path => Boolean(fileStat(path)));
    const supported = id === 'grok' || id === 'pi';
    const runtimePresent = id === 'pi' ? piSdkPresent && piWorkerPresent : Boolean(executable);
    const runtimeText = id === 'pi' && piSdkPresent
      ? 'Noah 内置 pi SDK 已检测到；这不代表你安装了 pi 命令行。'
      : executable ? '已检测到可执行文件，尚未运行或验证版本。' : '未在 PATH 和常见安装位置检测到可执行文件。';
    const configText = configPaths.length
      ? '检测到配置文件，仅确认存在，未读取内容或验证登录。'
      : '未在已检查的位置检测到配置文件；这不代表程序未安装。';
    return {
      id, label: labels[id],
      executableInstalled: Boolean(executable), executablePath: executable?.path ?? null,
      executableSource: executable?.source ?? null,
      configPresent: configPaths.length > 0, configPaths,
      bundledRuntime: id === 'pi' ? { kind: 'pi_sdk', present: piSdkPresent, path: piSdkPresent ? piPackage : null } : null,
      managedCreation: {
        supported, runtimePresent,
        modelConfigPresent: supported && sharedModelConfigPresent,
        explanation: supported
          ? `支持在 Noah 中创建独立${id === 'pi' ? ' pi SDK' : ' Grok'}会话；${runtimePresent ? '运行文件已检测到' : '尚缺运行文件'}，${sharedModelConfigPresent ? 'Grok 模型配置文件已检测到' : '尚缺 Grok 模型配置文件'}。模型、凭证和连接需要在创建前另行验证。`
          : '目前仅提供安装发现，Noah 暂未实现此 harness 的会话创建。',
      },
      liveAttach: {
        capability: supported ? 'bridge_required' : 'unknown',
        explanation: supported
          ? id === 'pi' ? '可在原 pi 中显式加载 Noah 扩展并连接；原会话保留模型与工具。已验证真实 SDK，TUI 场景尚未全部验收。' : '可新建 Grok 会话；原 Grok 的项目 hooks/monitor 接入为实验性，真实原会话端到端尚未验收。'
          : '未检查正在运行的进程，也未验证此 harness 的实时会话接入能力。',
      },
      explanation: `${runtimeText}${configText}未读取会话历史，不能据此判断已有 Agent 正在运行或可接入。`,
    };
  });
  return {
    schemaVersion: 1, harnesses,
    inspection: { filesystemOnly: true, executablesLaunched: false, configurationContentsRead: false, sessionsInspected: false },
  };
}
