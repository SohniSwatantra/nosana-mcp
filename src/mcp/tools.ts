import { validateJobDefinition, type JobDefinition, type NosanaClient } from '@nosana/kit';
import { z } from 'zod';
import { CliError, createClient, type ApiDeployment } from '../core/client.js';
import { maskKey, resolveApiKey, type Network } from '../core/config.js';
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
  PHASE_HINTS,
  snapshotDeployment,
  validatePlan,
  waitForDeployment,
  type DeployPlan,
  type DeploymentSnapshot,
  type PlanAssessment,
} from '../core/deploy.js';
import { formatError, pageSize, stripAnsi, withRetry } from '../core/format.js';
import { autoPickGpu, bucketGpus, loadGpuCatalog, resolveGpu, type BucketedGpu, type GpuBuckets, type GpuFitRequirements, type GpuMarket, type GpuTableOptions } from '../core/markets.js';
import {
  exposedPorts,
  exposesPorts,
  hardwareHints,
  isBlackwell,
  kindOfDefinition,
  listTemplates,
  llmFlavor,
  NeedsVariantError,
  prepareJobDefinition,
  primaryOpId,
  resolveTemplate,
  topLevelTemplates,
  typicalBootMinutes,
  vramFromDefinition,
  type ResolvedTemplate,
  type TemplateInfo,
  type WorkloadKind,
} from '../core/templates.js';

export const WAIT_DEFAULT_SECONDS = 30;
/** MCP clients time out requests after 60 s by default; stay well under it. */
export const WAIT_MAX_SECONDS = 45;

export const NO_KEY_MESSAGE =
  'No Nosana API key. Add NOSANA_API_KEY to the MCP server environment (create one at https://deploy.nosana.com under Account > API Keys), or run `nosana-deploy login` once on this machine.';

/** Every tool returns this envelope as JSON text and as structuredContent. */
export interface Envelope {
  ok: boolean;
  message: string;
  next_tool?: string | null;
  next_args?: Record<string, unknown>;
  [key: string]: unknown;
}

export class ToolContext {
  private client?: NosanaClient;
  private templatesCache?: { at: number; value: Promise<TemplateInfo[]> };
  private catalogCache = new Map<string, { at: number; value: Promise<GpuMarket[]> }>();

  constructor(readonly network: Network) {}

  hasKey(): boolean {
    return Boolean(resolveApiKey());
  }

  get(): NosanaClient {
    if (!this.client) {
      const key = resolveApiKey();
      if (!key) throw new CliError(NO_KEY_MESSAGE, 2);
      this.client = createClient({ network: this.network }, key.key, 'none');
    }
    return this.client;
  }

  templates(): Promise<TemplateInfo[]> {
    const ttl = 10 * 60_000;
    if (!this.templatesCache || Date.now() - this.templatesCache.at > ttl) {
      const value = listTemplates(this.get());
      this.templatesCache = { at: Date.now(), value };
      value.catch(() => (this.templatesCache = undefined));
    }
    return this.templatesCache.value;
  }

