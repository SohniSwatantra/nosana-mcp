import fs from 'node:fs';
import path from 'node:path';
import { confirm, input, select } from '@inquirer/prompts';
import { validateJobDefinition, type JobDefinition, type NosanaClient } from '@nosana/kit';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliError, createClient, type ApiDeployment, type GlobalOptions } from '../../core/client.js';
import { isInteractive, resolveApiKey } from '../../core/config.js';
import {
  assessPlan,
  createDeployment,
  dashboardUrl,
  defaultDeploymentName,
  estimateCost,
  explorerJobUrl,
  formatJobResult,
  MIN_TIMEOUT_MINUTES,
  parseStrategy,
  STRATEGIES,
  summarizeDeployment,
  validatePlan,
  waitForDeployment,
  type DeployPlan,
  type Strategy,
  type WaitOutcome,
} from '../../core/deploy.js';
import { fmtMinutes, heading, parseIntStrict, printJson, sym, usd } from '../../core/format.js';
import { fitLabel, fitsVram, loadGpuCatalog, resolveGpu, type GpuMarket, type GpuTableOptions } from '../../core/markets.js';
import {
  hardwareHints,
  isBlackwell,
  listTemplates,
  NeedsVariantError,
  prepareJobDefinition,
  resolveTemplate,
  topLevelTemplates,
  vramFromDefinition,
  type ResolvedTemplate,
  type TemplateInfo,
} from '../../core/templates.js';
import { availableCredits, loginInteractive } from './account.js';

export interface RunFlags {
  template?: string;
  variant?: string;
  file?: string;
  gpu?: string;
  name?: string;
  timeout?: string;
  replicas?: string;
  strategy?: string;
  schedule?: string;
  rotationTime?: string;
  startupTimeout?: string;
  confidential?: boolean;
  sshKey?: string[];
  start?: boolean;
  wait?: boolean;
  waitTimeout?: string;
  yes?: boolean;
  force?: boolean;
  all?: boolean;
}

export const DEFAULT_WAIT_MINUTES = 45;

export function addDeployFlags(command: Command, defaults: { start: boolean }): Command {
  return command
    .option('-t, --template <id>', 'Template id or name, e.g. minimax-h3 (see `templates list`)')
    .option('--variant <id>', 'Template variant, e.g. i2v-32gb')
    .option('-f, --file <path>', 'Deploy a custom job definition JSON instead of a template')
    .option('-g, --gpu <market>', 'GPU market slug, short name or address, e.g. nvidia-5090 or 5090')
    .option('--name <name>', 'Deployment name (default: <template>-<timestamp>)')
    .option('--timeout <minutes>', `How long the GPU stays reserved per job, in minutes (minimum and default ${MIN_TIMEOUT_MINUTES})`)
    .option('--replicas <count>', 'Number of parallel jobs', '1')
    .option('--strategy <strategy>', `One of ${STRATEGIES.join(', ')} (default SIMPLE)`)
    .option('--schedule <cron>', 'Cron schedule, required for SCHEDULED')
    .option('--rotation-time <value>', 'INFINITE only: rotation time passed to the API as-is (the dashboard uses 20 with a 360 min timeout)')
    .option('--startup-timeout <minutes>', 'INFINITE only: minutes a job has to open its tunnel before it is replaced')
    .option('--confidential', 'Create a confidential deployment (endpoint needs the header from `deploy auth-header`)')
    .option('--ssh-key <publicKey...>', 'SSH public keys allowed to reach the jobs (max 10)')
    .option('--all', 'Allow community GPU markets, not only premium ones')
    .option('--wait-timeout <minutes>', `How long to wait for the workload to come online (default ${DEFAULT_WAIT_MINUTES})`)
    .option('--no-wait', 'Do not wait for the workload after starting it')
    .option(defaults.start ? '--no-start' : '--start', defaults.start ? 'Create as a draft without starting' : 'Start right after creating')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--force', 'Deploy even if the GPU looks too small or credits look insufficient');
}

function readJobDefinitionFile(file: string): JobDefinition {
  const fullPath = path.resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    throw new CliError(`Could not read job definition ${fullPath}: ${(error as Error).message}`, 2);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`Job definition must be a JSON object: ${fullPath}`, 2);
  }
  const validation = validateJobDefinition(parsed);
  if (!validation.success) {
    throw new CliError(`Invalid job definition ${fullPath}:\n${JSON.stringify(validation.errors, null, 2)}`, 2);
  }
  return parsed as JobDefinition;
}

