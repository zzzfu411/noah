import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startServer } from '../src/server.ts';
import { loadGrokConfig, modelSummary, privateDir, redact } from '../src/config.ts';
import type { AgentId } from '../src/store.ts';

// Opt-in: real model requests through both installed harnesses. No provider fallback.
const config = loadGrokConfig();
const dataDir = privateDir(resolve(process.env.NOAH_SMOKE_DIR || `.noah/smoke/${Date.now()}`));
const app = await startServer({ dataDir, port: 0 });
const report: any = { date: new Date().toISOString(), config: modelSummary(config), dataDir, cases: [] };
console.log(JSON.stringify({ smoke: 'started', model: config.model, dataDir }));
try {
  const c = app.store.create('Grok ↔ pi 接入验证', 8, 15, config.alias);
  for (const initiator of ['grok', 'pi'] as AgentId[]) {
    const peer = initiator === 'grok' ? 'pi' : 'grok';
    const marker = randomBytes(5).toString('hex');
    const material = app.store.addMaterial(c.id, `${initiator}-challenge.txt`, `Challenge token: ${marker}\n`);
    const after = app.store.messages(c.id, 0, 1000).at(-1)?.seq || 0;
    app.store.send(c.id, 'human', initiator,
      `验证一次真实同伴通信。你是发起者，请立即用 noah_send 给 ${peer} 发送以下请求：\n“请用 noah_read_material 读取材料 ${material.id}，然后用 noah_send 只给 ${initiator} 回复其中的 Challenge token，最后结束本轮。不要直接给 human 回复。”\n你发完请求后结束当前轮次，等 Noah 将 ${peer} 的回复交给你。收到回复时，用 noah_send 给 human 发送文本 VERIFIED:${marker}，随后结束。不要自己代替同伴读取这份材料。`,
      `smoke-${marker}`);
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const snapshot = app.store.snapshot() as any;
      const failure = snapshot.deliveries.find((d: any) => ['failed', 'uncertain'].includes(d.state));
      if (failure) throw new Error(`${failure.agent}: ${failure.error}`);
      const messages = app.store.messages(c.id, after, 1000);
      const fromInitiator = messages.find(m => m.sender === initiator && m.recipient === peer);
      const fromPeer = messages.find(m => m.sender === peer && m.recipient === initiator && m.content.includes(marker));
      const final = messages.find(m => m.sender === initiator && m.recipient === 'human' && m.content.includes(`VERIFIED:${marker}`));
      const running = snapshot.deliveries.some((d: any) => ['queued', 'dispatching', 'context_accepted'].includes(d.state));
      if (fromInitiator && fromPeer && final && !running) {
        const result = { initiator, peer, result: 'passed', marker, messageIds: [fromInitiator.id, fromPeer.id, final.id] };
        report.cases.push(result); console.log(JSON.stringify(result)); break;
      }
      if (app.store.conversation(c.id).status === 'paused') throw new Error(app.store.conversation(c.id).reason || 'Task paused');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (report.cases.length < (initiator === 'grok' ? 1 : 2)) throw new Error(`${initiator} peer exchange timed out`);
  }
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.error = redact(error); process.exitCode = 1;
  console.error(report.error);
} finally {
  await app.close();
  // Save only selected, sanitized proof; no provider key or owner/agent credentials.
  writeFileSync(join(dataDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, report: join(dataDir, 'report.json') }));
}
