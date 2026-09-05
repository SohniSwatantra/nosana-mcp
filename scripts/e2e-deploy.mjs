#!/usr/bin/env node
// Drives the PUBLISHED package (npx -y nosana-mcp@<version>) like a real MCP client:
//   node scripts/e2e-deploy.mjs <workload> [gpu] [--keep] [--timeout=120]
// Example: node scripts/e2e-deploy.mjs minimax-h3/i2v-32gb nvidia-5090 --keep
// Spends credits. Without --keep the deployment is stopped once the service answers.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { version } = createRequire(import.meta.url)('../package.json');
const [workload, gpuArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const keep = process.argv.includes('--keep');
const timeoutArg = process.argv.find((a) => a.startsWith('--timeout='));
const timeout_minutes = timeoutArg ? Number(timeoutArg.split('=')[1]) : undefined;
if (!workload) { console.error('usage: e2e-deploy.mjs <workload> [gpu] [--keep] [--timeout=N]'); process.exit(2); }

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined));
// Run npx from a scratch directory so it resolves the published package, not this repo (which has the same name).
const transport = new StdioClientTransport({ command: 'npx', args: ['-y', `nosana-mcp@${version}`], env, cwd: mkdtempSync(join(tmpdir(), 'nosana-mcp-e2e-')), stderr: 'pipe' });
transport.stderr?.on('data', (d) => process.stdout.write(`[server] ${d}`));
const client = new Client({ name: 'e2e-deploy', version: '0' });
await client.connect(transport);
const stamp = () => new Date().toISOString().slice(11, 19);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const e = JSON.parse(r.content[0].text);
  console.log(`\n${stamp()} === ${name} ${JSON.stringify(args)}\n  ok=${e.ok} outcome=${e.outcome ?? '-'} phase=${e.phase ?? '-'} elapsed=${e.elapsed_seconds ?? '-'}s poll_after=${e.poll_after_seconds ?? '-'}\n  ${e.message}`);
  return e;
};

const plan = await call('recommend_plan', { workload, ...(timeout_minutes ? { timeout_minutes } : {}) });
if (plan.outcome === 'needs_variant' || plan.outcome === 'needs_choice') { console.log(JSON.stringify(plan.template ?? plan.candidates, null, 1)); process.exit(1); }
console.log('  buckets:', JSON.stringify({ ready_now: plan.gpus.ready_now.map((g) => `${g.gpu}(${g.idle_hosts} idle, $${g.usd_per_hour}/h)`), fits_but_queued: plan.gpus.fits_but_queued.map((g) => g.gpu), unsupported: plan.gpus.unsupported.map((g) => g.gpu) }));

let args = { ...(plan.create_args ?? plan.next_args), confirm: true };
if (gpuArg) {
  const ready = plan.gpus.ready_now.find((g) => g.gpu === gpuArg || g.gpu === `nvidia-${gpuArg}`);
  const unsupported = plan.gpus.unsupported.find((g) => g.gpu === gpuArg || g.gpu === `nvidia-${gpuArg}`);
  if (unsupported) { console.log(`  requested GPU ${gpuArg} is UNSUPPORTED for this workload (${unsupported.reason}); refusing to force it.`); process.exit(1); }
  args = { ...args, gpu: gpuArg, accept_queue: !ready };
  if (!ready) console.log(`  requested GPU ${gpuArg} has no idle host; queueing with accept_queue=true as requested.`);
}
if (timeout_minutes) args.timeout_minutes = timeout_minutes;

const created = await call('create_deployment', args);
if (created.outcome !== 'started') { console.log(JSON.stringify(created, null, 1).slice(0, 1500)); process.exit(1); }
console.log(`  deployment ${created.deployment_id} on ${created.gpu.gpu} at $${created.usd_per_hour}/h, timeout ${created.timeout_minutes} min, est ${created.estimated_credits} credits\n  ${created.dashboard_url}`);

let last;
const t0 = Date.now();
while (Date.now() - t0 < 40 * 60_000) {
  last = await call('wait_for_deployment', { deployment_id: created.deployment_id, max_seconds: 30 });
  if (last.outcome !== 'pending') break;
  await new Promise((r) => setTimeout(r, Math.min(30, last.poll_after_seconds ?? 15) * 1000));
}

if (last.outcome === 'online') {
  const url = last.ready_urls[0];
  console.log(`  READY URL: ${url}\n  kind: ${last.kind}`);
  const probe = async (path) => { try { const r = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(20000) }); const t = await r.text(); return `${r.status} ${t.slice(0, 300).replace(/\s+/g, ' ')}`; } catch (e) { return `ERR ${e.message}`; } };
  if (last.kind === 'comfyui') {
    console.log('  GET /system_stats ->', await probe('/system_stats'));
    console.log('  GET /models/diffusion_models ->', await probe('/models/diffusion_models'));
    console.log('  GET /models/text_encoders ->', await probe('/models/text_encoders'));
    console.log('  GET /models/loras ->', await probe('/models/loras'));
  } else if (last.kind === 'llm') {
    console.log('  GET /v1/models ->', await probe('/v1/models'));
  } else {
    console.log('  GET / ->', await probe('/'));
  }
  const usage = await call('get_endpoint_usage', { deployment_id: created.deployment_id });
  console.log('  usage keys:', Object.keys(usage).filter((k) => !['ok', 'message', 'next_tool', 'next_args'].includes(k)).join(', '));
}

if (!keep) {
  const stopped = await call('stop_deployment', { deployment_id: created.deployment_id });
  console.log('  final status:', stopped.status);
} else {
  console.log(`  --keep: leaving ${created.deployment_id} running (stops itself at its ${created.timeout_minutes} min timeout).`);
}
await client.close();
console.log(`\nE2E_DONE outcome=${last?.outcome} total_seconds=${Math.round((Date.now() - t0) / 1000)} deployment=${created.deployment_id}`);
