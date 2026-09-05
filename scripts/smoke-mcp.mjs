#!/usr/bin/env node
// Smoke test: talks to the built MCP server over stdio like a real client would.
// Read-only by default. Set SMOKE_DEPLOY=1 to also deploy hello-world (costs ~0.05 credits).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/mcp/index.js'], env, stderr: 'pipe' });
transport.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
const client = new Client({ name: 'nosana-mcp-smoke', version: '0.0.0' });
await client.connect(transport);

const text = (r) => r.content.map((c) => c.text ?? '').join('\n');
const call = async (name, args = {}, max = 1200) => {
  const r = await client.callTool({ name, arguments: args });
  const t = text(r);
  console.log(`\n=== ${name} ${JSON.stringify(args)}${r.isError ? '  (isError)' : ''}\n${t.length > max ? `${t.slice(0, max)}\n... (${t.length} chars)` : t}`);
  return { r, t };
};

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);
const { resources } = await client.listResources();
console.log(`resources: ${resources.map((r) => r.uri).join(', ')}`);
const { prompts } = await client.listPrompts();
console.log(`prompts: ${prompts.map((p) => p.name).join(', ')}`);

await call('get_balance');
await call('list_templates', { search: 'minimax' });
await call('get_template', { template: 'minimax-h3', variant: 'i2v-32gb' });
await call('list_gpus', { template: 'minimax-h3', variant: 'i2v-32gb' }, 900);
await call('estimate_deployment', { template: 'minimax-h3', variant: 'i2v-32gb', gpu: '5090', timeout_minutes: 120 });
await call('estimate_deployment', { template: 'minimax-h3', variant: 'i2v-32gb', gpu: 'nvidia-3060', timeout_minutes: 120 }, 700);
await call('create_deployment', { template: 'hello-world', gpu: 'nvidia-3060', timeout_minutes: 60 }, 400); // confirm missing -> refused
await call('list_deployments', { limit: 3 }, 600);
const gpusRes = await client.readResource({ uri: 'nosana://gpus' });
console.log(`\n=== resource nosana://gpus: ${gpusRes.contents[0].text.length} chars`);
const prompt = await client.getPrompt({ name: 'deploy_minimax_h3', arguments: { variant: 'i2v-32gb' } });
console.log(`\n=== prompt deploy_minimax_h3:\n${prompt.messages[0].content.text.split('\n').slice(0, 4).join('\n')} ...`);

if (process.env.SMOKE_DEPLOY === '1') {
  const created = await call('create_deployment', { template: 'hello-world', gpu: 'nvidia-3060', timeout_minutes: 60, confirm: true, name: 'mcp-smoke-hello' });
  const id = JSON.parse(created.t.slice(created.t.indexOf('{'))).deployment_id;
  for (let i = 0; i < 6; i += 1) {
    const { t } = await call('wait_for_deployment', { deployment_id: id, max_seconds: 30 }, 900);
    if (!t.startsWith('PENDING')) break;
  }
  await call('get_job_result', { deployment_id: id }, 600);
  await call('get_deployment', { deployment_id: id }, 900);
}

await client.close();
console.log('\nsmoke test finished');