async function pickTemplate(all: TemplateInfo[], flags: RunFlags, tty: boolean): Promise<ResolvedTemplate> {
  if (flags.template) {
    try {
      return resolveTemplate(all, flags.template, flags.variant);
    } catch (error) {
      if (error instanceof NeedsVariantError && tty) {
        const variant = await select<string>({
          message: `Variant of ${error.template.name}`,
          choices: error.template.variants.map((v) => ({ name: v.name, value: v.id, description: v.description })),
        });
        return resolveTemplate(all, error.template.id, variant);
      }
      throw error;
    }
  }
  if (!tty) {
    throw new CliError('Pass --template <id> (or --file <job.json>). Run `nosana-deploy templates list` to see the catalog.', 2);
  }
  const top = topLevelTemplates(all);
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const term = squash(await input({ message: 'Search templates (press Enter to list all)' }));
  const matches = term
    ? top.filter((t) => squash(t.id).includes(term) || squash(t.name).includes(term) || squash(t.category.join(' ')).includes(term))
    : top;
  if (!matches.length) {
    console.log(`${sym.warn} No template matches that search. Try again or press Enter to see all.`);
    return pickTemplate(all, flags, tty);
  }
  const describe = (t: TemplateInfo): string | undefined =>
    t.variants.length ? `${t.variants.length} variants: ${t.variants.map((v) => v.name).join(', ')}` : t.description;
  let id: string;
  if (matches.length === 1) {
    id = matches[0].id;
    console.log(`${sym.ok} Template: ${matches[0].name}`);
  } else {
    id = await select<string>({
      message: 'Template',
      pageSize: 14,
      choices: matches.map((t) => ({
        name: `${t.name}  ${pc.dim(t.category.filter((c) => c !== 'Official').join(', '))}`,
        value: t.id,
        description: describe(t),
      })),
    });
  }
  return pickTemplate(all, { ...flags, template: id }, tty);
}

async function pickGpu(catalog: GpuMarket[], flags: RunFlags, tty: boolean, fit: GpuTableOptions): Promise<GpuMarket> {
  if (flags.gpu) {
    const gpu = resolveGpu(catalog, flags.gpu);
    if (!gpu) {
      throw new CliError(`Unknown GPU "${flags.gpu}". Run \`nosana-deploy gpus${flags.all ? ' --all' : ''}\` to list markets${flags.all ? '' : ' (add --all for community markets)'}.`, 2);
    }
    return gpu;
  }
  if (!tty) throw new CliError('Pass --gpu <slug>, for example --gpu nvidia-5090. Run `nosana-deploy gpus` for prices and availability.', 2);
  const score = (m: GpuMarket): number =>
    (fitsVram(m, fit.minVramGb) ? 4 : 0) + (fit.recommend ? (fit.recommend(m) ? 2 : 0) : 2) + (m.availableNodes > 0 ? 1 : 0);
  const ranked = [...catalog].sort((a, b) => score(b) - score(a) || a.pricePerHour - b.pricePerHour);
  const slug = await select<string>({
    message: 'GPU',
    pageSize: 14,
    choices: ranked.map((m) => ({
      name: `${m.name.padEnd(24)} ${(m.vramGb ? `${m.vramGb} GB` : '?').padStart(6)}  ${usd(m.pricePerHour).padStart(7)}/h  ${String(m.availableNodes).padStart(3)} available  ${fitLabel(m, fit)}`,
      value: m.slug,
      disabled: fitsVram(m, fit.minVramGb) ? false : 'too little VRAM',
    })),
  });
  return catalog.find((m) => m.slug === slug)!;
}

async function pickTimeout(flags: RunFlags, tty: boolean, strategy: Strategy): Promise<number> {
  const min = MIN_TIMEOUT_MINUTES;
  if (flags.timeout) {
    const requested = parseIntStrict(flags.timeout, '--timeout', 1);
    if (requested < min) {
      throw new CliError(`--timeout must be at least ${min} minutes: Nosana only schedules credit-paid jobs that run for 3600 seconds or more.`, 2);
    }
    return requested;
  }
  if (!tty) return min;
  const answer = await input({
    message: `Timeout in minutes, minimum ${min} (GPU time reserved${strategy === 'SIMPLE' ? '; the deployment stops when it elapses' : ' per job'})`,
    default: String(min),
    validate: (value) => (/^\d+$/.test(value.trim()) && Number(value) >= min ? true : `Enter a whole number >= ${min}`),
  });
  return Number(answer.trim());
}

