import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { localBridgeTransport, PiBridgeClient } from '../src/native-bridge-client.ts';

/** Explicitly load with pi -e /path/to/noah/extensions/noah-pi.ts, or a project-local import. */
export default function noahPi(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let client: PiBridgeClient | undefined;
  const update = (ctx: ExtensionContext) => { context = ctx; };
  pi.on('session_start', async (_event, ctx) => { if (client) await client.disconnect(); client = undefined; update(ctx); });
  pi.on('session_before_switch', async () => { await client?.disconnect(); });
  pi.on('session_before_fork', async () => { await client?.disconnect(); });
  pi.on('session_shutdown', async () => { await client?.disconnect(); });
  pi.on('session_tree', async () => { await client?.pause(); context?.ui.notify('Noah：会话分支已改变，自动接收与唤醒已暂停。核对后请解除旧连接并重新连接。', 'warning'); });
  pi.on('session_compact', async () => { await client?.pause(); context?.ui.notify('Noah：原会话已压缩，自动接收与唤醒已暂停，避免误称完整讨论仍在当前上下文。', 'warning'); });
  pi.on('agent_settled', async (_event, ctx) => { update(ctx); await client?.agentSettled(); });
  pi.on('agent_start', (_event, ctx) => { update(ctx); });
  pi.on('ui_prompt_start', () => { client?.setWaitingUser(true); });
  pi.on('ui_prompt_end', () => { client?.setWaitingUser(false); });
  pi.registerCommand('noah-connect', {
    description: '将此 pi 原会话连接到 Noah（参数：Noah 生成的授权文件路径）',
    handler: async (args, ctx) => {
      update(ctx);
      if (!args.trim()) { ctx.ui.notify('用法：/noah-connect /绝对路径/noah-bridge-grant.json', 'warning'); return; }
      const file = resolve(args.trim().replace(/^['"]|['"]$/g, ''));
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 8192 || stat.mode & 0o077) throw new Error('授权文件必须是私有普通文件（chmod 600），且小于 8 KiB');
      const grant = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof grant.url !== 'string' || typeof grant.joinToken !== 'string') throw new Error('Noah 授权文件格式无效');
      if (client) await client.disconnect();
      client = new PiBridgeClient({
        nativeSessionId: () => context!.sessionManager.getSessionId(),
        projectDir: () => context!.cwd,
        label: () => grant.label || context!.sessionManager.getSessionName() || `pi · ${basename(context!.cwd)}`,
        isIdle: () => context!.isIdle(), hasPendingMessages: () => context!.hasPendingMessages(),
        entries: () => context!.sessionManager.getEntries(),
        contextEntries: () => context!.sessionManager.buildSessionProjection().entries.filter(e => {
          const source = e.sourceEntry;
          return source.type === 'custom_message' && e.messages.some(m => m.role === 'custom' && m.customType === source.customType && m.content === source.content);
        }).map(e => e.sourceEntry),
        sendMessage: (message, options) => pi.sendMessage(message, options),
        notify: (message, error) => context!.ui.notify(message, error ? 'warning' : 'info'),
      }, localBridgeTransport(grant.url));
      await client.connect(grant.joinToken);
      void client.tick();
    },
  });
  pi.registerCommand('noah-disconnect', { description: '停止 Noah 连接并撤销此原会话凭证', handler: async (_args, ctx) => { await client?.disconnect(); client = undefined; ctx.ui.notify('Noah 已断开；当前 pi 工作会话继续保留。', 'info'); } });
  const conversationId = Type.String({ description: 'Discussion ID from noah_peers' });
  const definitions = [
    { name: 'noah_peers', description: 'List Noah discussions that this native pi session has explicitly joined, and their peer identities.', parameters: Type.Object({}) },
    { name: 'noah_send', description: 'Explicitly publish a message to a Noah peer or human. Do not share private history, tools, or secrets unless the user explicitly authorized those contents. Publication identifies this native session as sender.', parameters: Type.Object({ conversationId, recipient: Type.String(), content: Type.String(), clientKey: Type.String({ description: 'Stable unique key; reuse only when retrying the identical message' }), inReplyTo: Type.Optional(Type.String()) }) },
    { name: 'noah_read', description: 'Read explicitly shared messages in a discussion this session joined.', parameters: Type.Object({ conversationId, after: Type.Optional(Type.Number()) }) },
    { name: 'noah_material', description: 'Read only a material explicitly shared with a joined Noah discussion.', parameters: Type.Object({ conversationId, id: Type.String(), offset: Type.Optional(Type.Number()) }) },
    { name: 'noah_request_human', description: 'Publish one concrete unresolved question to the human owner and pause Noah dispatch for that joined discussion. This does not change native permissions or grant additional authority.', parameters: Type.Object({ conversationId, question: Type.String(), clientKey: Type.String() }) },
    { name: 'noah_read_outcomes', description: 'Read evidence-based conclusions, disagreements and open questions. An owner decision is not unanimous consensus.', parameters: Type.Object({ conversationId }) },
    { name: 'noah_propose_outcome', description: 'Propose your own conclusion, disagreement or open question using shared message IDs as evidence. Only the owner confirms decisions.', parameters: Type.Object({ conversationId, kind: Type.Union([Type.Literal('conclusion'), Type.Literal('disagreement'), Type.Literal('open_question')]), title: Type.String(), content: Type.String(), evidence_message_ids: Type.Array(Type.String()), client_message_id: Type.Optional(Type.String()) }) },
    { name: 'noah_revise_outcome', description: 'Create a new version of your own proposal. Existing evidence, past versions and owner decisions stay in the ledger.', parameters: Type.Object({ conversationId, outcome_id: Type.String(), expected_revision: Type.Number(), title: Type.String(), content: Type.String(), evidence_message_ids: Type.Array(Type.String()) }) },
    { name: 'noah_list_workspaces', description: 'Read owner-shared directory paths and advisory work intents. No files are scanned or permissions changed.', parameters: Type.Object({ conversationId }) },
    { name: 'noah_declare_work', description: 'Declare intended changes to a relative path in an owner-shared workspace; overlaps are advisory, not file locks. Keep current native tool permissions.', parameters: Type.Object({ conversationId, workspace_id: Type.String(), path: Type.String(), description: Type.String(), ttl_seconds: Type.Optional(Type.Number()) }) },
    { name: 'noah_release_work', description: 'Release your own advisory work intent after completion or a change of plan.', parameters: Type.Object({ conversationId, intent_id: Type.String() }) },
  ];
  for (const def of definitions) pi.registerTool({ ...def, label: def.name, parameters: Type.Unsafe<Record<string, unknown>>(def.parameters), execute: async (_callId, args, _signal, _update, ctx) => { update(ctx); if (!client) throw new Error('此原生会话尚未连接 Noah'); const result = await client.tool(def.name, args); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: {} }; } });
}
