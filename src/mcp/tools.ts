import { validateJobDefinition, type JobDefinition, type NosanaClient } from '@nosana/kit';
import { z } from 'zod';
import { createClient, type ApiDeployment } from '../core/client.js';
import { resolveApiKey, type Network } from '../core/config.js';
import { availableCredits, summarizeBalance } from '../core/credits.js';
import {
  assessPlan,
  createDeployment,
  dashboardUrl,
  defaultDeploymentName,
  explorerJobUrl,
  formatJobResult,
  MIN_TIMEOUT_MINUTES,
  normalizeJobState,
  parseStrategy,
  probeEndpoint,
  validatePlan,
  waitForDeployment,
  type DeployPlan,
  type PlanAssessment,
} from '../core/deploy.js';
import { pageSize, stripAnsi } from '../core/format.js';
import { fitsVram, loadGpuCatalog, resolveGpu, type GpuMarket, type GpuTableOptions } from '../core/markets.js';
import {
  exposesPorts,
  hardwareHints,
  isBlackwell,
  listTemplates,
  prepareJobDefinition,
  resolveTemplate,
  topLevelTemplates,
  vramFromDefinition,
  type ResolvedTemplate,
  type TemplateInfo,
} from '../core/templates.js';

export const NO_KEY_MESSAGE =
  'No Nosana API key. Add NOSANA_API_KEY to the MCP server environment (create one at https://deploy.nosana.com under Account > API Keys), or run `nosana-deploy login` once on this machine.';

/** Lazily creates the Nosana client so tools/list works before a key is configured. */
export class ToolContext {
  private client?: NosanaClient;

  constructor(readonly network: Network) {}

  get(): NosanaClient {
    if (!this.client) {
      const key = resolveApiKey();
      if (!key) throw new Error(NO_KEY_MESSAGE);
      this.client = createClient({ network: this.network }, key.key, 'none');
    }
    return this.client;
  }
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  annotations: ToolAnnotations;
  run: (ctx: ToolContext, args: unknown) => Promise<string>;
}

function tool<S extends z.ZodRawShape>(
  name: string,
  meta: { title: string; description: string; annotations: ToolAnnotations },
  shape: S,
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<string>,
): ToolDefinition {
  return { name, shape, ...meta, run: (ctx, args) => run(ctx, z.object(shape).parse(args ?? {}) as z.infer<z.ZodObject<S>>) };
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const SPENDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const json = (value: unknown): string => JSON.stringify(value, null, 2);
const round = (n: number): number => Math.round(n * 1000) / 1000;

function gpuView(m: GpuMarket, fit?: GpuTableOptions): Record<string, unknown> {
  const view: Record<string, unknown> = {
    slug: m.slug,
    name: m.name,
    vram_gb: m.vramGb,
    price_per_hour_usd: round(m.pricePerHour),
    available_hosts: m.availableNodes,
    market_address: m.address,
  };
  if (m.queuedJobs !== null) view.jobs_waiting = m.queuedJobs;
  if (fit && (fit.minVramGb || fit.recommend)) {
    view.fit = !fitsVram(m, fit.minVramGb) ? 'too little VRAM' : fit.recommend && !fit.recommend(m) ? 'check hardware' : 'fits';
  }
  return view;
}

function templateView(t: TemplateInfo, all: TemplateInfo[]): Record<string, unknown> {
  const variants = t.variants.map((v) => {
    const vt = all.find((x) => x.id === `${t.id}-${v.id}`);
    return { id: v.id, name: v.name, description: v.description, vram_gb: vt?.vramRequirementGb ?? null };
  });
  const vrams = variants.map((v) => v.vram_gb).filter((n): n is number => n !== null);
  return {
    id: t.id,
    name: t.name,
    category: t.category.filter((c) => c !== 'Official'),
    vram_gb: t.vramRequirementGb ?? (vrams.length ? Math.min(...vrams) : null),
    needs_variant: variants.length > 0,
    variants,
    exposes_port: t.jobDefinition ? exposesPorts(t.jobDefinition) : undefined,
  };
}

const planShape = {
  template: z.string().optional().describe('Template id or name, e.g. "minimax-h3" (see list_templates). Omit when passing job_definition.'),
  variant: z.string().optional().describe('Variant id, e.g. "i2v-32gb". Required when the template has variants.'),
  job_definition: z.record(z.string(), z.unknown()).optional().describe('A custom Nosana job definition object instead of a template.'),
  gpu: z.string().describe('GPU market slug, short name or address, e.g. "nvidia-5090" or "5090" (see list_gpus).'),
  timeout_minutes: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MINUTES)
    .default(MIN_TIMEOUT_MINUTES)
    .describe(`Minutes the GPU is reserved per job. Nosana refuses anything below ${MIN_TIMEOUT_MINUTES}. Big templates such as MiniMax H3 want 120 or more.`),
  replicas: z.number().int().min(1).default(1).describe('Parallel jobs.'),
  strategy: z
    .enum(['SIMPLE', 'SIMPLE-EXTEND', 'SCHEDULED', 'INFINITE'])
    .default('SIMPLE')
    .describe('SIMPLE runs once and stops at the timeout (predictable cost). SIMPLE-EXTEND keeps extending while credits last. SCHEDULED needs schedule. INFINITE keeps a replacement job ready.'),
  schedule: z.string().optional().describe('Cron expression (5 fields). SCHEDULED strategy only.'),
  include_community_gpus: z.boolean().default(false).describe('Allow community GPU markets, not only the premium ones the dashboard shows.'),
};