function printPlan(plan: DeployPlan, available: number, resolved: ResolvedTemplate | null, start: boolean, out: (line: string) => void): void {
  const cost = estimateCost(plan);
  out(`\n${pc.bold('Plan')}`);
  const workload = resolved ? `${resolved.id}  ${pc.dim(resolved.template.name)}` : plan.workload;
  out(`  Workload      ${workload}`);
  out(`  GPU           ${plan.gpu.name} (${plan.gpu.slug})  ${plan.gpu.vramGb ? `${plan.gpu.vramGb} GB` : ''}  ${plan.gpu.availableNodes} host${plan.gpu.availableNodes === 1 ? '' : 's'} available  ${usd(plan.gpu.pricePerHour)}/h`);
  const strategyBits = [plan.strategy, `${plan.replicas} replica${plan.replicas === 1 ? '' : 's'}`, `timeout ${fmtMinutes(plan.timeoutMinutes)}`];
  if (plan.schedule) strategyBits.push(`schedule "${plan.schedule}"`);
  if (plan.rotationTime !== undefined) strategyBits.push(`rotation ${plan.rotationTime}`);
  out(`  Strategy      ${strategyBits.join(', ')}`);
  out(`  Confidential  ${plan.confidential ? 'yes' : 'no'}`);
  const window = `${usd(plan.gpu.pricePerHour)}/h x ${cost.hours.toFixed(2)} h x ${plan.replicas}`;
  out(`  Estimate      ${pc.bold(cost.total.toFixed(3))} credits for one timeout window (${window})${cost.recurring ? ', charged again for every extension' : ''}`);
  out(`  Credits       ${available.toFixed(3)} available${cost.total > available ? pc.red('  (not enough for the full window)') : ''}`);
  out(`  Action        ${start ? 'create and start now' : 'create as a draft (start later with `deploy start`)'}`);
}

async function reportOutcome(outcome: WaitOutcome, options: GlobalOptions): Promise<number> {
  const dep = outcome.deployment;
  if (options.json) {
    const payload: Record<string, unknown> = { outcome: outcome.kind, deployment: dep.id, status: dep.status, endpoints: dep.endpoints, dashboard: dashboardUrl(dep.id, options.network) };
    if (outcome.kind === 'online') payload.readyUrls = outcome.readyUrls;
    if (outcome.kind === 'completed') {
      payload.job = outcome.job;
      try {
        payload.result = (await dep.getJob(outcome.job)).jobResult;
      } catch {
        /* results may lag */
      }
    }
    printJson(payload);
    return outcome.kind === 'failed' ? 1 : 0;
  }
  console.log();
  switch (outcome.kind) {
    case 'online': {
      console.log(`${sym.ok} ${pc.bold('Your workload is online and answering.')}`);
      for (const endpoint of dep.endpoints.filter((e) => outcome.readyUrls.includes(e.url))) console.log(`   ${pc.bold(endpoint.url)}  (${endpoint.opId}, port ${endpoint.port})`);
      if (dep.confidential) {
        try {
          const header = await dep.generateAuthHeader();
          console.log(`   Confidential deployment: send this header with requests:\n   Authorization: ${header}`);
        } catch {
          console.log(`   Confidential deployment: run \`nosana-deploy deploy auth-header ${dep.id}\` to get the access header.`);
        }
      }
      console.log(`   Dashboard: ${dashboardUrl(dep.id, options.network)}`);
      console.log(`   Stop it any time: nosana-deploy deploy stop ${dep.id}`);
      return 0;
    }
    case 'completed': {
      console.log(`${sym.ok} ${pc.bold('Job completed.')}  ${explorerJobUrl(outcome.job, options.network)}`);
      try {
        const job = await dep.getJob(outcome.job);
        for (const line of formatJobResult(job.jobResult)) console.log(`   ${line}`);
      } catch (error) {
        console.log(`   Results not available yet: ${(error as Error).message}`);
      }
      return 0;
    }
    case 'stopped': {
      console.log(`${sym.warn} The deployment was stopped (by you or by its timeout) before the workload came up. Start it again with: nosana-deploy deploy start ${dep.id} --wait`);
      return 1;
    }
    case 'failed': {
      if (outcome.error) {
        console.log(`${sym.err} The scheduler cannot run this deployment: ${pc.red(outcome.error)}`);
        if (!['STOPPED', 'ERROR', 'INSUFFICIENT_FUNDS', 'ARCHIVED'].includes(dep.status)) {
          try {
            await dep.stop();
            console.log('   Stopped the deployment so it does not keep retrying.');
          } catch (error) {
            console.log(`   Could not stop it automatically (${(error as Error).message}); run: nosana-deploy deploy stop ${dep.id}`);
          }
        }
      } else {
        console.log(`${sym.err} Deployment ended with status ${pc.red(outcome.reason)} before the workload came up.`);
      }
      if (outcome.reason === 'INSUFFICIENT_FUNDS' || /insufficient/i.test(outcome.error ?? '')) {
        console.log('   Top up credits at https://deploy.nosana.com (Billing) and start it again with `deploy start`.');
      }
      console.log(`   Inspect with: nosana-deploy deploy events ${dep.id}`);
      return 1;
    }
    case 'timeout':
    default: {
      console.log(`${sym.warn} Still waiting after the watch window. The deployment keeps running; big templates need time to download their weights.`);
      console.log(`   Keep watching: nosana-deploy deploy watch ${dep.id}`);
      console.log(`   Dashboard:     ${dashboardUrl(dep.id, options.network)}`);
      return 0;
    }
  }
}

