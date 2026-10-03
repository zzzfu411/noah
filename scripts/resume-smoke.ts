import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.ts';
import { redact } from '../src/config.ts';
import type { AgentId } from '../src/store.ts';

// Use a completed smoke fixture. Two new real model runs test native context restoration.
if (!process.env.NOAH_SMOKE_DIR) throw new Error('Set NOAH_SMOKE_DIR to a previously passed smoke directory');
const dataDir = resolve(process.env.NOAH_SMOKE_DIR);
const previous = JSON.parse(readFileSync(join(dataDir, 'report.json'), 'utf8'));
if (previous.result !== 'passed') throw new Error('A passed two-way smoke fixture is required');
const app = await startServer({ dataDir, port: 0 });
const report: any = { date: new Date().toISOString(), model: previous.config.model, cases: [] };
try {
  const c = app.store.snapshot().conversations[0] as any;
  const before = new Map((app.store.snapshot().sessions as any[]).map(s => [s.agent, s.native_id]));
  const after = app.store.messages(c.id, 0, 1000).at(-1)!.seq;
  const remaining = c.max_runs - c.used_runs;
  app.store.control(c.id, 'resume', Math.max(0, 2 - remaining), 5);
  for (const agent of ['grok', 'pi'] as AgentId[]) {
    app.store.send(c.id, 'human', agent,
      '现在验证重启后本会话的历史恢复。请回想：之前你自己作为发起者时，由另一位 Agent 读取共享资料后发回给你的 Challenge token 是什么？用 noah_send 给 human 回复 RESTORED:<那个token>。不要读取材料或共享消息，不要向同伴询问，只依靠你已恢复的原生会话历史。发完就结束；记不清则明确说不知道。', randomUUID());
  }
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const snap = app.store.snapshot() as any;
    const messages = app.store.messages(c.id, after, 1000);
    const failure = snap.deliveries.find((d: any) => ['failed', 'uncertain'].includes(d.state));
    if (failure) throw new Error(`${failure.agent}: ${failure.error}`);
    if (!snap.deliveries.some((d: any) => ['queued', 'dispatching', 'context_accepted'].includes(d.state))) {
      for (const item of previous.cases) {
        const session = app.store.session(c.id, item.initiator);
        const reply = messages.find(m => m.sender === item.initiator && m.recipient === 'human' && m.content.includes(`RESTORED:${item.marker}`));
        if (!reply || session.native_id !== before.get(item.initiator)) throw new Error(`${item.initiator}: original session/context was not restored`);
        report.cases.push({ agent: item.initiator, nativeSessionId: session.native_id, result: 'passed', messageId: reply.id });
      }
      report.result = 'passed'; break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!report.result) throw new Error('Session restoration test timed out');
} catch (error) { report.result = 'failed'; report.error = redact(error); process.exitCode = 1; }
finally {
  await app.close();
  writeFileSync(join(dataDir, 'resume-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