type PlanInput = z.infer<z.ZodObject<typeof planShape>>;

interface PreparedPlan {
  plan: DeployPlan;
  resolved: ResolvedTemplate | null;
  fit: GpuTableOptions;
  hints: string[];
  assessment: PlanAssessment;
  creditsAvailable: number;
}

async function preparePlan(ctx: ToolContext, input: PlanInput, name?: string, confidential = false): Promise<PreparedPlan> {
  const client = ctx.get();
  if (!input.template && !input.job_definition) throw new Error('Pass template (plus variant when needed) or job_definition.');
  if (input.template && input.job_definition) throw new Error('Pass either template or job_definition, not both.');

  const [balance, templates, catalog] = await Promise.all([
    client.api.credits.balance(),
    input.template ? listTemplates(client) : Promise.resolve([] as TemplateInfo[]),
    loadGpuCatalog(client, { includeAll: input.include_community_gpus }),
  ]);

  let resolved: ResolvedTemplate | null = null;
  let jobDefinition: JobDefinition;
  let workload: string;
  if (input.template) {
    resolved = resolveTemplate(templates, input.template, input.variant);
    jobDefinition = prepareJobDefinition(resolved.jobDefinition, 'mcp');
    workload = resolved.id;
  } else {
    const validation = validateJobDefinition(input.job_definition);
    if (!validation.success) throw new Error(`Invalid job definition: ${JSON.stringify(validation.errors)}`);
    jobDefinition = prepareJobDefinition(input.job_definition as unknown as JobDefinition, 'mcp');
    workload = 'custom-job';
  }

  const gpu = resolveGpu(catalog, input.gpu);
  if (!gpu) {
    throw new Error(`Unknown GPU "${input.gpu}". Call list_gpus for valid slugs${input.include_community_gpus ? '' : ' (set include_community_gpus for community markets)'}.`);
  }

  const minVramGb = resolved ? resolved.template.vramRequirementGb : vramFromDefinition(jobDefinition);
  const hints = resolved ? hardwareHints(resolved.parent) : { blackwellOnly: false, minDriver: null, notes: [] as string[] };
  const fit: GpuTableOptions = { minVramGb, recommend: hints.blackwellOnly ? (m) => isBlackwell(m.name, m.slug) : undefined };

  const plan: DeployPlan = {
    name: name?.trim() || defaultDeploymentName(workload),
    workload,
    jobDefinition,
    gpu,
    timeoutMinutes: input.timeout_minutes,
    replicas: input.replicas,
    strategy: parseStrategy(input.strategy),
    schedule: input.schedule,
    confidential,
  };
  validatePlan(plan);
  const creditsAvailable = availableCredits(balance);
  return { plan, resolved, fit, hints: hints.notes, assessment: assessPlan(plan, fit, creditsAvailable), creditsAvailable };
}

