#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatError, stripAnsi } from '../core/format.js';
import { CliError } from '../core/client.js';
import { gpusResource, prompts, templatesResource, ToolContext, tools, WAIT_MAX_SECONDS, type Envelope } from './tools.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
const network = process.env.NOSANA_NETWORK === 'devnet' ? 'devnet' : 'mainnet';
const ctx = new ToolContext(network);

const server = new McpServer(
  { name: 'nosana', version },
  {
    instructions: [
      'Nosana MCP rents GPUs on the Nosana network and deploys ready-to-run templates (MiniMax H3 video, Qwen/Gemma/GPT-OSS LLMs, DeepSeek, ComfyUI, Jupyter, VS Code) or custom job definitions, paid with the account credits behind the API key. 1 credit is priced like 1 USD.',
      'Start with recommend_plan(workload). Prefer GPUs in ready_now (fits, idle host). Queue on a fits_but_queued GPU only if the user accepts waiting (accept_queue=true). Use an idle_with_risk GPU only if the user accepts the caveat (force=true). Never use an unsupported GPU.',
      'Always show the user the estimated credits and USD per hour before create_deployment, and pass confirm=true only after they agree. Check running_similar first; do not stack a second copy of the same workload without asking.',
      `Nosana refuses timeouts under 60 minutes. Poll wait_for_deployment with max_seconds <= ${WAIT_MAX_SECONDS} and relay the phase to the user; big templates take 5 to 15 minutes to download weights. outcome "stopped" means the user or the timeout stopped it, not a failure.`,
      'Every response is a JSON object with ok, message, and next_tool/next_args suggesting the next call. When the workload is online, call get_endpoint_usage and hand the user the URL plus how to use it. Idle deployments burn credits: remind the user to stop_deployment when done.',
    ].join(' '),
  },
);

const envelopeShape = {
  ok: z.boolean().describe('false only when the tool itself failed (bad input, missing key, API error).'),
  message: z.string().describe('Human-readable summary to relay to the user.'),
  next_tool: z.string().nullable().optional().describe('Suggested next tool, or null when nothing else is needed.'),
  next_args: z.record(z.string(), z.unknown()).optional().describe('Suggested arguments for next_tool.'),
};

// Loose: every tool adds its own fields on top of the envelope, and clients validate structuredContent strictly.
const envelopeSchema = z.looseObject(envelopeShape);

const toResult = (envelope: Envelope, isError = false) => ({
  isError,
  content: [{ type: 'text' as const, text: stripAnsi(JSON.stringify(envelope, null, 2)) }],
  structuredContent: envelope as unknown as Record<string, unknown>,
});

for (const definition of tools) {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: `${definition.description} Returns JSON: {ok, message, next_tool, next_args, ...tool-specific fields}.`,
      inputSchema: definition.shape,
      outputSchema: envelopeSchema,
      annotations: definition.annotations,
    },
    async (args) => {
      try {
        return toResult(await definition.run(ctx, args));
      } catch (error) {
        const message = stripAnsi(formatError(error));
        const hint =
          error instanceof CliError && error.exitCode === 2
            ? 'Fix the arguments and call again.'
            : /No Nosana API key/.test(message)
              ? 'Call doctor for the exact configuration fix.'
              : /fetch failed|ENOTFOUND|timed out|50[234]/.test(message)
                ? 'Transient network problem talking to Nosana; retry in a few seconds.'
                : undefined;
        return toResult({ ok: false, message, error: message, hint, next_tool: /No Nosana API key/.test(message) ? 'doctor' : null }, true);
      }
    },
  );
}

server.registerResource(
  'templates',
  'nosana://templates',
  { title: 'Nosana templates', description: 'Ready-to-run template catalog with kinds, variants and VRAM needs.', mimeType: 'application/json' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: await templatesResource(ctx) }] }),
);

server.registerResource(
  'gpus',
  'nosana://gpus',
  { title: 'Nosana GPU markets', description: 'GPU markets bucketed by idle availability with price per hour.', mimeType: 'application/json' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: await gpusResource(ctx) }] }),
);

const message = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

server.registerPrompt(
  'deploy_template',
  {
    title: 'Deploy any Nosana template',
    description: 'Generic flow: recommend_plan, confirm cost, create, poll, hand back the URL and usage, remind to stop.',
    argsSchema: { workload: z.string().describe('Template id, "id/variant", or a loose name like "qwen 27b"'), gpu: z.string().optional(), timeout_minutes: z.string().optional() },
  },
  ({ workload, gpu, timeout_minutes }) => message(prompts.deploy_template(workload, gpu, timeout_minutes)),
);
server.registerPrompt(
  'deploy_llm',
  { title: 'Deploy an LLM with an OpenAI-compatible endpoint', description: 'Qwen, Gemma, GPT-OSS or DeepSeek on the cheapest GPU that fits; returns OPENAI_BASE_URL.', argsSchema: { model: z.string().optional().describe('e.g. qwen3-6-27b, gemma3-12b, gpt-oss-20b') } },
  ({ model }) => message(prompts.deploy_llm(model)),
);
server.registerPrompt(
  'deploy_comfy',
  { title: 'Deploy ComfyUI', description: 'Generic ComfyUI or MiniMax H3 with the right GPU class.', argsSchema: { workflow: z.string().optional().describe('e.g. comfyui/sdxl or minimax-h3/i2v-32gb') } },
  ({ workflow }) => message(prompts.deploy_comfy(workflow)),
);
server.registerPrompt(
  'deploy_minimax_h3',
  { title: 'Deploy MiniMax H3 on Nosana', description: 'MiniMax H3 video generation in ComfyUI on a Blackwell GPU.', argsSchema: { variant: z.string().optional().describe('i2v-32gb, i2v-80gb, ref2v-32gb or ref2v-80gb'), gpu: z.string().optional() } },
  ({ variant, gpu }) => message(prompts.deploy_minimax_h3(variant, gpu)),
);
server.registerPrompt(
  'stop_when_done',
  { title: 'Stop running deployments', description: 'List what is running and stop it so billing ends.', argsSchema: {} },
  () => message(prompts.stop_when_done()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[nosana-mcp] v${version} ready on stdio (${network}); ${tools.length} tools\n`);