export async function runDeployFlow(options: GlobalOptions, flags: RunFlags, interactive: boolean, defaults: { start: boolean }): Promise<void> {
  const tty = interactive && isInteractive() && !options.json;
  // With --json only the final JSON document goes to stdout; progress lines go to stderr.
  const out = (line: string): void => (options.json ? console.error(line) : console.log(line));
  const start = flags.start ?? defaults.start;
  const wait = start && flags.wait !== false;
  if (flags.file && flags.template) throw new CliError('Use either --template or --file, not both.', 2);

  // Validate cheap things before touching the network so mistakes fail instantly.
  const strategy = parseStrategy(flags.strategy);
  if (flags.timeout !== undefined) {
    const requested = parseIntStrict(flags.timeout, '--timeout', 1);
    if (requested < MIN_TIMEOUT_MINUTES) {
      throw new CliError(`--timeout must be at least ${MIN_TIMEOUT_MINUTES} minutes: Nosana only schedules credit-paid jobs that run for 3600 seconds or more.`, 2);
    }
  }
  const replicas = parseIntStrict(flags.replicas ?? '1', '--replicas');
  const waitMinutes = flags.waitTimeout ? parseIntStrict(flags.waitTimeout, '--wait-timeout') : DEFAULT_WAIT_MINUTES;
  if (strategy === 'SCHEDULED' && !flags.schedule) throw new CliError('--schedule <cron> is required for SCHEDULED deployments.', 2);

  let apiKey = resolveApiKey(options.apiKey)?.key;
  if (!apiKey) {
    if (!tty) throw new CliError('No API key. Run `nosana-deploy login`, set NOSANA_API_KEY or pass --api-key.', 2);
    apiKey = await loginInteractive(options);
  }
  const client: NosanaClient = createClient(options, apiKey);

  const [balance, templates, catalog] = await Promise.all([
    client.api.credits.balance(),
    flags.file ? Promise.resolve([] as TemplateInfo[]) : listTemplates(client),
    loadGpuCatalog(client, { includeAll: flags.all }),
  ]);
  const available = availableCredits(balance);
  if (tty) console.log(`${pc.bold('Nosana Deploy')}  ${pc.dim('credits available:')} ${available.toFixed(3)}\n`);

  let resolved: ResolvedTemplate | null = null;
  let jobDefinition: JobDefinition;
  let workload: string;
  if (flags.file) {
    jobDefinition = readJobDefinitionFile(flags.file);
    workload = path.basename(flags.file);
  } else {
    resolved = await pickTemplate(templates, flags, tty);
    jobDefinition = prepareJobDefinition(resolved.jobDefinition);
    workload = resolved.id;
  }

  const minVramGb = resolved ? resolved.template.vramRequirementGb : vramFromDefinition(jobDefinition);
  const hints = resolved ? hardwareHints(resolved.parent) : { blackwellOnly: false, minDriver: null, notes: [] as string[] };
  const fit: GpuTableOptions = { minVramGb, recommend: hints.blackwellOnly ? (m) => isBlackwell(m.name, m.slug) : undefined };
  if (tty && (minVramGb || hints.notes.length)) {
    console.log(pc.dim(`  ${[minVramGb ? `Needs ${minVramGb} GB VRAM.` : null, ...hints.notes].filter(Boolean).join(' ')}\n`));
  }

  const gpu = await pickGpu(catalog, flags, tty, fit);
  const timeoutMinutes = await pickTimeout(flags, tty, strategy);
  const name = flags.name ?? (tty ? await input({ message: 'Deployment name', default: defaultDeploymentName(workload) }) : defaultDeploymentName(workload));

  const plan: DeployPlan = {
    name: name.trim(),
    workload,
    jobDefinition,
    gpu,
    timeoutMinutes,
    replicas,
    strategy,
    schedule: flags.schedule,
    rotationTime: flags.rotationTime !== undefined ? Number(flags.rotationTime) : undefined,
    startupTimeoutMinutes: flags.startupTimeout !== undefined ? parseIntStrict(flags.startupTimeout, '--startup-timeout') : undefined,
    confidential: Boolean(flags.confidential),
    sshPublicKeys: flags.sshKey,
  };
  validatePlan(plan);

  const { warnings, blocking } = assessPlan(plan, fit, available);
  for (const warning of warnings) out(`${sym.warn} ${warning}`);
  if (blocking.length && !flags.force && !tty) throw new CliError('Refusing to deploy with the warnings above. Add --force to override.', 2);

  printPlan(plan, available, resolved, start, out);
  if (!flags.yes) {
    if (!tty) throw new CliError('Add --yes to confirm the plan when not running interactively.', 2);
    const proceed = await confirm({ message: blocking.length ? 'Deploy despite the warnings?' : start ? 'Create and start this deployment?' : 'Create this deployment as a draft?', default: !blocking.length });
    if (!proceed) {
      out('Aborted. Nothing was created.');
      return;
    }
  }

  const deployment: ApiDeployment = await createDeployment(client, plan);
  out(`\n${sym.ok} Created deployment ${pc.bold(deployment.id)} (${deployment.status})`);
  if (start) {
    await deployment.start();
    out(`${sym.ok} Started`);
  }
  out(`${sym.info} Dashboard: ${dashboardUrl(deployment.id, options.network)}`);

  if (!wait) {
    if (options.json) printJson({ deployment: deployment.id, status: start ? 'STARTING' : deployment.status, dashboard: dashboardUrl(deployment.id, options.network) });
    else if (start) console.log(`   Follow it with: nosana-deploy deploy watch ${deployment.id}`);
    else console.log(`   Start it with:  nosana-deploy deploy start ${deployment.id} --wait`);
    return;
  }

  out(`\nWaiting up to ${fmtMinutes(waitMinutes)} for the workload to come online. Ctrl+C only stops watching; the deployment keeps running.`);
  const outcome = await waitForDeployment(client, deployment.id, { timeoutMinutes: waitMinutes, network: options.network, replayEvents: true, quiet: Boolean(options.json) });
  const code = await reportOutcome(outcome, options);
  if (code !== 0) throw new CliError(`Deployment ${deployment.id} did not come up (status ${outcome.deployment.status}).`, code);
}

export function registerRunCommand(program: Command, globals: () => GlobalOptions): void {
  addDeployFlags(
    program
      .command('run')
      .description('Guided deploy: pick a template (e.g. MiniMax H3), a GPU, a timeout, confirm the cost, then create, start and watch it come online.')
      .addHelpText(
        'after',
        `
Examples:
  nosana-deploy run
  nosana-deploy run --template minimax-h3 --variant i2v-32gb --gpu nvidia-5090 --timeout 120
  nosana-deploy run --template hello-world --gpu nvidia-3060 --timeout 5 --yes
  nosana-deploy run --file my-job.json --gpu 4090 --timeout 60 --yes --json`,
      ),
    { start: true },
  ).action(async (flags: RunFlags) => runDeployFlow(globals(), flags, true, { start: true }));
}

export { summarizeDeployment };