function planView(prepared: PreparedPlan): Record<string, unknown> {
  const { plan, resolved, assessment, creditsAvailable, hints } = prepared;
  return {
    name: plan.name,
    workload: resolved
      ? { template: resolved.parent.id, variant: resolved.variant?.id ?? null, title: resolved.template.name }
      : { custom_job_definition: true },
    gpu: gpuView(plan.gpu, prepared.fit),
    strategy: plan.strategy,
    replicas: plan.replicas,
    timeout_minutes: plan.timeoutMinutes,
    estimated_cost_credits: round(assessment.cost.total),
    price_per_hour_usd: round(plan.gpu.pricePerHour),
    credits_available: round(creditsAvailable),
    hardware_notes: hints,
    warnings: assessment.warnings,
    ok_to_deploy: assessment.blocking.length === 0,
  };
}

async function endpointViews(dep: ApiDeployment): Promise<Record<string, unknown>[]> {
  return Promise.all(
    (dep.endpoints ?? []).map(async (e) => ({
      url: e.url,
      op: e.opId,
      port: e.port,
      tunnel_online: e.online,
      service_ready: e.online ? (await probeEndpoint(e.url)) === 'ready' : false,
    })),
  );
}

async function deploymentView(client: NosanaClient, dep: ApiDeployment, network: Network): Promise<Record<string, unknown>> {
  const extra = dep as unknown as { schedule?: string; rotation_time?: number };
  const [endpoints, jobs, events] = await Promise.all([
    endpointViews(dep),
    dep.getJobs({ limit: 10 }).then((r) => (r.jobs as { job: string; state: unknown; node?: string | null; created_at?: string }[]).slice(0, 5)).catch(() => []),
    dep.getEvents({ limit: 10, sort_order: 'desc' }).then((r) => (r.events as { type?: string; message?: string; created_at?: string }[]).slice(0, 5)).catch(() => []),
  ]);
  void client;
  return {
    deployment_id: dep.id,
    name: dep.name,
    status: dep.status,
    strategy: dep.strategy,
    schedule: extra.schedule,
    timeout_minutes: dep.timeout,
    replicas: dep.replicas,
    active_jobs: dep.active_jobs,
    confidential: dep.confidential,
    market_address: dep.market,
    created_at: dep.created_at,
    updated_at: dep.updated_at,
    dashboard_url: dashboardUrl(dep.id, network),
    endpoints,
    ready_urls: endpoints.filter((e) => e.service_ready).map((e) => e.url),
    recent_jobs: jobs.map((j) => ({ job: j.job, state: normalizeJobState(j.state), host: j.node ?? null, created_at: j.created_at, explorer_url: explorerJobUrl(j.job, network) })),
    recent_events: events.map((e) => ({ at: e.created_at, type: e.type, message: e.message })),
  };
}

