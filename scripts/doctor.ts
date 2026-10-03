import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { loadGrokConfig, modelSummary, redact } from '../src/config.ts';
import { LocalAdapter } from '../src/adapters.ts';

async function main() {
  const config = loadGrokConfig();
  console.log(JSON.stringify({ node: process.version, config: modelSummary(config), note: '检查握手与会话创建，不启动模型推理。' }, null, 2));
  for (const agent of ['grok', 'pi'] as const) {
    const row = { conversation_id: 'doctor', agent, native_id: null, native_file: null, status: 'offline', error: null, capabilities: null };
    const adapter = new LocalAdapter({ agent, row, dataDir: resolve('.noah/doctor'), bridgeUrl: 'http://127.0.0.1:9', bridgeToken: randomBytes(32).toString('hex'), events: { accepted() {}, output() {}, usage() {}, exit() {} } });
    try {
      const result = await adapter.start();
      const version = agent === 'grok' ? execFileSync(process.env.NOAH_GROK_BIN || join(process.env.HOME!, '.grok/bin/grok'), ['--version'], { encoding: 'utf8' }).trim() : 'pi 0.87.0';
      console.log(JSON.stringify({ agent, version, connection: 'ready', nativeSessionId: result.nativeId, capabilities: result.capabilities }, null, 2));
    } catch (error) { console.log(JSON.stringify({ agent, connection: 'failed', error: redact(error) })); process.exitCode = 1; }
    finally { await adapter.close(); }
  }
}
main().catch(error => { console.error(redact(error)); process.exitCode = 1; });
