import type { JobDefinition, NosanaClient } from '@nosana/kit';
import pc from 'picocolors';
import { CliError, type ApiDeployment, type CreateDeploymentBody } from './client.js';
import type { Network } from './config.js';
import { elapsed, fmtDate, short, sleep, statusColor, table, withRetry } from './format.js';
import { fitsVram, type GpuMarket, type GpuTableOptions } from './markets.js';
import { exposesPorts, kindOfDefinition, llmFlavor, readinessPath, typicalBootMinutes, type WorkloadKind } from './templates.js';

export type Strategy = 'SIMPLE' | 'SIMPLE-EXTEND' | 'SCHEDULED' | 'INFINITE';

/** Nosana refuses credit-paid jobs shorter than 3600 seconds, so every deployment needs at least this timeout. */
export const MIN_TIMEOUT_MINUTES = 60;
export const STRATEGIES: readonly Strategy[] = ['SIMPLE', 'SIMPLE-EXTEND', 'SCHEDULED', 'INFINITE'];

export function parseStrategy(value: string | undefined): Strategy {
  if (!value) return 'SIMPLE';
  const upper = value.trim().toUpperCase().replace('_', '-');
  const found = STRATEGIES.find((s) => s === upper);
  if (!found) throw new CliError(`Unknown strategy "${value}". Use one of: ${STRATEGIES.join(', ')}.`, 2);
  return found;
}

export interface DeployPlan {
  name: string;
  /** Human label of what is being deployed (template id or file name). */
  workload: string;
  jobDefinition: JobDefinition;
  gpu: GpuMarket;
  timeoutMinutes: number;
  replicas: number;
  strategy: Strategy;
  schedule?: string;
  rotationTime?: number;
  startupTimeoutMinutes?: number;
  confidential: boolean;
  sshPublicKeys?: string[];
}