export const tools: ToolDefinition[] = [
  tool(
    'get_balance',
    {
      title: 'Get credit balance',
      description: 'Credits on the Nosana account behind the API key: assigned, reserved by running deployments, settled (spent) and available. 1 credit is priced like 1 USD.',
      annotations: READ_ONLY,
    },
    {},
    async (ctx) => {
      const b = summarizeBalance(await ctx.get().api.credits.balance());
      return `${round(b.available)} credits available.\n${json({ assigned: round(b.assigned), reserved: round(b.reserved), settled: round(b.settled), available: round(b.available), top_up_url: 'https://deploy.nosana.com' })}`;
    },
  ),

  tool(
    'list_templates',
    {
      title: 'List templates',
      description: 'Ready-to-run Nosana templates (MiniMax H3 video, Qwen and Gemma models via Ollama, ComfyUI, Jupyter, VS Code, Whisper, ...). Templates with variants need a variant id when deploying.',
      annotations: READ_ONLY,
    },
    { search: z.string().optional().describe('Filter by id, name or category, e.g. "minimax" or "LLM".') },
    async (ctx, { search }) => {
      const all = await listTemplates(ctx.get());
      let top = topLevelTemplates(all);
      if (search) {
        const q = search.toLowerCase();
        top = top.filter((t) => t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.category.join(' ').toLowerCase().includes(q));
      }
      return `${top.length} templates.\n${json(top.map((t) => templateView(t, all)))}`;
    },
  ),

  tool(
    'get_template',
    {
      title: 'Get template details',
      description: 'Details of one template or variant: VRAM needed, hardware notes (e.g. MiniMax H3 needs a Blackwell GPU), whether it exposes a web endpoint, variants, and optionally the job definition it deploys.',
      annotations: READ_ONLY,
    },
    {
      template: z.string().describe('Template id or name, e.g. "minimax-h3".'),
      variant: z.string().optional().describe('Variant id, e.g. "i2v-32gb".'),
      include_job_definition: z.boolean().default(false),
      include_readme: z.boolean().default(false),
    },
    async (ctx, { template, variant, include_job_definition, include_readme }) => {
      const all = await listTemplates(ctx.get());
      let resolved: ResolvedTemplate | null = null;
      let needsVariant: string | null = null;
      try {
        resolved = resolveTemplate(all, template, variant);
      } catch (error) {
        if (!(error instanceof Error) || !error.name.includes('NeedsVariant')) throw error;
        needsVariant = error.message;
      }
      const parent = resolved?.parent ?? topLevelTemplates(all).find((t) => t.id === template || t.name.toLowerCase() === template.toLowerCase());
      if (!parent) throw new Error(`Unknown template "${template}". Call list_templates.`);
      const target = resolved?.template ?? parent;
      const hints = hardwareHints(parent);
      const view: Record<string, unknown> = {
        ...templateView(parent, all),
        selected_variant: resolved?.variant?.id ?? null,
        vram_gb: target.vramRequirementGb,
        exposes_port: target.jobDefinition ? exposesPorts(target.jobDefinition) : undefined,
        hardware_notes: hints.notes,
        blackwell_only: hints.blackwellOnly,
        recommended_gpus: hints.blackwellOnly ? ['nvidia-5090', 'nvidia-pro6000'] : undefined,
        minimum_timeout_minutes: MIN_TIMEOUT_MINUTES,
      };
      if (needsVariant) view.note = needsVariant;
      if (include_job_definition && resolved) view.job_definition = prepareJobDefinition(resolved.jobDefinition, 'mcp');
      if (include_readme) view.readme = parent.readme;
      return json(view);
    },
  ),

  tool(
    'list_gpus',
    {
      title: 'List GPU markets',
      description: 'GPU markets with price per hour (network fee included, matches deploy.nosana.com), idle hosts available right now, VRAM, and, when a template is given, whether each GPU fits it.',
      annotations: READ_ONLY,
    },
    {
      template: z.string().optional().describe('Mark which GPUs fit this template.'),
      variant: z.string().optional(),
      min_vram_gb: z.number().optional().describe('Mark which GPUs have at least this much VRAM.'),
      include_community: z.boolean().default(false).describe('Include community and special markets.'),
      include_queue: z.boolean().default(false).describe('Also read on-chain queues to report jobs waiting per market (slower).'),
    },
    async (ctx, { template, variant, min_vram_gb, include_community, include_queue }) => {
      const client = ctx.get();
      const fit: GpuTableOptions = { minVramGb: min_vram_gb ?? null };
      if (template) {
        const resolved = resolveTemplate(await listTemplates(client), template, variant);
        fit.minVramGb = fit.minVramGb ?? resolved.template.vramRequirementGb;
        if (hardwareHints(resolved.parent).blackwellOnly) fit.recommend = (m) => isBlackwell(m.name, m.slug);
      }
      const catalog = await loadGpuCatalog(client, { includeAll: include_community, onchain: include_queue });
      const rows = catalog.map((m) => gpuView(m, fit));
      const fitting = rows.filter((r) => r.fit === undefined || r.fit === 'fits');
      return `${rows.length} markets${template ? `, ${fitting.length} fit ${template}` : ''}. Sorted by price.\n${json(rows)}`;
    },
  ),

  tool(
    'estimate_deployment',
    {
      title: 'Estimate a deployment',
      description: 'Dry run: resolve the template/variant and GPU, validate the plan, and return the cost in credits for one timeout window plus warnings (too little VRAM, non-Blackwell card, insufficient credits, no idle hosts). Nothing is created. Call this before create_deployment and show the user the cost.',
      annotations: READ_ONLY,
    },
    planShape,
    async (ctx, input) => {
      const prepared = await preparePlan(ctx, input);
      const view = planView(prepared);
      return `${view.ok_to_deploy ? 'Plan is deployable.' : 'Plan has blocking warnings.'} Estimated ${String(view.estimated_cost_credits)} credits for one ${input.timeout_minutes}-minute window.\n${json(view)}`;
    },
  ),

  tool(
    'create_deployment',
    {
      title: 'Create (and start) a deployment',
      description:
        'SPENDS CREDITS. Creates a Nosana deployment from a template or job definition on the chosen GPU and starts it. Requires confirm=true, which you must only pass after the user has seen the estimate from estimate_deployment and agreed. Returns the deployment id; then poll wait_for_deployment until the endpoint is ready or the job completes.',
      annotations: SPENDS,
    },
    {
      ...planShape,
      name: z.string().optional().describe('Deployment name (default: <template>-<timestamp>).'),
      confidential: z.boolean().default(false).describe('Hide the job on the explorer and protect the endpoint with an auth header.'),
      start: z.boolean().default(true).describe('Start immediately (false leaves a DRAFT; note drafts cannot be deleted until started once).'),
      confirm: z.boolean().default(false).describe('Must be true. Confirms the user approved the estimated cost.'),
      force: z.boolean().default(false).describe('Deploy despite blocking warnings (too little VRAM, non-Blackwell GPU, insufficient credits).'),
    },
    async (ctx, input) => {
      const prepared = await preparePlan(ctx, input, input.name, input.confidential);
      const view = planView(prepared);
      if (input.confirm !== true) {
        return `NOT CREATED. Show this estimate to the user and call again with confirm=true once they agree.\n${json(view)}`;
      }
      if (prepared.assessment.blocking.length && !input.force) {
        return `NOT CREATED because of blocking warnings: ${prepared.assessment.blocking.join(' ')} Pass force=true only if the user explicitly accepts this.\n${json(view)}`;
      }
      const dep = await createDeployment(ctx.get(), prepared.plan);
      if (input.start) await dep.start();
      const exposes = exposesPorts(prepared.plan.jobDefinition);
      return `${input.start ? 'Created and started' : 'Created as DRAFT'} deployment ${dep.id}.\n${json({
        deployment_id: dep.id,
        name: dep.name,
        status: input.start ? 'STARTING' : dep.status,
        dashboard_url: dashboardUrl(dep.id, ctx.network),
        estimated_cost_credits: view.estimated_cost_credits,
        timeout_minutes: prepared.plan.timeoutMinutes,
        warnings: prepared.assessment.warnings,
        next_step: input.start
          ? exposes
            ? 'Call wait_for_deployment repeatedly (max_seconds up to 120) until outcome is "online", then give the user the ready URL. Big templates can take many minutes to download weights.'
            : 'Call wait_for_deployment repeatedly until outcome is "completed", then get_job_result for the logs.'
          : `Start it later with start_deployment.`,
        stop_hint: `Stop billing any time with stop_deployment (${dep.id}).`,
      })}`;
    },
  ),

  tool(
    'wait_for_deployment',
    {
      title: 'Wait for a deployment',
      description:
        'Blocks up to max_seconds (default 60, max 120) watching a deployment. Returns outcome "online" (service answers; includes ready URLs), "completed" (job finished; includes logs), "failed" (with the scheduler error), or "pending" (call again). Safe to call repeatedly.',
      annotations: READ_ONLY,
    },
    {
      deployment_id: z.string(),
      max_seconds: z.number().int().min(5).max(120).default(60),
    },
    async (ctx, { deployment_id, max_seconds }) => {
      const client = ctx.get();
      const lines: string[] = [];
      const outcome = await waitForDeployment(client, deployment_id, {
        timeoutMinutes: max_seconds / 60,
        intervalSeconds: 5,
        network: ctx.network,
        onLog: (line) => lines.push(stripAnsi(line)),
      });
      const dep = outcome.deployment;
      const base = { deployment_id, status: dep.status, dashboard_url: dashboardUrl(dep.id, ctx.network), progress: lines };
      switch (outcome.kind) {
        case 'online':
          return `ONLINE. The service answers at ${outcome.readyUrls.join(', ')}.\n${json({ outcome: 'online', ready_urls: outcome.readyUrls, ...base, stop_hint: `stop_deployment when the user is done to stop billing.` })}`;
        case 'completed': {
          let result: unknown = null;
          try {
            result = (await dep.getJob(outcome.job)).jobResult;
          } catch {
            /* results may lag */
          }
          return `COMPLETED job ${outcome.job}.\n${json({ outcome: 'completed', job: outcome.job, explorer_url: explorerJobUrl(outcome.job, ctx.network), logs: formatJobResult(result).map(stripAnsi), ...base })}`;
        }
        case 'failed':
          return `FAILED: ${outcome.error ?? outcome.reason}.\n${json({ outcome: 'failed', reason: outcome.reason, error: outcome.error ?? null, ...base, hint: outcome.error ? `The scheduler cannot run this deployment; call stop_deployment (${dep.id}) so it stops retrying.` : 'See get_deployment_events for details.' })}`;
        default:
          return `PENDING after ${max_seconds}s (status ${dep.status}). Call wait_for_deployment again.\n${json({ outcome: 'pending', ...base })}`;
      }
    },
  ),

  tool(
    'get_deployment',
    {
      title: 'Get deployment',
      description: 'Current status of a deployment with endpoints (tunnel online and whether the service actually answers), recent jobs and recent events.',
      annotations: READ_ONLY,
    },
    { deployment_id: z.string() },
    async (ctx, { deployment_id }) => {
      const client = ctx.get();
      const dep = (await client.api.deployments.get(deployment_id)) as ApiDeployment;
      return json(await deploymentView(client, dep, ctx.network));
    },
  ),

  tool(
    'list_deployments',
    {
      title: 'List deployments',
      description: 'Deployments on this account (newest first) with status, strategy, active jobs and timeout.',
      annotations: READ_ONLY,
    },
    {
      limit: z.number().int().min(1).max(100).default(20),
      status: z.string().optional().describe('Filter, e.g. "RUNNING" or "STOPPED,ERROR".'),
      search: z.string().optional().describe('Partial id or name.'),
    },
    async (ctx, { limit, status, search }) => {
      const result = await ctx.get().api.deployments.list({
        limit: pageSize(limit),
        ...(status ? { status: status.toUpperCase() } : {}),
        ...(search ? { search } : {}),
      });
      const deployments = (result.deployments as ApiDeployment[]).slice(0, limit).map((d) => ({
        deployment_id: d.id,
        name: d.name,
        status: d.status,
        strategy: d.strategy,
        active_jobs: d.active_jobs,
        timeout_minutes: d.timeout,
        updated_at: d.updated_at,
        dashboard_url: dashboardUrl(d.id, ctx.network),
      }));
      return `${deployments.length} of ${result.total_items} deployments.\n${json(deployments)}`;
    },
  ),

  tool(
    'stop_deployment',
    {
      title: 'Stop deployment',
      description: 'Stops a deployment and its running jobs. Billing stops with them. Use when the user is done or when a deployment can never schedule.',
      annotations: DESTRUCTIVE,
    },
    { deployment_id: z.string() },
    async (ctx, { deployment_id }) => {
      const client = ctx.get();
      const dep = (await client.api.deployments.get(deployment_id)) as ApiDeployment;
      await dep.stop();
      const after = (await client.api.deployments.get(deployment_id)) as ApiDeployment;
      return `Stop requested; status is now ${after.status}.\n${json({ deployment_id, status: after.status })}`;
    },
  ),

  tool(
    'start_deployment',
    {
      title: 'Start deployment',
      description: 'SPENDS CREDITS. Starts a DRAFT or STOPPED deployment again with its existing settings. Requires confirm=true after the user agreed.',
      annotations: SPENDS,
    },
    { deployment_id: z.string(), confirm: z.boolean().default(false) },
    async (ctx, { deployment_id, confirm }) => {
      const client = ctx.get();
      const dep = (await client.api.deployments.get(deployment_id)) as ApiDeployment;
      if (!confirm) {
        return `NOT STARTED. ${dep.name} would run on market ${dep.market} for ${dep.timeout} minutes per job (${dep.replicas} replica). Call again with confirm=true once the user agrees.`;
      }
      await dep.start();
      return `Started ${deployment_id}. Poll wait_for_deployment next.\n${json({ deployment_id, status: 'STARTING', dashboard_url: dashboardUrl(deployment_id, ctx.network) })}`;
    },
  ),

  tool(
    'extend_deployment',
    {
      title: 'Change deployment timeout',
      description: 'Sets a new timeout in minutes for a deployment (minimum 60). Longer timeouts reserve more credits.',
      annotations: SPENDS,
    },
    { deployment_id: z.string(), timeout_minutes: z.number().int().min(MIN_TIMEOUT_MINUTES) },
    async (ctx, { deployment_id, timeout_minutes }) => {
      const dep = (await ctx.get().api.deployments.get(deployment_id)) as ApiDeployment;
      await dep.updateTimeout(timeout_minutes);
      return `Timeout of ${deployment_id} set to ${timeout_minutes} minutes.`;
    },
  ),

  tool(
    'get_job_result',
    {
      title: 'Get job result and logs',
      description: 'Logs and results of a deployment job (latest job by default).',
      annotations: READ_ONLY,
    },
    { deployment_id: z.string(), job: z.string().optional().describe('Job address; defaults to the latest job.') },
    async (ctx, { deployment_id, job }) => {
      const dep = (await ctx.get().api.deployments.get(deployment_id)) as ApiDeployment;
      let address = job;
      if (!address) {
        const jobs = (await dep.getJobs({ limit: 10 })).jobs as { job: string }[];
        if (!jobs.length) return 'This deployment has not run any job yet.';
        address = jobs[0].job;
      }
      const detail = await dep.getJob(address);
      return json({
        job: address,
        state: normalizeJobState(detail.state),
        host: detail.node,
        explorer_url: explorerJobUrl(address, ctx.network),
        logs: formatJobResult(detail.jobResult).map(stripAnsi),
      });
    },
  ),

  tool(
    'get_deployment_events',
    {
      title: 'Get deployment events',
      description: 'Scheduler event log for a deployment (job listed, stopped, errors such as insufficient funds or bad timeout). Newest first.',
      annotations: READ_ONLY,
    },
    { deployment_id: z.string(), limit: z.number().int().min(1).max(100).default(20) },
    async (ctx, { deployment_id, limit }) => {
      const dep = (await ctx.get().api.deployments.get(deployment_id)) as ApiDeployment;
      const result = await dep.getEvents({ limit: pageSize(limit), sort_order: 'desc' });
      const events = (result.events as { type?: string; message?: string; created_at?: string; category?: string }[]).slice(0, limit);
      return json(events.map((e) => ({ at: e.created_at, type: e.type, category: e.category, message: e.message })));
    },
  ),
];

