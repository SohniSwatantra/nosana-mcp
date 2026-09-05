#!/usr/bin/env node
// End-to-end: recommend_plan -> create_deployment -> wait (phases) -> /v1/models -> get_endpoint_usage -> stop.
// Deploys Qwen 3.6 27B for real (about 0.2 credits per hour, stopped as soon as it answers). Run: npm run test:e2e-llm
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/mcp/index.js'], env, stderr: 'ignore' });
const client = new Client({ name: 'llm-e2e', version: '0' }); await client.connect(transport);
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const e = JSON.parse(r.content[0].text); console.log(`\n=== ${name} ${JSON.stringify(args)} -> ok=${e.ok} outcome=${e.outcome ?? '-'} phase=${e.phase ?? '-'} elapsed=${e.elapsed_seconds ?? '-'} poll_after=${e.poll_after_seconds ?? '-'}\n  ${e.message}`); return e; };
const plan = await call('recommend_plan', { workload: 'qwen3-6-27b', timeout_minutes: 60 });
if (plan.outcome !== 'ready') { console.log('no ready GPU, aborting'); process.exit(1); }
const created = await call('create_deployment', { ...plan.create_args, confirm: true, name: 'mcp-e2e-qwen27b' });
console.log('  created', created.deployment_id, JSON.stringify(created.gpu));
let last; const t0 = Date.now();
for (let i = 0; i < 40 && Date.now() - t0 < 14 * 60_000; i += 1) {
  last = await call('wait_for_deployment', { deployment_id: created.deployment_id, max_seconds: 30 });
  if (last.outcome !== 'pending') break;
  await new Promise((r) => setTimeout(r, Math.min(20, last.poll_after_seconds ?? 10) * 1000));
}
if (last.outcome === 'online') {
  console.log('  ready_urls:', last.ready_urls, '\n  usage.openai_base_url:', last.usage?.openai_base_url, '\n  usage.list_models:', last.usage?.list_models);
  try { const models = await fetch(`${last.ready_urls[0]}/v1/models`, { signal: AbortSignal.timeout(15000) }); console.log('  GET /v1/models ->', models.status, (await models.text()).slice(0, 300)); } catch (e) { console.log('  /v1/models fetch failed:', e.message); }
  await call('get_endpoint_usage', { deployment_id: created.deployment_id });
}
const stopped = await call('stop_deployment', { deployment_id: created.deployment_id });
console.log('  final status:', stopped.status);
await client.close();
console.log(`\nLLM_E2E_DONE outcome=${last?.outcome} total_seconds=${Math.round((Date.now() - t0) / 1000)} deployment=${created.deployment_id}`);
