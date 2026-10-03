import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startServer } from '../src/server.ts';
import { loadGrokConfig, privateDir, redact } from '../src/config.ts';
import type { AgentId } from '../src/store.ts';

// Opt-in real harness cancellation, bounded to two dispatched turns.
const config = loadGrokConfig();
const dataDir = privateDir(resolve(`.noah/cancel-smoke/${Date.now()}`));
const app = await startServer({ dataDir, port: 0 });
const report: any = { date: new Date().toISOString(), model: config.model, cases: [] };
try {
  for (const agent of ['grok', 'pi'] as AgentId[]) {
    const c = app.store.create(`取消 ${agent} 验证`, 1, 5, config.alias);
    app.store.send(c.id, 'human', agent, '这是取消测试。请在私有输出里逐行写出 1 到 10000 的整数，不要使用工具。', `cancel-${agent}`);
    let requested = 0;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const d = (app.store.snapshot().deliveries as any[]).find(d => d.conversation_id === c.id);
      if (['dispatching', 'context_accepted'].includes(d?.state) && !requested) {
        // Allow session/prompt to reach the child before the separate cancellation request.
        await new Promise(resolve => setTimeout(resolve, 250));
        requested = Date.now(); await app.engine.stopConversation(c.id);
      }
      if (['cancelled', 'failed', 'uncertain', 'completed'].includes(d?.state)) {
        if (d.state !== 'cancelled') throw new Error(`${agent}: expected confirmed cancellation, got ${d.state}: ${d.error || ''}`);
        report.cases.push({ agent, result: 'passed', state: d.state, elapsedAfterCancelMs: Date.now() - requested });
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (report.cases.length < (agent === 'grok' ? 1 : 2)) throw new Error(`${agent}: cancellation was not confirmed within 30 seconds`);
  }
  report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = redact(error); process.exitCode = 1; }
finally {
  await app.close();
  writeFileSync(join(dataDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath: join(dataDir, 'report.json') }, null, 2));
}