export async function templatesResource(ctx: ToolContext): Promise<string> {
  const all = await listTemplates(ctx.get());
  return json(topLevelTemplates(all).map((t) => templateView(t, all)));
}

export async function gpusResource(ctx: ToolContext): Promise<string> {
  const catalog = await loadGpuCatalog(ctx.get());
  return json(catalog.map((m) => gpuView(m)));
}

export function minimaxPromptText(variant?: string, gpu?: string): string {
  return [
    'Deploy MiniMax H3 (video generation with native audio, ComfyUI) on Nosana for me.',
    '',
    'Steps:',
    '1. Call get_balance and tell me how many credits I have.',
    `2. Call get_template with template "minimax-h3"${variant ? ` and variant "${variant}"` : ' and help me pick a variant (i2v-32gb is the usual choice)'}.`,
    `3. Call list_gpus for that template and pick ${gpu ? `"${gpu}"` : 'the cheapest GPU that fits and has idle hosts (usually nvidia-5090)'}.`,
    '4. Call estimate_deployment with timeout_minutes 120 and show me the cost before doing anything else.',
    '5. Only after I say yes, call create_deployment with confirm=true.',
    '6. Poll wait_for_deployment until the outcome is "online", then give me the ready URL. That URL is ComfyUI with the MiniMax H3 weights already in place.',
    '7. Remind me that stop_deployment ends the billing.',
  ].join('\n');
}