  catalog(includeAll = false, onchain = false): Promise<GpuMarket[]> {
    const key = `${includeAll}:${onchain}`;
    const ttl = 45_000;
    const hit = this.catalogCache.get(key);
    if (!hit || Date.now() - hit.at > ttl) {
      const value = loadGpuCatalog(this.get(), { includeAll, onchain });
      this.catalogCache.set(key, { at: Date.now(), value });
      value.catch(() => this.catalogCache.delete(key));
      return value;
    }
    return hit.value;
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
  run: (ctx: ToolContext, args: unknown) => Promise<Envelope>;
}

function tool<S extends z.ZodRawShape>(
  name: string,
  meta: { title: string; description: string; annotations: ToolAnnotations },
  shape: S,
  run: (ctx: ToolContext, args: z.infer<z.ZodObject<S>>) => Promise<Envelope>,
): ToolDefinition {
  return { name, shape, ...meta, run: (ctx, args) => run(ctx, z.object(shape).parse(args ?? {}) as z.infer<z.ZodObject<S>>) };
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const SPENDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

const round = (n: number): number => Math.round(n * 1000) / 1000;
const BILLING_NOTES = {
  idle_burns_credits: true,
  no_pause: 'There is no pause. stop_deployment ends billing; start_deployment starts a new job and pays the boot time again.',
  minimum_timeout_minutes: MIN_TIMEOUT_MINUTES,
};

// ---------------------------------------------------------------------------
// Views

function gpuView(m: GpuMarket, risks: string[] = []): Record<string, unknown> {
  const view: Record<string, unknown> = {
    gpu: m.slug,
    name: m.name,
    vram_gb: m.vramGb,
    usd_per_hour: round(m.pricePerHour),
    idle_hosts: m.availableNodes,
  };
  if (m.queuedJobs !== null) view.jobs_waiting = m.queuedJobs;
  if (risks.length) view.risks = risks;
  return view;
}

const bucketList = (items: BucketedGpu[]): Record<string, unknown>[] => items.map((b) => gpuView(b.market, b.risks));

function bucketsView(buckets: GpuBuckets, verbose = false): Record<string, unknown> {
  const view: Record<string, unknown> = {
    ready_now: bucketList(buckets.ready_now),
    fits_but_queued: bucketList(buckets.fits_but_queued),
    idle_with_risk: bucketList(buckets.idle_with_risk),
    unsupported: buckets.unsupported.map((b) => ({ gpu: b.market.slug, name: b.market.name, idle_hosts: b.market.availableNodes, reason: b.risks[0] })),
    too_small_count: buckets.too_small.length,
  };
  if (verbose) view.too_small = bucketList(buckets.too_small);
  return view;
}

function templateView(t: TemplateInfo, all: TemplateInfo[]): Record<string, unknown> {
  const variants = t.variants.map((v) => {
    const vt = all.find((x) => x.id === `${t.id}-${v.id}`);
    return { id: v.id, name: v.name, description: v.description, vram_gb: vt?.vramRequirementGb ?? null };
  });
  const vrams = variants.map((v) => v.vram_gb).filter((n): n is number => n !== null);
  const definition = t.jobDefinition ?? all.find((x) => x.id === `${t.id}-${t.variants[0]?.id}`)?.jobDefinition ?? null;
  return {
    id: t.id,
    name: t.name,
    kind: definition ? kindOfDefinition(definition, t.category) : 'custom',
    category: t.category.filter((c) => c !== 'Official'),
    vram_gb: t.vramRequirementGb ?? (vrams.length ? Math.min(...vrams) : null),
    needs_variant: variants.length > 0,
    variants,
    exposes_port: definition ? exposesPorts(definition) : undefined,
  };
}

interface WorkloadFacts {
  kind: WorkloadKind;
  minVramGb: number | null;
  blackwellOnly: boolean;
  hardwareNotes: string[];
  bootMinutes: number;
  exposes: boolean;
  opId: string | null;
}

function workloadFacts(resolved: ResolvedTemplate | null, definition: JobDefinition): WorkloadFacts {
  const hints = resolved ? hardwareHints(resolved.parent) : { blackwellOnly: false, minDriver: null, notes: [] as string[] };
  const kind = kindOfDefinition(definition, resolved?.parent.category ?? []);
  return {
    kind,
    minVramGb: resolved ? resolved.template.vramRequirementGb : vramFromDefinition(definition),
    blackwellOnly: hints.blackwellOnly,
    hardwareNotes: hints.notes,
    bootMinutes: typicalBootMinutes(definition, kind),
    exposes: exposesPorts(definition),
    opId: primaryOpId(definition),
  };
}

const fitRequirements = (facts: WorkloadFacts): GpuFitRequirements => ({
  minVramGb: facts.minVramGb,
  blackwellOnly: facts.blackwellOnly,
  isBlackwell: (m) => isBlackwell(m.name, m.slug),
});

const fitOptions = (facts: WorkloadFacts): GpuTableOptions => ({
  minVramGb: facts.minVramGb,
  recommend: facts.blackwellOnly ? (m) => isBlackwell(m.name, m.slug) : undefined,
});

// ---------------------------------------------------------------------------
// Workload resolution

interface WorkloadLookup {
  resolved?: ResolvedTemplate;
  needsVariant?: TemplateInfo;
  candidates?: TemplateInfo[];
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

function lookupWorkload(all: TemplateInfo[], workload: string, variant?: string): WorkloadLookup {
  let templateQuery = workload.trim();
  let variantQuery = variant;
  if (!variantQuery && templateQuery.includes('/')) {
    const [t, v] = templateQuery.split('/', 2);
    templateQuery = t.trim();
    variantQuery = v.trim();
  }
  try {
    return { resolved: resolveTemplate(all, templateQuery, variantQuery) };
  } catch (error) {
    if (error instanceof NeedsVariantError) return { needsVariant: error.template };
    if (!(error instanceof CliError) || !error.message.startsWith('Unknown template')) throw error;
  }
  // Fuzzy: every token must appear in the id or name, e.g. "qwen 27b" -> qwen3-5-27b, qwen3-6-27b.
  const tokens = workload.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean).map(squash).filter(Boolean);
  const matches = all.filter((t) => {
    const hay = squash(`${t.id} ${t.name}`);
    return tokens.every((tok) => hay.includes(tok));
  });
  const deployable = matches.filter((t) => t.jobDefinition);
  if (deployable.length === 1) return { resolved: resolveTemplate(all, deployable[0].id) };
  const parents = matches.filter((t) => !t.isVariant);
  if (deployable.length === 0 && parents.length === 1) return { needsVariant: parents[0] };
  return { candidates: (deployable.length ? deployable : matches).slice(0, 8) };
}

// ---------------------------------------------------------------------------
// Plans

const planShape = {
  template: z.string().optional().describe('Template id or name, e.g. "minimax-h3" or "minimax-h3/i2v-32gb" (see list_templates or recommend_plan). Omit when passing job_definition.'),
  variant: z.string().optional().describe('Variant id, e.g. "i2v-32gb". Required when the template has variants.'),
  job_definition: z.record(z.string(), z.unknown()).optional().describe('A custom Nosana job definition object instead of a template.'),
  gpu: z.string().default('auto').describe('GPU market slug, short name or address ("nvidia-5090", "5090"), or "auto" for the cheapest GPU that fits and has an idle host right now.'),
  timeout_minutes: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MINUTES)
    .optional()
    .describe(`Minutes the GPU is reserved per job. Minimum ${MIN_TIMEOUT_MINUTES}. Default: 120 for workloads that download weights, else 60.`),
  replicas: z.number().int().min(1).default(1).describe('Parallel jobs.'),
  strategy: z
    .enum(['SIMPLE', 'SIMPLE-EXTEND', 'SCHEDULED', 'INFINITE'])
    .default('SIMPLE')
    .describe('SIMPLE runs once and stops at the timeout (predictable cost). SIMPLE-EXTEND keeps extending while credits last. SCHEDULED needs schedule. INFINITE keeps a replacement job ready.'),
  schedule: z.string().optional().describe('Cron expression (5 fields). SCHEDULED strategy only.'),
  include_community_gpus: z.boolean().default(false).describe('Allow community GPU markets, not only the premium ones the dashboard shows.'),
};

type PlanInput = z.infer<z.ZodObject<typeof planShape>>;

class NoReadyGpuError extends Error {
  constructor(
    readonly buckets: GpuBuckets,
    readonly facts: WorkloadFacts,
    readonly resolved: ResolvedTemplate | null,
  ) {
    super('No GPU that fits this workload has an idle host right now.');
    this.name = 'NoReadyGpuError';
  }
}

interface PreparedPlan {
  plan: DeployPlan;
  resolved: ResolvedTemplate | null;
  facts: WorkloadFacts;
  buckets: GpuBuckets;
  assessment: PlanAssessment;
  creditsAvailable: number;
  autoPicked: boolean;
}

async function resolveWorkloadForPlan(ctx: ToolContext, input: PlanInput): Promise<{ resolved: ResolvedTemplate | null; definition: JobDefinition; label: string }> {
  if (!input.template && !input.job_definition) throw new CliError('Pass template (plus variant when needed) or job_definition.', 2);
  if (input.template && input.job_definition) throw new CliError('Pass either template or job_definition, not both.', 2);
  if (input.template) {
    const lookup = lookupWorkload(await ctx.templates(), input.template, input.variant);
    if (lookup.resolved) return { resolved: lookup.resolved, definition: prepareJobDefinition(lookup.resolved.jobDefinition, 'mcp'), label: lookup.resolved.id };
    if (lookup.needsVariant) throw new NeedsVariantError(lookup.needsVariant);
    throw new CliError(`Ambiguous or unknown workload "${input.template}". Candidates: ${(lookup.candidates ?? []).map((c) => c.id).join(', ') || 'none'}. Use list_templates or recommend_plan.`, 2);
  }
  const validation = validateJobDefinition(input.job_definition);
  if (!validation.success) throw new CliError(`Invalid job definition: ${JSON.stringify(validation.errors)}`, 2);
  return { resolved: null, definition: prepareJobDefinition(input.job_definition as unknown as JobDefinition, 'mcp'), label: 'custom-job' };
}

async function preparePlan(ctx: ToolContext, input: PlanInput, options: { name?: string; confidential?: boolean; requireIdle: boolean }): Promise<PreparedPlan> {
  const client = ctx.get();
  const [{ resolved, definition, label }, balance, catalog] = await Promise.all([
    resolveWorkloadForPlan(ctx, input),
    withRetry(() => client.api.credits.balance()),
    ctx.catalog(input.include_community_gpus),
  ]);
  const facts = workloadFacts(resolved, definition);
  const buckets = bucketGpus(catalog, fitRequirements(facts));

  let gpu: GpuMarket | undefined;
  let autoPicked = false;
  if (input.gpu.trim().toLowerCase() === 'auto') {
    gpu = autoPickGpu(buckets) ?? undefined;
    autoPicked = true;
    if (!gpu) throw new NoReadyGpuError(buckets, facts, resolved);
  } else {
    gpu = resolveGpu(catalog, input.gpu);
    if (!gpu) throw new CliError(`Unknown GPU "${input.gpu}". Use "auto" or a slug from list_gpus${input.include_community_gpus ? '' : ' (set include_community_gpus for community markets)'}.`, 2);
  }

  const timeoutMinutes = input.timeout_minutes ?? (facts.bootMinutes >= 10 ? 120 : MIN_TIMEOUT_MINUTES);
  const plan: DeployPlan = {
    name: options.name?.trim() || defaultDeploymentName(label),
    workload: label,
    jobDefinition: definition,
    gpu,
    timeoutMinutes,
    replicas: input.replicas,
    strategy: parseStrategy(input.strategy),
    schedule: input.schedule,
    confidential: Boolean(options.confidential),
  };
  validatePlan(plan);
  const creditsAvailable = availableCredits(balance);
  const assessment = assessPlan(plan, fitOptions(facts), creditsAvailable, { requireIdle: options.requireIdle });
  return { plan, resolved, facts, buckets, assessment, creditsAvailable, autoPicked };
}

function planView(prepared: PreparedPlan): Record<string, unknown> {
  const { plan, resolved, facts, assessment, creditsAvailable } = prepared;
  return {
    name: plan.name,
    workload: resolved
      ? { template: resolved.parent.id, variant: resolved.variant?.id ?? null, title: resolved.template.name, kind: facts.kind }
      : { custom_job_definition: true, kind: facts.kind },
    gpu: gpuView(plan.gpu),
    gpu_auto_selected: prepared.autoPicked,
    strategy: plan.strategy,
    replicas: plan.replicas,
    timeout_minutes: plan.timeoutMinutes,
    usd_per_hour: round(plan.gpu.pricePerHour * plan.replicas),
    estimated_credits: round(assessment.cost.total),
    boot_minutes_typical: facts.bootMinutes,
    credits_available: round(creditsAvailable),
    hardware_notes: facts.hardwareNotes,
    warnings: assessment.warnings,
    blocking: assessment.blocking,
    deployable: assessment.blocking.length === 0,
    billing: BILLING_NOTES,
  };
}

function noReadyEnvelope(error: NoReadyGpuError, timeoutMinutes: number | undefined, templateArgs: Record<string, unknown>): Envelope {
  const b = error.buckets;
  const queued = b.fits_but_queued[0]?.market;
  const risky = b.idle_with_risk[0]?.market;
  const options: string[] = [];
  if (queued) options.push(`wait for ${queued.name} (${queued.slug}, ${round(queued.pricePerHour)} USD/h, 0 idle): create_deployment with gpu="${queued.slug}" and accept_queue=true`);
  if (risky) options.push(`use idle ${risky.name} (${risky.slug}) despite "${b.idle_with_risk[0].risks.join('; ')}": create_deployment with gpu="${risky.slug}" and force=true`);
  return {
    ok: true,
    message: `No GPU that fits has an idle host right now. Ask the user which they prefer: ${options.join(' OR ') || 'try again later'}. ${b.unsupported.length ? `${b.unsupported.length} idle-or-not GPUs are unsupported for this workload and are not offered.` : ''}`.trim(),
    outcome: 'needs_decision',
    gpus: bucketsView(b),
    workload: { kind: error.facts.kind, vram_gb: error.facts.minVramGb, blackwell_only: error.facts.blackwellOnly, hardware_notes: error.facts.hardwareNotes, boot_minutes_typical: error.facts.bootMinutes },
    timeout_minutes: timeoutMinutes ?? (error.facts.bootMinutes >= 10 ? 120 : MIN_TIMEOUT_MINUTES),
    next_tool: 'create_deployment',
    next_args: { ...templateArgs, gpu: queued?.slug ?? risky?.slug ?? 'auto', accept_queue: Boolean(queued), confirm: false },
  };
}

async function runningSimilar(ctx: ToolContext, resolved: ResolvedTemplate | null, opId: string | null): Promise<{ deployment_id: string; name: string; status: string; dashboard_url: string }[]> {
  try {
    const result = await ctx.get().api.deployments.list({ limit: pageSize(50), status: 'RUNNING,STARTING' });
    const templateId = resolved?.parent.id;
    return (result.deployments as ApiDeployment[])
      .filter((d) => (templateId && d.name.toLowerCase().startsWith(templateId.toLowerCase())) || (opId && d.endpoints?.some((e) => e.opId === opId)))
      .map((d) => ({ deployment_id: d.id, name: d.name, status: d.status, dashboard_url: dashboardUrl(d.id, ctx.network) }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Endpoint usage

function endpointUsage(snapshot: DeploymentSnapshot): Record<string, unknown> {
  const { facts, endpoints } = snapshot;
  const primary = endpoints.find((e) => e.service_ready) ?? endpoints[0];
  const base = primary?.url?.replace(/\/$/, '') ?? '<endpoint-url>';
  const ready = Boolean(primary?.service_ready);
  const common = {
    kind: facts.kind,
    ready,
    endpoints: endpoints.map((e) => ({ url: e.url, op: e.op, port: e.port, tunnel_online: e.tunnel_online, service_ready: e.service_ready })),
    stop_hint: 'stop_deployment ends billing when the user is done.',
  };
  switch (facts.kind) {
    case 'comfyui':
      return {
        ...common,
        ui_url: base,
        api: {
          queue_prompt: `POST ${base}/prompt  body: {"prompt": <workflow in API format>, "client_id": "<any>"}`,
          history: `GET ${base}/history/<prompt_id>`,
          view_output: `GET ${base}/view?filename=<name>&subfolder=<sub>&type=output`,
          system_stats: `GET ${base}/system_stats`,
          object_info: `GET ${base}/object_info`,
        },
        notes: [
          'In the ComfyUI UI use Workflow > Export (API) to get the JSON shape the /prompt endpoint expects.',
          'Outputs stay on the host; download them via /view before stopping the deployment.',
          facts.opId?.toLowerCase().includes('minimax') ? 'MiniMax H3: build the local-weights graph from get_template include_readme=true; ComfyUI\'s bundled api_minimax_h3_* templates call MiniMax\'s cloud API instead.' : null,
        ].filter(Boolean),
      };
    case 'llm': {
      const flavor = facts.jobDefinition ? llmFlavor(facts.jobDefinition) : 'other';
      return {
        ...common,
        openai_base_url: `${base}/v1`,
        api_key: 'any non-empty string (the endpoint is public unless the deployment is confidential)',
        list_models: `GET ${base}/v1/models`,
        chat: `POST ${base}/v1/chat/completions  body: {"model": "<id from /v1/models>", "messages": [{"role": "user", "content": "..."}]}`,
        env: { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: 'nosana' },
        ...(flavor === 'ollama' ? { ollama_native: { tags: `GET ${base}/api/tags`, generate: `POST ${base}/api/generate`, chat: `POST ${base}/api/chat` } } : {}),
        notes: ['Model download happens on first start; /v1/models lists the model once it is loaded.', 'Any OpenAI-compatible SDK works by pointing its base URL at openai_base_url.'],
      };
    }
    case 'notebook':
      return { ...common, url: base, notes: ['Jupyter may ask for a token; get_job_result shows the startup log where the token is printed.'] };
    case 'ide':
      return { ...common, url: base, notes: ['Open the URL in a browser. Check get_job_result for a password if the image prints one.'] };
    default:
      return { ...common, urls: endpoints.map((e) => e.url), ports: facts.jobDefinition ? exposedPorts(facts.jobDefinition) : [], notes: ['Open the URL for the port the job exposes.'] };
  }
}

async function usdPerHourForMarket(ctx: ToolContext, market: string): Promise<number | null> {
  try {
    const catalog = await ctx.catalog(true);
    const found = catalog.find((m) => m.address === market);
    return found ? round(found.pricePerHour) : null;
  } catch {
    return null;
  }
}

async function snapshotView(ctx: ToolContext, snapshot: DeploymentSnapshot): Promise<Record<string, unknown>> {
  const dep = snapshot.deployment;
  const hint = PHASE_HINTS[snapshot.phase];
  const [usd, catalog] = await Promise.all([usdPerHourForMarket(ctx, dep.market), ctx.catalog(true).catch(() => [] as GpuMarket[])]);
  const market = catalog.find((m) => m.address === dep.market);
  const terminal = ['ready', 'completed', 'stopped', 'error', 'draft'].includes(snapshot.phase);
  return {
    deployment_id: dep.id,
    name: dep.name,
    status: dep.status,
    phase: snapshot.phase,
    phase_message: hint.message,
    kind: snapshot.facts.kind,
    gpu: market ? { gpu: market.slug, name: market.name, idle_hosts_on_market: market.availableNodes } : { market_address: dep.market },
    usd_per_hour: usd,
    timeout_minutes: dep.timeout,
    replicas: dep.replicas,
    active_jobs: dep.active_jobs,
    strategy: dep.strategy,
    confidential: dep.confidential,
    elapsed_seconds: snapshot.elapsedSeconds,
    boot_minutes_typical: snapshot.facts.bootMinutes,
    endpoints: snapshot.endpoints,
    ready_urls: snapshot.readyUrls,
    recent_jobs: snapshot.jobs.map((j) => ({ ...j, explorer_url: explorerJobUrl(j.job, ctx.network) })),
    recent_events: snapshot.events,
    dashboard_url: dashboardUrl(dep.id, ctx.network),
    billing: BILLING_NOTES,
    poll_after_seconds: hint.pollAfterSeconds,
    next_tool: terminal ? (snapshot.phase === 'ready' ? 'get_endpoint_usage' : null) : 'wait_for_deployment',
    next_args: terminal ? (snapshot.phase === 'ready' ? { deployment_id: dep.id } : undefined) : { deployment_id: dep.id, max_seconds: WAIT_DEFAULT_SECONDS },
  };
}

// ---------------------------------------------------------------------------
// Tools

export const tools: ToolDefinition[] = [
  tool(
    'doctor',
    {
      title: 'Check setup',
      description: 'Checks the API key, credits, and every Nosana API this server uses. Call it first when something fails; it returns the exact fix.',
      annotations: READ_ONLY,
    },
    {},
    async (ctx) => {
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      const key = resolveApiKey();
      checks.push({ name: 'api_key', ok: Boolean(key), detail: key ? `${maskKey(key.key)} from ${key.source}` : 'missing' });
      if (!key) {
        return {
          ok: false,
          message: 'No Nosana API key configured.',
          checks,
          fix: [
            'Create a key at https://deploy.nosana.com (Account > API Keys), then add it to the MCP server environment.',
            'Claude Code: claude mcp add nosana --env NOSANA_API_KEY=nos_... -- npx -y nosana-mcp',
            'JSON clients: {"mcpServers":{"nosana":{"command":"npx","args":["-y","nosana-mcp"],"env":{"NOSANA_API_KEY":"nos_..."}}}}',
            'Restart or reconnect the MCP client after changing the configuration.',
          ],
          next_tool: null,
        };
      }
      const client = ctx.get();
      const run = async (name: string, fn: () => Promise<string>): Promise<void> => {
        try {
          checks.push({ name, ok: true, detail: await fn() });
        } catch (error) {
          checks.push({ name, ok: false, detail: formatError(error) });
        }
      };
      await run('credits_api', async () => `${round(availableCredits(await client.api.credits.balance()))} credits available`);
      await run('markets_api', async () => `${((await client.api.markets.list()) as unknown[]).length} GPU markets`);
      await run('templates_api', async () => `${(await ctx.templates()).length} templates`);
      await run('host_availability', async () => `${((await client.api.hosts.getQueuedNodes()) as unknown as unknown[]).length} idle hosts network-wide`);
      await run('deployments_api', async () => `${(await client.api.deployments.list({ limit: 10 })).total_items} deployments on this account`);
      const failed = checks.filter((c) => !c.ok);
      return {
        ok: failed.length === 0,
        message: failed.length ? `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}.` : 'All checks passed.',
        checks,
        fix: failed.some((c) => c.name === 'credits_api') ? 'The key was rejected. Create a new key at https://deploy.nosana.com and update the MCP server environment.' : undefined,
        network: ctx.network,
        next_tool: failed.length ? null : 'recommend_plan',
      };
    },
  ),

  tool(
    'get_balance',
    {
      title: 'Get credit balance',
      description: 'Credits on the Nosana account behind the API key: assigned, reserved by running deployments, settled (spent) and available. 1 credit is priced like 1 USD.',
      annotations: READ_ONLY,
    },
    {},
    async (ctx) => {
      const b = summarizeBalance(await withRetry(() => ctx.get().api.credits.balance()));
      return {
        ok: true,
        message: `${round(b.available)} credits available.`,
        assigned: round(b.assigned),
        reserved: round(b.reserved),
        settled: round(b.settled),
        available: round(b.available),
        top_up_url: 'https://deploy.nosana.com',
        next_tool: null,
      };
    },
  ),

  tool(
    'list_templates',
    {
      title: 'List templates',
      description: 'Ready-to-run Nosana templates (MiniMax H3 video, Qwen and Gemma LLMs via Ollama, DeepSeek via vLLM, ComfyUI, Jupyter, VS Code, Whisper, ...) with kind, VRAM needs and variants. Templates with variants need a variant id when deploying.',
      annotations: READ_ONLY,
    },
    { search: z.string().optional().describe('Filter by id, name or category, e.g. "minimax", "qwen" or "LLM".') },
    async (ctx, { search }) => {
      const all = await ctx.templates();
      let top = topLevelTemplates(all);
      if (search) {
        const q = search.toLowerCase();
        top = top.filter((t) => t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.category.join(' ').toLowerCase().includes(q));
      }
      return { ok: true, message: `${top.length} templates.`, templates: top.map((t) => templateView(t, all)), next_tool: 'recommend_plan' };
    },
  ),

  tool(
    'get_template',
    {
      title: 'Get template details',
      description: 'Details of one template or variant: kind, VRAM needed, hardware notes (e.g. MiniMax H3 needs a Blackwell GPU), exposed ports, typical boot time, variants, and optionally the job definition and README.',
      annotations: READ_ONLY,
    },
    {
      template: z.string().describe('Template id or name, e.g. "minimax-h3" or "minimax-h3/i2v-32gb".'),
      variant: z.string().optional().describe('Variant id, e.g. "i2v-32gb".'),
      include_job_definition: z.boolean().default(false),
      include_readme: z.boolean().default(false),
    },
    async (ctx, { template, variant, include_job_definition, include_readme }) => {
      const all = await ctx.templates();
      const lookup = lookupWorkload(all, template, variant);
      if (lookup.candidates) {
        return { ok: false, message: `Ambiguous or unknown template "${template}".`, candidates: lookup.candidates.map((c) => ({ id: c.id, name: c.name })), next_tool: 'list_templates' };
      }
      const parent = lookup.resolved?.parent ?? lookup.needsVariant!;
      const target = lookup.resolved?.template ?? parent;
      const definition = lookup.resolved?.jobDefinition ?? null;
      const facts = definition ? workloadFacts(lookup.resolved ?? null, definition) : null;
      const hints = hardwareHints(parent);
      return {
        ok: true,
        message: lookup.resolved ? `${target.name}.` : `${parent.name} has ${parent.variants.length} variants; pick one.`,
        ...templateView(parent, all),
        selected_variant: lookup.resolved?.variant?.id ?? null,
        vram_gb: target.vramRequirementGb,
        exposes_port: facts?.exposes,
        ports: definition ? exposedPorts(definition) : undefined,
        boot_minutes_typical: facts?.bootMinutes,
        hardware_notes: hints.notes,
        blackwell_only: hints.blackwellOnly,
        recommended_gpus: hints.blackwellOnly ? ['nvidia-5090', 'nvidia-pro6000'] : undefined,
        minimum_timeout_minutes: MIN_TIMEOUT_MINUTES,
        job_definition: include_job_definition && lookup.resolved ? prepareJobDefinition(lookup.resolved.jobDefinition, 'mcp') : undefined,
        readme: include_readme ? parent.readme : undefined,
        next_tool: lookup.resolved ? 'recommend_plan' : 'get_template',
        next_args: lookup.resolved ? { workload: lookup.resolved.id } : { template: parent.id, variant: parent.variants[0]?.id },
      };
    },
  ),

  tool(
    'list_gpus',
    {
      title: 'List GPU markets',
      description:
        'GPU markets bucketed the way a buyer shops: ready_now (fits and idle host available), fits_but_queued (fits, nobody idle), idle_with_risk (idle but a caveat), unsupported (cannot run this workload). Prices per hour include the network fee and match deploy.nosana.com. Pass a template so the buckets reflect its VRAM and hardware needs.',
      annotations: READ_ONLY,
    },
    {
      template: z.string().optional().describe('Template id, optionally "id/variant", to bucket by its requirements.'),
      variant: z.string().optional(),
      min_vram_gb: z.number().optional().describe('Bucket by a VRAM requirement instead of a template.'),
      include_community: z.boolean().default(false).describe('Include community and special markets.'),
      include_queue: z.boolean().default(false).describe('Also read on-chain queues to report jobs waiting per market (slower).'),
      verbose: z.boolean().default(false).describe('Also return the full flat list and too-small GPUs.'),
    },
    async (ctx, { template, variant, min_vram_gb, include_community, include_queue, verbose }) => {
      let req: GpuFitRequirements = { minVramGb: min_vram_gb ?? null };
      let label = min_vram_gb ? `${min_vram_gb} GB VRAM` : 'any workload';
      if (template) {
        const lookup = lookupWorkload(await ctx.templates(), template, variant);
        if (!lookup.resolved) {
          return { ok: false, message: lookup.needsVariant ? `Template "${template}" needs a variant: ${lookup.needsVariant.variants.map((v) => v.id).join(', ')}.` : `Unknown template "${template}".`, next_tool: 'list_templates' };
        }
        const facts = workloadFacts(lookup.resolved, lookup.resolved.jobDefinition);
        req = { ...fitRequirements(facts), minVramGb: min_vram_gb ?? facts.minVramGb };
        label = lookup.resolved.id;
      }
      const catalog = await ctx.catalog(include_community, include_queue);
      const buckets = bucketGpus(catalog, req);
      return {
        ok: true,
        message: `${buckets.ready_now.length} GPU(s) ready now for ${label}, ${buckets.fits_but_queued.length} fit but have no idle host, ${buckets.idle_with_risk.length} idle with caveats, ${buckets.unsupported.length} unsupported.`,
        fit_for: label,
        ...bucketsView(buckets, verbose),
        all: verbose ? catalog.map((m) => gpuView(m)) : undefined,
        next_tool: 'recommend_plan',
      };
    },
  ),

  tool(
    'recommend_plan',
    {
      title: 'Recommend a deployment plan',
      description:
        'One call from a workload name to a ready-to-confirm plan. Accepts "minimax-h3", "minimax-h3/i2v-32gb", "qwen3-6-27b", "gemma3 27b", "comfyui/sdxl" or a job_definition. Returns the resolved template, GPUs in buckets, the cheapest GPU that is ready now with its cost, any similar deployment already running, and the exact create_deployment arguments. Never picks a queued or unsupported GPU on its own.',
      annotations: READ_ONLY,
    },
    {
      workload: z.string().optional().describe('Template id/name, optionally with "/variant", or a loose description like "qwen 27b".'),
      variant: z.string().optional(),
      job_definition: z.record(z.string(), z.unknown()).optional(),
      timeout_minutes: z.number().int().min(MIN_TIMEOUT_MINUTES).optional(),
      include_community_gpus: z.boolean().default(false),
    },
    async (ctx, { workload, variant, job_definition, timeout_minutes, include_community_gpus }) => {
      if (!workload && !job_definition) return { ok: false, message: 'Pass workload or job_definition.', next_tool: 'list_templates' };
      let resolved: ResolvedTemplate | null = null;
      let definition: JobDefinition;
      if (workload) {
        const lookup = lookupWorkload(await ctx.templates(), workload, variant);
        if (lookup.needsVariant) {
          const t = lookup.needsVariant;
          const all = await ctx.templates();
          return {
            ok: true,
            message: `${t.name} has ${t.variants.length} variants. Ask the user (or pick the smallest that fits their need) and call again with workload "${t.id}/<variant>".`,
            outcome: 'needs_variant',
            template: templateView(t, all),
            next_tool: 'recommend_plan',
            next_args: { workload: `${t.id}/${t.variants[0]?.id}` },
          };
        }
        if (lookup.candidates) {
          return {
            ok: true,
            message: lookup.candidates.length ? `"${workload}" matches several templates; ask the user which one.` : `Nothing matches "${workload}".`,
            outcome: 'needs_choice',
            candidates: lookup.candidates.map((c) => ({ id: c.id, name: c.name, vram_gb: c.vramRequirementGb })),
            next_tool: lookup.candidates.length ? 'recommend_plan' : 'list_templates',
          };
        }
        resolved = lookup.resolved!;
        definition = prepareJobDefinition(resolved.jobDefinition, 'mcp');
      } else {
        const validation = validateJobDefinition(job_definition);
        if (!validation.success) return { ok: false, message: `Invalid job definition: ${JSON.stringify(validation.errors)}`, next_tool: null };
        definition = prepareJobDefinition(job_definition as unknown as JobDefinition, 'mcp');
      }
      const facts = workloadFacts(resolved, definition);
      const [catalog, balance, running] = await Promise.all([ctx.catalog(include_community_gpus), withRetry(() => ctx.get().api.credits.balance()), runningSimilar(ctx, resolved, facts.opId)]);
      const buckets = bucketGpus(catalog, fitRequirements(facts));
      const pick = autoPickGpu(buckets);
      const timeout = timeout_minutes ?? (facts.bootMinutes >= 10 ? 120 : MIN_TIMEOUT_MINUTES);
      const credits = availableCredits(balance);
      const templateArgs = resolved ? { template: resolved.parent.id, variant: resolved.variant?.id ?? undefined } : { job_definition };
      const estimated = pick ? round(pick.pricePerHour * (timeout / 60)) : null;
      const affordable = estimated === null || estimated <= credits;
      return {
        ok: true,
        message: pick
          ? `Recommended: ${pick.name} (${pick.slug}) at ${round(pick.pricePerHour)} USD/h, ${pick.availableNodes} idle host(s). About ${estimated} credits for ${timeout} minutes; ${round(credits)} available.${affordable ? '' : ' NOT ENOUGH CREDITS.'}${running.length ? ` Note: ${running.length} similar deployment(s) already running.` : ''} Show this to the user, then call create_deployment with create_args and confirm=true.`
          : `Nothing that fits ${resolved?.id ?? 'this job'} has an idle host right now. Options: wait on a fits_but_queued GPU (accept_queue=true) or accept a caveat on an idle_with_risk GPU (force=true). Unsupported GPUs are excluded.`,
        outcome: pick ? 'ready' : 'needs_decision',
        workload: {
          template: resolved?.parent.id ?? null,
          variant: resolved?.variant?.id ?? null,
          title: resolved?.template.name ?? 'custom job definition',
          kind: facts.kind,
          vram_gb: facts.minVramGb,
          blackwell_only: facts.blackwellOnly,
          exposes_port: facts.exposes,
          boot_minutes_typical: facts.bootMinutes,
          hardware_notes: facts.hardwareNotes,
        },
        gpus: bucketsView(buckets),
        recommended: pick ? { ...gpuView(pick), timeout_minutes: timeout, estimated_credits: estimated, affordable } : null,
        credits_available: round(credits),
        running_similar: running,
        billing: BILLING_NOTES,
        create_args: pick ? { ...templateArgs, gpu: pick.slug, timeout_minutes: timeout, confirm: false } : null,
        next_tool: 'create_deployment',
        next_args: pick
          ? { ...templateArgs, gpu: pick.slug, timeout_minutes: timeout, confirm: false }
          : { ...templateArgs, gpu: buckets.fits_but_queued[0]?.market.slug ?? buckets.idle_with_risk[0]?.market.slug ?? 'auto', timeout_minutes: timeout, accept_queue: Boolean(buckets.fits_but_queued[0]), confirm: false },
      };
    },
  ),

  tool(
    'estimate_deployment',
    {
      title: 'Estimate a deployment',
      description: 'Dry run of create_deployment with the same arguments: resolves workload and GPU (including gpu="auto"), validates, and returns the cost for one timeout window plus blocking warnings. Nothing is created.',
      annotations: READ_ONLY,
    },
    { ...planShape, accept_queue: z.boolean().default(false).describe('Treat "no idle host" as acceptable.') },
    async (ctx, input) => {
      try {
        const prepared = await preparePlan(ctx, input, { requireIdle: !input.accept_queue });
        const view = planView(prepared);
        return {
          ok: true,
          message: view.deployable ? `Deployable: about ${String(view.estimated_credits)} credits for ${prepared.plan.timeoutMinutes} minutes on ${prepared.plan.gpu.name}.` : `Not deployable as-is: ${prepared.assessment.blocking.join(' ')}`,
          ...view,
          next_tool: 'create_deployment',
          next_args: { ...input, gpu: prepared.plan.gpu.slug, timeout_minutes: prepared.plan.timeoutMinutes, confirm: false },
        };
      } catch (error) {
        if (error instanceof NoReadyGpuError) return noReadyEnvelope(error, input.timeout_minutes, { template: input.template, variant: input.variant, job_definition: input.job_definition });
        throw error;
      }
    },
  ),

  tool(
    'create_deployment',
    {
      title: 'Create (and start) a deployment',
      description:
        'SPENDS CREDITS. Creates a Nosana deployment from a template or job definition on the chosen GPU (or gpu="auto" = cheapest fitting GPU with an idle host) and starts it. Requires confirm=true, which you must only pass after the user has seen the estimate and agreed. Refuses when no host is idle unless accept_queue=true, when a similar deployment is already running unless allow_duplicate=true, and on hardware or credit problems unless force=true. Then poll wait_for_deployment.',
      annotations: SPENDS,
    },
    {
      ...planShape,
      name: z.string().optional().describe('Deployment name (default: <template>-<timestamp>).'),
      confidential: z.boolean().default(false).describe('Hide the job on the explorer and protect the endpoint with an auth header.'),
      start: z.boolean().default(true).describe('Start immediately. false leaves a DRAFT (drafts cannot be deleted until started once).'),
      confirm: z.boolean().default(false).describe('Must be true. Confirms the user approved the estimated cost.'),
      accept_queue: z.boolean().default(false).describe('The user agrees to wait for a host when the GPU has none idle.'),
      allow_duplicate: z.boolean().default(false).describe('Create even though a similar deployment is already running.'),
      force: z.boolean().default(false).describe('Deploy despite blocking warnings (too little VRAM, unsupported GPU, insufficient credits). Unsupported hardware will most likely fail and still bill the boot time.'),
    },
    async (ctx, input) => {
      let prepared: PreparedPlan;
      try {
        prepared = await preparePlan(ctx, input, { name: input.name, confidential: input.confidential, requireIdle: !input.accept_queue });
      } catch (error) {
        if (error instanceof NoReadyGpuError) return noReadyEnvelope(error, input.timeout_minutes, { template: input.template, variant: input.variant, job_definition: input.job_definition });
        throw error;
      }
      const view = planView(prepared);
      const running = await runningSimilar(ctx, prepared.resolved, prepared.facts.opId);
      const blocking = [...prepared.assessment.blocking];
      if (running.length && !input.allow_duplicate) {
        blocking.push(`A similar deployment is already running (${running.map((r) => `${r.name} ${r.deployment_id}`).join(', ')}). Reuse it, stop it, or pass allow_duplicate=true.`);
      }
      const base = { ...view, running_similar: running, blocking };
      if (input.confirm !== true) {
        return { ok: true, outcome: 'not_created', message: 'NOT CREATED: confirm is false. Show the estimate to the user; call again with confirm=true once they agree.', ...base, next_tool: 'create_deployment', next_args: { ...input, gpu: prepared.plan.gpu.slug, timeout_minutes: prepared.plan.timeoutMinutes, confirm: true } };
      }
      const onlyQueue = blocking.length > 0 && blocking.every((b) => b.startsWith('No idle'));
      const onlyDuplicate = blocking.length > 0 && blocking.every((b) => b.startsWith('A similar deployment'));
      if (blocking.length && !input.force && !(onlyQueue && input.accept_queue) && !(onlyDuplicate && input.allow_duplicate)) {
        return { ok: true, outcome: 'not_created', message: `NOT CREATED: ${blocking.join(' ')}`, ...base, next_tool: 'create_deployment', next_args: { ...input, gpu: prepared.plan.gpu.slug } };
      }
      const dep = await createDeployment(ctx.get(), prepared.plan);
      if (input.start) await dep.start();
      return {
        ok: true,
        outcome: input.start ? 'started' : 'draft',
        message: `${input.start ? 'Created and started' : 'Created as draft'} ${dep.id} on ${prepared.plan.gpu.name}. ${input.start ? `Poll wait_for_deployment until outcome is ${prepared.facts.exposes ? '"online"' : '"completed"'}; typical boot ${prepared.facts.bootMinutes} min.` : 'Start it with start_deployment.'}`,
        deployment_id: dep.id,
        name: dep.name,
        status: input.start ? 'STARTING' : dep.status,
        kind: prepared.facts.kind,
        gpu: gpuView(prepared.plan.gpu),
        usd_per_hour: view.usd_per_hour,
        estimated_credits: view.estimated_credits,
        timeout_minutes: prepared.plan.timeoutMinutes,
        boot_minutes_typical: prepared.facts.bootMinutes,
        warnings: prepared.assessment.warnings,
        dashboard_url: dashboardUrl(dep.id, ctx.network),
        billing: BILLING_NOTES,
        stop_hint: `stop_deployment(${dep.id}) ends billing.`,
        poll_after_seconds: 10,
        next_tool: input.start ? 'wait_for_deployment' : 'start_deployment',
        next_args: input.start ? { deployment_id: dep.id, max_seconds: WAIT_DEFAULT_SECONDS } : { deployment_id: dep.id, confirm: false },
      };
    },
  ),

  tool(
    'wait_for_deployment',
    {
      title: 'Wait for a deployment',
      description: `Watches a deployment for up to max_seconds (default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS}; MCP clients time out at 60 s). Returns outcome "online" (service answers, with ready URLs and usage), "completed" (job finished, with logs), "stopped" (stopped by the user or its timeout; not an error), "failed" (with the scheduler error) or "pending" (with phase, elapsed time and poll_after_seconds; call again). Safe to call repeatedly.`,
      annotations: READ_ONLY,
    },
    {
      deployment_id: z.string(),
      max_seconds: z.number().int().min(5).max(WAIT_MAX_SECONDS).default(WAIT_DEFAULT_SECONDS),
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
      const common = { deployment_id, status: dep.status, dashboard_url: dashboardUrl(dep.id, ctx.network), progress: lines };
      switch (outcome.kind) {
        case 'online': {
          const snapshot = await snapshotDeployment(client, deployment_id);
          const usd = await usdPerHourForMarket(ctx, dep.market);
          return {
            ok: true,
            outcome: 'online',
            message: `ONLINE: the service answers at ${outcome.readyUrls.join(', ')}. Remind the user that it bills ${usd ?? '?'} USD/h until stop_deployment.`,
            ready_urls: outcome.readyUrls,
            kind: snapshot.facts.kind,
            usage: endpointUsage(snapshot),
            usd_per_hour: usd,
            timeout_minutes: dep.timeout,
            billing: BILLING_NOTES,
            stop_hint: `stop_deployment(${dep.id}) ends billing.`,
            ...common,
            next_tool: null,
          };
        }
        case 'completed': {
          let result: unknown = null;
          try {
            result = (await dep.getJob(outcome.job)).jobResult;
          } catch {
            /* results may lag */
          }
          return { ok: true, outcome: 'completed', message: `COMPLETED: job ${outcome.job} finished.`, job: outcome.job, explorer_url: explorerJobUrl(outcome.job, ctx.network), logs: formatJobResult(result).map(stripAnsi), ...common, next_tool: null };
        }
        case 'stopped':
          return { ok: true, outcome: 'stopped', message: 'STOPPED: the deployment was stopped by the user or reached its timeout. This is not a failure; do not restart it unless the user asks. start_deployment would pay the boot time again.', ...common, next_tool: null };
        case 'failed':
          return {
            ok: true,
            outcome: 'failed',
            message: `FAILED: ${outcome.error ?? outcome.reason}.${outcome.error ? ` Call stop_deployment(${dep.id}) so the scheduler stops retrying.` : ''}`,
            reason: outcome.reason,
            error: outcome.error ?? null,
            ...common,
            next_tool: outcome.error ? 'stop_deployment' : 'get_deployment_events',
            next_args: { deployment_id },
          };
        default: {
          const snapshot = await snapshotDeployment(client, deployment_id);
          const view = await snapshotView(ctx, snapshot);
          const hint = PHASE_HINTS[snapshot.phase];
          return {
            ok: true,
            outcome: 'pending',
            message: `PENDING (${snapshot.phase}): ${hint.message} ${snapshot.elapsedSeconds}s elapsed since the host took the job; typical boot ${snapshot.facts.bootMinutes} min. Tell the user, then call wait_for_deployment again after ${hint.pollAfterSeconds}s.`,
            ...view,
            progress: lines,
            next_tool: 'wait_for_deployment',
            next_args: { deployment_id, max_seconds: WAIT_DEFAULT_SECONDS },
          };
        }
      }
    },
  ),

  tool(
    'get_deployment',
    {
      title: 'Get deployment',
      description: 'Current status and phase of a deployment: endpoints (tunnel online and whether the service actually answers), ready URLs, price per hour, recent jobs and events, and what to call next.',
      annotations: READ_ONLY,
    },
    { deployment_id: z.string() },
    async (ctx, { deployment_id }) => {
      const snapshot = await snapshotDeployment(ctx.get(), deployment_id);
      const view = await snapshotView(ctx, snapshot);
      return { ok: true, message: `${snapshot.deployment.name}: ${snapshot.deployment.status}, phase ${snapshot.phase}. ${PHASE_HINTS[snapshot.phase].message}`, ...view };
    },
  ),

  tool(
    'get_endpoint_usage',
    {
      title: 'How to use a deployment endpoint',
      description: 'Explains how to use a running deployment: ComfyUI UI and /prompt API, OpenAI-compatible base URL for Ollama/vLLM LLMs (OPENAI_BASE_URL, /v1/models, /v1/chat/completions), Jupyter/VS Code URLs, or the raw ports of a custom job.',
      annotations: READ_ONLY,
    },
    { deployment_id: z.string() },
    async (ctx, { deployment_id }) => {
      const snapshot = await snapshotDeployment(ctx.get(), deployment_id);
      const usage = endpointUsage(snapshot);
      return {
        ok: true,
        message: usage.ready ? `Service is up (${snapshot.facts.kind}).` : `Service is not answering yet (phase ${snapshot.phase}); the usage below applies once it is.`,
        deployment_id,
        phase: snapshot.phase,
        ...usage,
        next_tool: usage.ready ? null : 'wait_for_deployment',
        next_args: usage.ready ? undefined : { deployment_id, max_seconds: WAIT_DEFAULT_SECONDS },
      };
    },
  ),

  tool(
    'list_deployments',
    {
      title: 'List deployments',
      description: 'Deployments on this account (newest first) with status, strategy, active jobs and timeout. Check status=RUNNING before creating another one.',
      annotations: READ_ONLY,
    },
    {
      limit: z.number().int().min(1).max(100).default(20),
      status: z.string().optional().describe('Filter, e.g. "RUNNING" or "RUNNING,STARTING" or "STOPPED,ERROR".'),
      search: z.string().optional().describe('Partial id or name.'),
    },
    async (ctx, { limit, status, search }) => {
      const result = await withRetry(() =>
        ctx.get().api.deployments.list({
          limit: pageSize(limit),
          ...(status ? { status: status.toUpperCase() } : {}),
          ...(search ? { search } : {}),
        }),
      );
      const deployments = (result.deployments as ApiDeployment[]).slice(0, limit).map((d) => ({
        deployment_id: d.id,
        name: d.name,
        status: d.status,
        strategy: d.strategy,
        active_jobs: d.active_jobs,
        timeout_minutes: d.timeout,
        endpoints: (d.endpoints ?? []).map((e) => ({ url: e.url, tunnel_online: e.online })),
        updated_at: d.updated_at,
        dashboard_url: dashboardUrl(d.id, ctx.network),
      }));
      const running = deployments.filter((d) => d.status === 'RUNNING' || d.status === 'STARTING');
      return { ok: true, message: `${deployments.length} of ${result.total_items} deployments; ${running.length} running.`, deployments, running_count: running.length, next_tool: null };
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
      if (dep.status === 'DRAFT') return { ok: false, message: 'Drafts cannot be stopped (nothing is running). Start it first if you want to run it.', deployment_id, status: dep.status, next_tool: null };
      if (['STOPPED', 'ARCHIVED'].includes(dep.status)) return { ok: true, message: `Already ${dep.status}.`, deployment_id, status: dep.status, next_tool: null };
      await dep.stop();
      const after = (await client.api.deployments.get(deployment_id)) as ApiDeployment;
      return { ok: true, message: `Stop requested; status is now ${after.status}. Billing ends with the job.`, deployment_id, status: after.status, next_tool: null };
    },
  ),

  tool(
    'start_deployment',
    {
      title: 'Start deployment',
      description: 'SPENDS CREDITS. Starts a DRAFT or STOPPED deployment again with its existing settings (pays the boot time again). Requires confirm=true after the user agreed.',
      annotations: SPENDS,
    },
    { deployment_id: z.string(), confirm: z.boolean().default(false) },
    async (ctx, { deployment_id, confirm }) => {
      const client = ctx.get();
      const dep = (await client.api.deployments.get(deployment_id)) as ApiDeployment;
      const usd = await usdPerHourForMarket(ctx, dep.market);
      if (!confirm) {
        return { ok: true, outcome: 'not_started', message: `NOT STARTED: ${dep.name} would run at ${usd ?? '?'} USD/h for up to ${dep.timeout} minutes per job (${dep.replicas} replica). Call again with confirm=true once the user agrees.`, deployment_id, status: dep.status, usd_per_hour: usd, timeout_minutes: dep.timeout, next_tool: 'start_deployment', next_args: { deployment_id, confirm: true } };
      }
      await dep.start();
      return { ok: true, outcome: 'started', message: `Started ${deployment_id}. Poll wait_for_deployment.`, deployment_id, status: 'STARTING', usd_per_hour: usd, dashboard_url: dashboardUrl(deployment_id, ctx.network), next_tool: 'wait_for_deployment', next_args: { deployment_id, max_seconds: WAIT_DEFAULT_SECONDS } };
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
      return { ok: true, message: `Timeout of ${deployment_id} set to ${timeout_minutes} minutes.`, deployment_id, timeout_minutes, next_tool: null };
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
        if (!jobs.length) return { ok: true, message: 'This deployment has not run any job yet.', deployment_id, next_tool: 'wait_for_deployment', next_args: { deployment_id } };
        address = jobs[0].job;
      }
      const detail = await dep.getJob(address);
      return {
        ok: true,
        message: `Job ${address} is ${normalizeJobState(detail.state)}.`,
        deployment_id,
        job: address,
        state: normalizeJobState(detail.state),
        host: detail.node,
        explorer_url: explorerJobUrl(address, ctx.network),
        logs: formatJobResult(detail.jobResult).map(stripAnsi),
        next_tool: null,
      };
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
      return { ok: true, message: `${events.length} events.`, deployment_id, events: events.map((e) => ({ at: e.created_at, type: e.type, category: e.category, message: e.message })), next_tool: null };
    },
  ),
];

export async function templatesResource(ctx: ToolContext): Promise<string> {
  const all = await ctx.templates();
  return JSON.stringify(topLevelTemplates(all).map((t) => templateView(t, all)), null, 2);
}

export async function gpusResource(ctx: ToolContext): Promise<string> {
  const catalog = await ctx.catalog();
  return JSON.stringify(bucketsView(bucketGpus(catalog)), null, 2);
}

export const prompts = {
  deploy_template(workload: string, gpu?: string, timeout?: string): string {
    return [
      `Deploy "${workload}" on Nosana for me.`,
      '',
      '1. Call recommend_plan with this workload' + (timeout ? ` and timeout_minutes ${timeout}` : '') + '. If it returns needs_variant or needs_choice, ask me which one.',
      `2. ${gpu ? `Use GPU "${gpu}" unless recommend_plan marks it unsupported.` : 'Prefer the recommended ready_now GPU. If nothing is ready, show me fits_but_queued and idle_with_risk and let me decide; never pick an unsupported GPU.'}`,
      '3. If a similar deployment is already running, offer to reuse it instead.',
      '4. Show me the estimated credits and USD per hour, then call create_deployment with confirm=true only after I say yes.',
      '5. Poll wait_for_deployment (max_seconds 30) until the outcome is online or completed, telling me the phase each time.',
      '6. When online, call get_endpoint_usage and give me the URL plus how to use it. Remind me to say "stop" when done so billing ends.',
    ].join('\n');
  },
  deploy_llm(model?: string): string {
    return [
      `Run ${model ? `the ${model}` : 'an open-weight'} LLM on a Nosana GPU and give me an OpenAI-compatible endpoint.`,
      '',
      `1. Call recommend_plan with workload "${model ?? 'qwen3-6-27b'}"${model ? '' : ' (or list_templates search "LLM" and ask me)'}.`,
      '2. Pick the recommended ready_now GPU (cheapest that has enough VRAM and an idle host). Never send a 27B model to an 8 GB card.',
      '3. Show me the cost per hour and the estimate, then create_deployment with confirm=true after I agree.',
      '4. Poll wait_for_deployment until online. Model download takes a few minutes.',
      '5. Call get_endpoint_usage and give me OPENAI_BASE_URL, the model id from /v1/models, and a curl example for /v1/chat/completions.',
      '6. Remind me that it bills per hour until stop_deployment.',
    ].join('\n');
  },
  deploy_comfy(workflow?: string): string {
    return [
      `Deploy ${workflow ? `ComfyUI for ${workflow}` : 'ComfyUI'} on Nosana.`,
      '',
      `1. Call recommend_plan with workload "${workflow ?? 'comfyui'}". MiniMax H3 variants need a Blackwell GPU (5090 or PRO 6000) and 120 minutes; generic ComfyUI runs on small cards.`,
      '2. Show me the recommended GPU and cost; create_deployment with confirm=true after I agree.',
      '3. Poll wait_for_deployment until online (weights can take 5 to 15 minutes).',
      '4. Give me the ComfyUI URL and the /prompt API usage from get_endpoint_usage.',
      '5. Remind me to stop the deployment when I have downloaded my outputs.',
    ].join('\n');
  },
  deploy_minimax_h3(variant?: string, gpu?: string): string {
    return prompts.deploy_template(`minimax-h3/${variant ?? 'i2v-32gb'}`, gpu, '120');
  },
  stop_when_done(): string {
    return [
      'I am done with my Nosana GPU work.',
      '',
      '1. Call list_deployments with status "RUNNING,STARTING".',
      '2. List them with name, GPU, USD per hour and how long they have been running.',
      '3. Ask me which to stop (default: all), then call stop_deployment for each.',
      '4. Confirm the final list_deployments shows nothing running, and call get_balance to show what is left.',
    ].join('\n');
  },
};
