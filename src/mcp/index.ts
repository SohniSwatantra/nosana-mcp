#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatError, stripAnsi } from '../core/format.js';
import { gpusResource, minimaxPromptText, templatesResource, ToolContext, tools } from './tools.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
const network = process.env.NOSANA_NETWORK === 'devnet' ? 'devnet' : 'mainnet';
const ctx = new ToolContext(network);

const server = new McpServer(
  { name: 'nosana', version },
  {
    instructions: [
      'Nosana MCP lets you rent GPUs on the Nosana network and deploy ready-to-run templates (MiniMax H3 video, Qwen/Gemma LLMs, ComfyUI, Jupyter) or custom job definitions, paid with the account credits behind the API key.',
      'Deployments cost real credits (1 credit is priced like 1 USD). Always run estimate_deployment and show the user the cost before create_deployment, and only pass confirm=true after they agree.',
      `Nosana refuses timeouts under 60 minutes. Big templates such as MiniMax H3 need 120 minutes or more and can take many minutes to download weights; poll wait_for_deployment until the outcome is "online".`,
      'When the user is done, call stop_deployment to end billing.',
    ].join(' '),
  },
);

for (const definition of tools) {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.shape,
      annotations: definition.annotations,
    },
    async (args) => {
      try {
        const text = stripAnsi(await definition.run(ctx, args));
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${stripAnsi(formatError(error))}` }] };
      }
    },
  );
}

server.registerResource(
  'templates',
  'nosana://templates',
  { title: 'Nosana templates', description: 'Ready-to-run template catalog with variants and VRAM needs.', mimeType: 'application/json' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: await templatesResource(ctx) }] }),
);

server.registerResource(
  'gpus',
  'nosana://gpus',
  { title: 'Nosana GPU markets', description: 'GPU markets with price per hour and idle hosts right now.', mimeType: 'application/json' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: await gpusResource(ctx) }] }),
);

server.registerPrompt(
  'deploy_minimax_h3',
  {
    title: 'Deploy MiniMax H3 on Nosana',
    description: 'Guided flow: check credits, pick the variant and GPU, estimate, confirm, deploy, and hand back the ComfyUI URL.',
    argsSchema: {
      variant: z.string().optional().describe('i2v-32gb, i2v-80gb, ref2v-32gb or ref2v-80gb'),
      gpu: z.string().optional().describe('GPU slug, e.g. nvidia-5090'),
    },
  },
  ({ variant, gpu }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: minimaxPromptText(variant, gpu) } }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[nosana-mcp] v${version} ready on stdio (${network}); ${tools.length} tools\n`);
