import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { toolCatalog, validateTool } from './tool-definitions.ts';

const binding = JSON.parse(readFileSync(process.env.NOAH_BINDING_FILE!, 'utf8')) as { url: string; token: string };
const server = new Server({ name: 'noah', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolCatalog as any }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const args = validateTool(request.params.name, request.params.arguments || {});
    const response = await fetch(binding.url + '/api/tool', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.token}` },
      body: JSON.stringify({ name: request.params.name, args, callId: randomUUID() }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !response.ok };
  } catch { return { content: [{ type: 'text', text: 'Noah tool rejected invalid input or could not connect. Check the task state before retrying.' }], isError: true }; }
});
await server.connect(new StdioServerTransport());
