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

let failures = 0;
const check = (cond, label) => { if (!cond) { failures += 1; console.log(`  FAIL: ${label}`); } };
const call = async (name, args = {}, show = []) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? '').join('\n');
  let env;
  try { env = JSON.parse(text); } catch { env = null; }
  check(env !== null, `${name}: text content is not pure JSON`);
  check(r.structuredContent && typeof r.structuredContent.ok === 'boolean', `${name}: missing structuredContent.ok`);
  const e = env ?? {};
  console.log(`\n=== ${name} ${JSON.stringify(args)}${r.isError ? '  (isError)' : ''}\n  ok=${e.ok} outcome=${e.outcome ?? '-'} next_tool=${e.next_tool ?? '-'}\n  message: ${(e.message ?? '').slice(0, 220)}`);
  for (const key of show) if (e[key] !== undefined) console.log(`  ${key}: ${JSON.stringify(e[key]).slice(0, 400)}`);
  return e;
};

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);
check(tools.every((t) => t.outputSchema), 'every tool declares an outputSchema');
const { resources } = await client.listResources();
console.log(`resources: ${resources.map((r) => r.uri).join(', ')}`);
const { prompts } = await client.listPrompts();
console.log(`prompts: ${prompts.map((p) => p.name).join(', ')}`);

const doctor = await call('doctor', {}, ['checks']);
check(doctor.ok === true, 'doctor ok');
await call('get_balance', {}, ['available']);
const tl = await call('list_templates', { search: 'qwen' }, []);
check(Array.isArray(tl.templates) && tl.templates.every((t) => t.kind === 'llm'), 'qwen templates are kind llm');
console.log('  templates:', tl.templates.map((t) => `${t.id}(${t.vram_gb}GB)`).join(', '));
await call('get_template', { template: 'minimax-h3/i2v-32gb' }, ['vram_gb', 'blackwell_only', 'boot_minutes_typical', 'ports', 'recommended_gpus']);
const gpus = await call('list_gpus', { template: 'minimax-h3', variant: 'i2v-32gb' }, ['ready_now', 'fits_but_queued', 'idle_with_risk', 'unsupported']);
check(Array.isArray(gpus.unsupported) && gpus.unsupported.some((g) => /a6000|a100|h100/i.test(g.gpu)), 'A6000/A100/H100 are unsupported for MiniMax');
const nv = await call('recommend_plan', { workload: 'minimax-h3' }, []);
check(nv.outcome === 'needs_variant', 'minimax-h3 needs a variant');
const mm = await call('recommend_plan', { workload: 'minimax-h3/i2v-32gb' }, ['recommended', 'running_similar', 'create_args']);
check(mm.outcome === 'ready' || mm.outcome === 'needs_decision', 'minimax plan resolves');
if (mm.recommended) check(/5090|pro.?6000/i.test(mm.recommended.gpu), 'minimax recommendation is a Blackwell card');
const amb = await call('recommend_plan', { workload: 'qwen 27b' }, ['candidates']);
check(amb.outcome === 'needs_choice' && amb.candidates.length >= 2, '"qwen 27b" is ambiguous (3.5 and 3.6)');
const qwen = await call('recommend_plan', { workload: 'qwen3-6-27b' }, ['recommended', 'create_args']);
check(qwen.outcome === 'ready' && qwen.recommended && qwen.recommended.vram_gb >= 23, 'qwen3-6-27b gets a >=24 GB idle GPU');
const est = await call('estimate_deployment', { template: 'hello-world', gpu: 'auto' }, ['gpu', 'estimated_credits', 'deployable']);
check(est.ok && est.gpu_auto_selected === true, 'auto GPU selection works');
const nc = await call('create_deployment', { template: 'hello-world', gpu: 'auto' }, []);
check(nc.outcome === 'not_created', 'create without confirm is refused');
const bad = await call('create_deployment', { template: 'minimax-h3', variant: 'i2v-32gb', gpu: 'nvidia-3060', confirm: true }, ['blocking']);
check(bad.outcome === 'not_created' && bad.blocking.length > 0, '3060 for MiniMax is blocked even with confirm');
await call('list_deployments', { limit: 3 }, ['running_count']);
const stopped = (await call('list_deployments', { limit: 20, status: 'STOPPED', search: 'minimax' }, [])).deployments?.[0];
if (stopped) {
  const usage = await call('get_endpoint_usage', { deployment_id: stopped.deployment_id }, ['kind', 'ui_url', 'ready']);
  check(usage.kind === 'comfyui', 'MiniMax deployment reports kind comfyui');
  const gd = await call('get_deployment', { deployment_id: stopped.deployment_id }, ['phase', 'usd_per_hour']);
  check(gd.phase === 'stopped', 'stopped deployment has phase stopped');
}
const errEnv = await call('get_deployment', { deployment_id: 'not-a-real-id' }, ['error', 'hint']);
check(errEnv.ok === false, 'bad id yields ok=false envelope');
const res = await client.readResource({ uri: 'nosana://gpus' });
console.log(`\n=== resource nosana://gpus: ${res.contents[0].text.length} chars`);
const prompt = await client.getPrompt({ name: 'deploy_llm', arguments: { model: 'qwen3-6-27b' } });
console.log(`=== prompt deploy_llm:\n${prompt.messages[0].content.text.split('\n').slice(0, 3).join('\n')} ...`);

if (process.env.SMOKE_DEPLOY === '1') {
  const created = await call('create_deployment', { template: 'hello-world', gpu: 'auto', confirm: true, name: 'mcp-smoke-hello' }, ['deployment_id', 'gpu', 'estimated_credits']);
  check(created.outcome === 'started', 'hello-world created and started');
  let last;
  for (let i = 0; i < 8; i += 1) {
    last = await call('wait_for_deployment', { deployment_id: created.deployment_id, max_seconds: 20 }, ['phase', 'elapsed_seconds', 'poll_after_seconds', 'logs']);
    if (last.outcome !== 'pending') break;
  }
  check(last.outcome === 'completed', 'hello-world completed via MCP');
  await call('get_job_result', { deployment_id: created.deployment_id }, ['logs']);
}

await client.close();
console.log(failures ? `\nsmoke test finished with ${failures} failure(s)` : '\nsmoke test finished: all checks passed');
process.exit(failures ? 1 : 0);