export function defaultDeploymentName(label: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const base = label.toLowerCase().replace(/\.json$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workload';
  return `${base}-${stamp}`;
}

export interface PlanAssessment {
  /** Problems that should stop the deployment unless the caller forces it. */
  blocking: string[];
  /** Things worth knowing that do not block. */
  advisories: string[];
  /** blocking followed by advisories, for printing. */
  warnings: string[];
  cost: CostEstimate;
}

export interface AssessOptions {
  /** Treat "no idle host" as blocking (agents must get explicit consent to queue). */
  requireIdle?: boolean;
}

export function assessPlan(plan: DeployPlan, fit: GpuTableOptions, creditsAvailable: number, options: AssessOptions = {}): PlanAssessment {
  const blocking: string[] = [];
  const advisories: string[] = [];
  const gpu = plan.gpu;
  if (!fitsVram(gpu, fit.minVramGb)) {
    blocking.push(`${gpu.name} has ${gpu.vramGb ?? '?'} GB VRAM but the workload asks for ${fit.minVramGb} GB.`);
  }
  if (fit.recommend && !fit.recommend(gpu)) {
    blocking.push(`${gpu.name} is not a Blackwell card; this template's weights need RTX 5090 or RTX PRO 6000 class hardware.`);
  }
  const cost = estimateCost(plan);
  if (cost.total > creditsAvailable) {
    blocking.push(`Estimated ${cost.total.toFixed(3)} credits exceed the ${creditsAvailable.toFixed(3)} available. Top up at https://deploy.nosana.com (Billing).`);
  }
  if (gpu.availableNodes === 0) {
    const note = `No idle ${gpu.name} host right now; the job would queue until one frees up.`;
    if (options.requireIdle) blocking.push(`${note} Pass accept_queue=true if the user agrees to wait, or pick a GPU from ready_now.`);
    else advisories.push(note);
  }
  return { blocking, advisories, warnings: [...blocking, ...advisories], cost };
}

export interface CostEstimate {
  perHour: number;
  hours: number;
  total: number;
  recurring: boolean;
}

/** 1 credit is priced like 1 USD on the dashboard; the estimate covers one full timeout window. */
export function estimateCost(plan: DeployPlan): CostEstimate {
  const perHour = plan.gpu.pricePerHour * plan.replicas;
  const hours = plan.timeoutMinutes / 60;
  return { perHour, hours, total: perHour * hours, recurring: plan.strategy !== 'SIMPLE' };
}

export function validatePlan(plan: DeployPlan): void {
  if (!plan.name.trim()) throw new CliError('Deployment name is required.', 2);
  if (!Number.isInteger(plan.replicas) || plan.replicas < 1) throw new CliError('--replicas must be a whole number >= 1.', 2);
  if (!Number.isInteger(plan.timeoutMinutes) || plan.timeoutMinutes < MIN_TIMEOUT_MINUTES) {
    throw new CliError(
      `--timeout must be a whole number of minutes >= ${MIN_TIMEOUT_MINUTES}: Nosana only schedules credit-paid jobs that run for at least 3600 seconds.`,
      2,
    );
  }
  if (plan.strategy === 'SCHEDULED' && !plan.schedule) {
    throw new CliError('--schedule <cron> is required for SCHEDULED deployments (5 fields, e.g. "0 9 * * 1-5").', 2);
  }
  if (plan.strategy !== 'SCHEDULED' && plan.schedule) throw new CliError('--schedule only applies to --strategy SCHEDULED.', 2);
  if (plan.strategy === 'INFINITE') {
    if (plan.startupTimeoutMinutes !== undefined && !exposesPorts(plan.jobDefinition)) {
      throw new CliError('--startup-timeout requires a job definition that exposes a port.', 2);
    }
  } else if (plan.rotationTime !== undefined || plan.startupTimeoutMinutes !== undefined) {
    throw new CliError('--rotation-time and --startup-timeout only apply to --strategy INFINITE.', 2);
  }
  if (plan.sshPublicKeys && plan.sshPublicKeys.length > 10) throw new CliError('At most 10 SSH public keys are allowed.', 2);
}

export function buildCreateBody(plan: DeployPlan): CreateDeploymentBody {
  const body: Record<string, unknown> = {
    name: plan.name,
    market: plan.gpu.address,
    replicas: plan.replicas,
    timeout: plan.timeoutMinutes,
    confidential: plan.confidential,
    job_definition: plan.jobDefinition,
    strategy: plan.strategy,
  };
  if (plan.sshPublicKeys?.length) body.ssh_public_keys = plan.sshPublicKeys;
  if (plan.strategy === 'SCHEDULED') body.schedule = plan.schedule;
  if (plan.strategy === 'INFINITE') {
    if (plan.rotationTime !== undefined) body.rotation_time = plan.rotationTime;
    if (plan.startupTimeoutMinutes !== undefined) body.startup_timeout = plan.startupTimeoutMinutes;
  }
  return body as unknown as CreateDeploymentBody;
}

export async function createDeployment(client: NosanaClient, plan: DeployPlan): Promise<ApiDeployment> {
  validatePlan(plan);
  return (await client.api.deployments.create(buildCreateBody(plan))) as ApiDeployment;
}

export const dashboardUrl = (id: string, network: Network): string =>
  `https://deploy.nosana.com/deployments/${id}${network === 'devnet' ? '?network=devnet' : ''}`;

export const explorerJobUrl = (job: string, network: Network): string =>
  `https://explore.nosana.com/jobs/${job}${network === 'devnet' ? '?network=devnet' : ''}`;

const JOB_STATES: Record<string, string> = { '0': 'QUEUED', '1': 'RUNNING', '2': 'COMPLETED', '3': 'STOPPED' };
export const normalizeJobState = (state: unknown): string => JOB_STATES[String(state)] ?? String(state ?? 'UNKNOWN');

type DeploymentExtra = { schedule?: string; rotation_time?: number; startup_timeout?: number };

export function summarizeDeployment(dep: ApiDeployment, network: Network): string[] {
  const extra = dep as unknown as DeploymentExtra;
  const strategyBits: string[] = [dep.strategy];
  if (extra.schedule) strategyBits.push(`schedule "${extra.schedule}"`);
  if (extra.rotation_time !== undefined) strategyBits.push(`rotation ${extra.rotation_time}`);
  if (extra.startup_timeout !== undefined) strategyBits.push(`startup timeout ${extra.startup_timeout} min`);
  const lines = [
    `${pc.bold('Deployment')}    ${dep.id}`,
    `Name          ${dep.name}`,
    `Status        ${statusColor(dep.status)}`,
    `Market        ${dep.market}`,
    `Strategy      ${strategyBits.join(', ')}`,
    `Timeout       ${dep.timeout} min`,
    `Replicas      ${dep.replicas} (active jobs: ${dep.active_jobs})`,
    `Confidential  ${dep.confidential ? 'yes' : 'no'}`,
    `Revision      ${dep.active_revision}`,
    `Created       ${fmtDate(dep.created_at)}`,
    `Updated       ${fmtDate(dep.updated_at)}`,
    `Dashboard     ${dashboardUrl(dep.id, network)}`,
  ];
  if (dep.endpoints?.length) {
    lines.push('Endpoints');
    for (const endpoint of dep.endpoints) {
      lines.push(`  ${endpoint.online ? pc.green('online ') : pc.dim('offline')} ${endpoint.url}  (${endpoint.opId}:${endpoint.port})`);
    }
  }
  return lines;
}

export function deploymentsTable(deps: ApiDeployment[]): string {
  return table(
    ['ID', 'Name', 'Status', 'Strategy', 'Jobs', 'Timeout', 'Updated'],
    deps.map((d) => [
      d.id,
      d.name,
      statusColor(d.status),
      d.strategy,
      String(d.active_jobs),
      `${d.timeout} min`,
      fmtDate(d.updated_at),
    ]),
  );
}

export interface WaitOptions {
  timeoutMinutes: number;
  intervalSeconds?: number;
  network: Network;
  quiet?: boolean;
  /** Print the deployment's existing event log on the first pass (useful right after creation). */
  replayEvents?: boolean;
  /** Receive progress lines instead of printing them to stdout (used by the MCP server). */
  onLog?: (line: string) => void;
}

export type WaitOutcome =
  | { kind: 'online'; deployment: ApiDeployment; readyUrls: string[] }
  | { kind: 'completed'; deployment: ApiDeployment; job: string }
  | { kind: 'stopped'; deployment: ApiDeployment }
  | { kind: 'failed'; deployment: ApiDeployment; reason: string; error?: string }
  | { kind: 'timeout'; deployment: ApiDeployment; phase: DeploymentPhase };

export type DeploymentPhase = 'draft' | 'scheduling' | 'queued' | 'starting' | 'initializing' | 'ready' | 'completed' | 'stopped' | 'error';

export interface DefinitionFacts {
  jobDefinition: JobDefinition | null;
  exposes: boolean;
  kind: WorkloadKind;
  readinessPath: string;
  bootMinutes: number;
  opId: string | null;
}

export async function inspectDefinition(dep: ApiDeployment): Promise<DefinitionFacts> {
  let definition: JobDefinition | null = null;
  try {
    const revisions = await dep.getRevisions({ limit: 10 });
    const items = revisions.revisions as { revision: number; job_definition?: unknown }[];
    const active = items.find((r) => r.revision === dep.active_revision) ?? items[0];
    if (active?.job_definition) definition = active.job_definition as JobDefinition;
  } catch {
    /* fall through */
  }
  if (!definition) {
    return { jobDefinition: null, exposes: (dep.endpoints?.length ?? 0) > 0, kind: 'custom', readinessPath: '/', bootMinutes: 3, opId: dep.endpoints?.[0]?.opId ?? null };
  }
  const kind = kindOfDefinition(definition);
  const ops = (definition as { ops?: { id?: string }[] }).ops ?? [];
  return {
    jobDefinition: definition,
    exposes: exposesPorts(definition),
    kind,
    readinessPath: readinessPath(kind, llmFlavor(definition)),
    bootMinutes: typicalBootMinutes(definition, kind),
    opId: ops[0]?.id ?? null,
  };
}

/** Where a deployment is in its life, derived from status, jobs and endpoint probes. */
export function computePhase(
  dep: ApiDeployment,
  jobs: { state: unknown; node?: string | null }[],
  endpoints: { tunnel_online: boolean; service_ready: boolean }[],
  exposes: boolean,
): DeploymentPhase {
  if (dep.status === 'DRAFT') return 'draft';
  if (dep.status === 'ERROR' || dep.status === 'INSUFFICIENT_FUNDS') return 'error';
  const states = jobs.map((j) => normalizeJobState(j.state));
  if (states.includes('COMPLETED') && !exposes) return 'completed';
  if (TERMINAL_STATUSES.has(dep.status)) return 'stopped';
  if (endpoints.some((e) => e.service_ready)) return 'ready';
  if (states.includes('RUNNING')) return endpoints.some((e) => e.tunnel_online) ? 'initializing' : 'starting';
  if (states.includes('QUEUED')) return 'queued';
  return 'scheduling';
}

export const PHASE_HINTS: Record<DeploymentPhase, { message: string; pollAfterSeconds: number }> = {
  draft: { message: 'Created but not started.', pollAfterSeconds: 0 },
  scheduling: { message: 'Nosana is listing the job on the market.', pollAfterSeconds: 10 },
  queued: { message: 'Job is queued, waiting for an idle host on this GPU market.', pollAfterSeconds: 30 },
  starting: { message: 'A host picked the job and is pulling the image and any model weights before the container opens its tunnel.', pollAfterSeconds: 20 },
  initializing: { message: 'Tunnel is up; the service is still starting (downloading weights or loading the model).', pollAfterSeconds: 30 },
  ready: { message: 'The service answers.', pollAfterSeconds: 0 },
  completed: { message: 'The job finished.', pollAfterSeconds: 0 },
  stopped: { message: 'The deployment is stopped (by the user or by its timeout), not failed.', pollAfterSeconds: 0 },
  error: { message: 'The deployment is in an error state.', pollAfterSeconds: 0 },
};

export interface EndpointSnapshot {
  url: string;
  op: string;
  port: number | string;
  tunnel_online: boolean;
  service_ready: boolean;
}

export interface DeploymentSnapshot {
  deployment: ApiDeployment;
  facts: DefinitionFacts;
  phase: DeploymentPhase;
  endpoints: EndpointSnapshot[];
  readyUrls: string[];
  jobs: { job: string; state: string; node: string | null; created_at?: string; time_start?: number }[];
  events: { at?: string; type?: string; message?: string }[];
  elapsedSeconds: number;
}

export async function snapshotDeployment(client: NosanaClient, id: string, facts?: DefinitionFacts): Promise<DeploymentSnapshot> {
  const dep = (await withRetry(() => client.api.deployments.get(id))) as ApiDeployment;
  const resolvedFacts = facts ?? (await inspectDefinition(dep));
  const [jobsRaw, eventsRaw] = await Promise.all([
    dep.getJobs({ limit: 10 }).then((r) => r.jobs as { job: string; state: unknown; node?: string | null; created_at?: string; time_start?: number }[]).catch(() => []),
    dep.getEvents({ limit: 10, sort_order: 'desc' }).then((r) => r.events as { created_at?: string; type?: string; message?: string }[]).catch(() => []),
  ]);
  const jobRunning = jobsRaw.some((j) => normalizeJobState(j.state) === 'RUNNING');
  const endpoints: EndpointSnapshot[] = await Promise.all(
    (dep.endpoints ?? []).map(async (e) => ({
      url: e.url,
      op: e.opId,
      port: e.port,
      tunnel_online: e.online,
      // Probe whenever a job runs: the tunnel flag is advisory, the service answering is what counts.
      service_ready: e.online || jobRunning ? (await probeEndpoint(e.url, resolvedFacts.readinessPath)) === 'ready' : false,
    })),
  );
  const jobs = jobsRaw.slice(0, 5).map((j) => ({ job: j.job, state: normalizeJobState(j.state), node: j.node ?? null, created_at: j.created_at, time_start: j.time_start }));
  const running = jobsRaw.find((j) => normalizeJobState(j.state) === 'RUNNING' && j.time_start);
  const since = running?.time_start ? running.time_start * 1000 : new Date(dep.updated_at ?? dep.created_at).getTime();
  return {
    deployment: dep,
    facts: resolvedFacts,
    phase: computePhase(dep, jobsRaw, endpoints, resolvedFacts.exposes),
    endpoints,
    readyUrls: endpoints.filter((e) => e.service_ready).map((e) => e.url),
    jobs,
    events: eventsRaw.slice(0, 5).map((e) => ({ at: e.created_at, type: e.type, message: e.message })),
    elapsedSeconds: Math.max(0, Math.round((Date.now() - since) / 1000)),
  };
}

type EventLike = { type?: string; event?: string; message?: string; created_at?: string };
type JobLike = { job: string; state: unknown; node?: string | null };

const TERMINAL_STATUSES = new Set(['STOPPED', 'ERROR', 'INSUFFICIENT_FUNDS', 'ARCHIVED']);

const trimMessage = (message: string): string => message.replace(/\.?\s*TX\s+\S+$/i, '').trim();

/** Scheduler errors that will never resolve by retrying (bad config, no funds, no access). */
const FATAL_ERROR_PATTERN = /must have|invalid|not allowed|insufficient|unauthorized|forbidden|does not exist|not found/i;
const REPEATED_ERROR_LIMIT = 3;
/** Consecutive failed status polls tolerated before giving up on a watch. */
const MAX_CONSECUTIVE_FAILURES = 12;

export type EndpointProbe = 'ready' | 'initializing' | 'unreachable';

/**
 * The deployment manager marks an endpoint online as soon as the host's tunnel answers, which can be
 * long before the container does: Nosana then serves a 503 "Service Initializing" page. Probe the URL
 * so "online" means the workload itself responds.
 */
export async function probeEndpoint(url: string, path = '/'): Promise<EndpointProbe> {
  try {
    const target = path === '/' ? url : `${url.replace(/\/$/, '')}${path}`;
    const response = await fetch(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (response.status === 502 || response.status === 503 || response.status === 504) return 'initializing';
    return 'ready';
  } catch {
    return 'unreachable';
  }
}

export async function waitForDeployment(client: NosanaClient, id: string, options: WaitOptions): Promise<WaitOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMinutes * 60_000;
  const interval = (options.intervalSeconds ?? 5) * 1000;
  const seenEvents = new Set<string>();
  const jobStates = new Map<string, string>();
  const endpointStates = new Map<string, boolean>();
  const errorCounts = new Map<string, number>();
  let lastStatus = '';
  let facts: DefinitionFacts | null = null;
  let firstPass = true;
  let lastInitializingLog = 0;
  let lastPhase: DeploymentPhase = 'scheduling';
  const log = (message: string): void => {
    const line = `${pc.dim(elapsed(startedAt))}  ${message}`;
    if (options.onLog) options.onLog(line);
    else if (!options.quiet) console.log(line);
  };

  let consecutiveFailures = 0;
  for (;;) {
    let dep: ApiDeployment;
    try {
      dep = (await client.api.deployments.get(id)) as ApiDeployment;
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new CliError(`Lost contact with the Nosana API while watching ${id} (${message}). The deployment keeps running; retry with: nosana-deploy deploy watch ${id}`);
      }
      log(pc.dim(`network hiccup (${message.split('|')[0].trim()}), retrying in ${Math.round(interval / 1000)}s`));
      if (Date.now() >= deadline) throw new CliError(`Watch window elapsed while the API was unreachable. Retry with: nosana-deploy deploy watch ${id}`);
      await sleep(interval);
      continue;
    }
    if (facts === null) facts = await inspectDefinition(dep);
    const expectEndpoint = facts.exposes;
    if (dep.status !== lastStatus) {
      log(`deployment ${statusColor(dep.status)}`);
      lastStatus = dep.status;
    }

    try {
      const result = await dep.getEvents({ limit: 20, sort_order: 'desc' });
      const events = [...(result.events as EventLike[])].reverse();
      for (const event of events) {
        const key = `${event.created_at}|${event.type ?? event.event}|${event.message}`;
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        if (firstPass && !options.replayEvents) continue;
        const label = event.type ?? event.event ?? 'event';
        const message = event.message ? trimMessage(event.message) : '';
        const isError = /ERROR|FAIL/i.test(label);
        log(`${pc.dim('event')} ${isError ? pc.red(label) : label}${message ? `: ${message}` : ''}`);
        if (isError && message) {
          const count = (errorCounts.get(message) ?? 0) + 1;
          errorCounts.set(message, count);
          if (FATAL_ERROR_PATTERN.test(message) || count >= REPEATED_ERROR_LIMIT) {
            return { kind: 'failed', deployment: dep, reason: dep.status, error: message };
          }
        }
      }
    } catch {
      /* events are informational only */
    }

    let jobsSeen: JobLike[] = [];
    try {
      const list = await dep.getJobs({ limit: 20 });
      jobsSeen = list.jobs as JobLike[];
      for (const raw of jobsSeen) {
        const state = normalizeJobState(raw.state);
        if (jobStates.get(raw.job) !== state) {
          jobStates.set(raw.job, state);
          log(`job ${pc.dim(short(raw.job))} ${statusColor(state)}${raw.node ? ` on host ${short(raw.node)}` : ''}`);
        }
        if (!expectEndpoint && state === 'COMPLETED') return { kind: 'completed', deployment: dep, job: raw.job };
      }
    } catch {
      /* retry next tick */
    }

    for (const endpoint of dep.endpoints ?? []) {
      const key = `${endpoint.url}:${endpoint.port}`;
      if (endpointStates.get(key) !== endpoint.online) {
        endpointStates.set(key, endpoint.online);
        log(`endpoint ${endpoint.online ? pc.green('tunnel online') : pc.yellow('tunnel not reported online yet')} ${endpoint.url}`);
      }
    }
    if (expectEndpoint) {
      // Nosana's "online" flag can lag behind (or never flip) while the service already answers,
      // so once a job is running we probe every endpoint URL ourselves.
      const jobRunning = [...jobStates.values()].some((state) => state === 'RUNNING');
      const candidates = (dep.endpoints ?? []).filter((e) => e.online || jobRunning);
      if (candidates.length) {
        const readiness = facts.readinessPath;
        const probes = await Promise.all(candidates.map(async (e) => ({ url: e.url, state: await probeEndpoint(e.url, readiness) })));
        const ready = probes.filter((p) => p.state === 'ready').map((p) => p.url);
        if (ready.length) return { kind: 'online', deployment: dep, readyUrls: [...new Set(ready)] };
        if (Date.now() - lastInitializingLog >= 60_000) {
          lastInitializingLog = Date.now();
          const initializing = probes.some((p) => p.state === 'initializing');
          log(pc.dim(initializing ? 'tunnel is up, service still starting (image pull or weights download in progress)' : 'tunnel is up, service not answering yet'));
        }
      }
    }

    if (TERMINAL_STATUSES.has(dep.status)) {
      const completed = [...jobStates.entries()].find(([, state]) => state === 'COMPLETED');
      if (completed && !expectEndpoint) return { kind: 'completed', deployment: dep, job: completed[0] };
      if (dep.status === 'STOPPED' || dep.status === 'ARCHIVED') return { kind: 'stopped', deployment: dep };
      return { kind: 'failed', deployment: dep, reason: dep.status };
    }
    lastPhase = computePhase(
      dep,
      jobsSeen,
      (dep.endpoints ?? []).map((e) => ({ tunnel_online: e.online, service_ready: false })),
      expectEndpoint,
    );
    if (Date.now() >= deadline) return { kind: 'timeout', deployment: dep, phase: lastPhase };
    firstPass = false;
    await sleep(interval);
  }
}

type OpState = {
  operationId?: string | null;
  status?: string | null;
  exitCode?: number | null;
  logs?: { type?: string; log?: string }[];
  error?: { message?: string };
};

export function formatJobResult(result: unknown): string[] {
  const r = result as { status?: string; opStates?: OpState[] } | null | undefined;
  if (!r) return [pc.dim('(no results reported yet)')];
  const lines = [`Result status: ${r.status ?? '?'}`];
  for (const op of r.opStates ?? []) {
    lines.push(`${pc.bold(op.operationId ?? 'op')}  status=${op.status ?? '?'}  exit=${op.exitCode ?? '?'}`);
    if (op.error?.message) lines.push(pc.red(`  error: ${op.error.message}`));
    for (const entry of op.logs ?? []) {
      const text = (entry.log ?? '').replace(/\n$/, '');
      if (!text) continue;
      lines.push(entry.type === 'stderr' || entry.type === 'nodeerr' ? pc.red(`  ${text}`) : `  ${text}`);
    }
  }
  return lines;
}
