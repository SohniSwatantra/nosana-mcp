import fs from 'node:fs';
import path from 'node:path';
import { confirm } from '@inquirer/prompts';
import { validateJobDefinition, type JobDefinition } from '@nosana/kit';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliError, createClient, type ApiDeployment, type GlobalOptions } from '../../core/client.js';
import { isInteractive } from '../../core/config.js';
import { dashboardUrl, deploymentsTable, explorerJobUrl, formatJobResult, normalizeJobState, summarizeDeployment, waitForDeployment } from '../../core/deploy.js';
import { fmtDate, pageSize, parseIntStrict, printJson, short, sleep, statusColor, sym, table } from '../../core/format.js';
import { addDeployFlags, DEFAULT_WAIT_MINUTES, runDeployFlow, type RunFlags } from './run.js';

const DELETABLE_STATUSES = new Set(['STOPPED', 'ERROR', 'INSUFFICIENT_FUNDS', 'ARCHIVED']);

async function confirmDestructive(action: string, id: string, yes: boolean | undefined): Promise<void> {
  if (yes) return;
  if (!isInteractive()) throw new CliError(`Add --yes to ${action} ${id} without a prompt.`, 2);
  const ok = await confirm({ message: `Really ${action} deployment ${id}?`, default: false });
  if (!ok) throw new CliError('Aborted.', 130);
}

async function watch(client: ReturnType<typeof createClient>, id: string, minutes: number, options: GlobalOptions): Promise<void> {
  console.log(`Watching ${id} for up to ${minutes} min. Ctrl+C only stops watching.`);
  const outcome = await waitForDeployment(client, id, { timeoutMinutes: minutes, network: options.network, quiet: Boolean(options.json) });
  const dep = outcome.deployment;
  if (options.json) {
    printJson({ outcome: outcome.kind, deployment: dep.id, status: dep.status, endpoints: dep.endpoints, ...(outcome.kind === 'online' ? { readyUrls: outcome.readyUrls } : {}) });
  } else {
    console.log();
    if (outcome.kind === 'online') {
      console.log(`${sym.ok} Online and answering:`);
      for (const e of dep.endpoints.filter((x) => outcome.readyUrls.includes(x.url))) console.log(`   ${e.url}  (${e.opId}:${e.port})`);
    } else if (outcome.kind === 'completed') {
      console.log(`${sym.ok} Job ${outcome.job} completed. ${explorerJobUrl(outcome.job, options.network)}`);
      try {
        for (const line of formatJobResult((await dep.getJob(outcome.job)).jobResult)) console.log(`   ${line}`);
      } catch {
        /* results may lag */
      }
    } else if (outcome.kind === 'failed') {
      if (outcome.error) console.log(`${sym.err} Scheduler error: ${outcome.error}`);
      console.log(`${sym.err} Deployment is ${statusColor(outcome.reason)}. See: nosana-deploy deploy events ${dep.id}${outcome.error ? ` and stop it with: nosana-deploy deploy stop ${dep.id}` : ''}`);
    } else {
      console.log(`${sym.warn} Watch window elapsed; deployment status is ${statusColor(dep.status)}. Run the command again to keep watching.`);
    }
  }
  if (outcome.kind === 'failed') throw new CliError(`Deployment ${dep.id} is ${dep.status}.`);
}

export function registerDeployCommands(program: Command, globals: () => GlobalOptions): void {
  const deploy = program.command('deploy').alias('deployments').description('Create and manage deployments (the same objects you see on deploy.nosana.com).');

  addDeployFlags(
    deploy
      .command('create')
      .description('Create a deployment from flags (non-interactive). Add --start to start it and --yes to skip the confirmation.'),
    { start: false },
  ).action(async (flags: RunFlags) => runDeployFlow(globals(), flags, false, { start: false }));

  deploy
    .command('list', { isDefault: true })
    .description('List deployments on this account.')
    .option('--limit <count>', 'Page size (10, 20, 50 or 100)', '20')
    .option('--status <status>', 'Filter by status, e.g. RUNNING or STOPPED,ERROR')
    .option('--search <text>', 'Filter by partial id or name')
    .action(async (cmd: { limit: string; status?: string; search?: string }) => {
      const options = globals();
      const client = createClient(options);
      const result = await client.api.deployments.list({
        limit: pageSize(parseIntStrict(cmd.limit, '--limit')),
        ...(cmd.status ? { status: cmd.status.toUpperCase() } : {}),
        ...(cmd.search ? { search: cmd.search } : {}),
      });
      const deployments = result.deployments as ApiDeployment[];
      if (options.json) {
        printJson({ total_items: result.total_items, deployments });
        return;
      }
      if (!deployments.length) {
        console.log('No deployments found. Create one with `nosana-deploy run`.');
        return;
      }
      console.log(deploymentsTable(deployments));
      console.log(`\n${deployments.length} of ${result.total_items} deployments shown.`);
    });

  deploy
    .command('get')
    .alias('show')
    .description('Show one deployment with its endpoints.')
    .argument('<id>', 'Deployment id')
    .action(async (id: string) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      if (options.json) printJson(dep);
      else console.log(summarizeDeployment(dep, options.network).join('\n'));
    });

  deploy
    .command('start')
    .description('Start a draft or stopped deployment.')
    .argument('<id>', 'Deployment id')
    .option('--wait', 'Watch until the workload is online or the job completes')
    .option('--wait-timeout <minutes>', 'How long to watch', String(DEFAULT_WAIT_MINUTES))
    .action(async (id: string, cmd: { wait?: boolean; waitTimeout: string }) => {
      const options = globals();
      const client = createClient(options);
      const dep = (await client.api.deployments.get(id)) as ApiDeployment;
      await dep.start();
      console.log(`${sym.ok} Started ${id}. Dashboard: ${dashboardUrl(id, options.network)}`);
      if (cmd.wait) await watch(client, id, parseIntStrict(cmd.waitTimeout, '--wait-timeout'), options);
    });

  deploy
    .command('stop')
    .description('Stop a deployment and its running jobs (billing stops with them).')
    .argument('<id>', 'Deployment id')
    .action(async (id: string) => {
      const options = globals();
      const client = createClient(options);
      const dep = (await client.api.deployments.get(id)) as ApiDeployment;
      await dep.stop();
      const after = (await client.api.deployments.get(id)) as ApiDeployment;
      if (options.json) printJson({ id, status: after.status });
      else console.log(`${sym.ok} Stop requested for ${id}; status is now ${statusColor(after.status)}.`);
    });

  deploy
    .command('watch')
    .description('Follow a deployment until its endpoint is online or its job completes.')
    .argument('<id>', 'Deployment id')
    .option('--wait-timeout <minutes>', 'How long to watch', String(DEFAULT_WAIT_MINUTES))
    .action(async (id: string, cmd: { waitTimeout: string }) => {
      const options = globals();
      await watch(createClient(options), id, parseIntStrict(cmd.waitTimeout, '--wait-timeout'), options);
    });

  deploy
    .command('jobs')
    .description('List the jobs a deployment has run.')
    .argument('<id>', 'Deployment id')
    .option('--limit <count>', 'Page size', '20')
    .action(async (id: string, cmd: { limit: string }) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      const result = await dep.getJobs({ limit: pageSize(parseIntStrict(cmd.limit, '--limit')) });
      const jobs = result.jobs as { job: string; state: unknown; node?: string | null; revision?: number; created_at?: string; time_start?: number }[];
      if (options.json) {
        printJson(result.jobs);
        return;
      }
      if (!jobs.length) {
        console.log('No jobs yet.');
        return;
      }
      console.log(
        table(
          ['Job', 'State', 'Host', 'Rev', 'Created', 'Started'],
          jobs.map((j) => [j.job, statusColor(normalizeJobState(j.state)), j.node ? short(j.node, 6) : '-', String(j.revision ?? '-'), fmtDate(j.created_at), j.time_start ? fmtDate(j.time_start) : '-']),
        ),
      );
    });

  deploy
    .command('events')
    .description('Show the deployment event log (scheduling, starts, stops, errors).')
    .argument('<id>', 'Deployment id')
    .option('--limit <count>', 'Page size', '50')
    .action(async (id: string, cmd: { limit: string }) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      const result = await dep.getEvents({ limit: pageSize(parseIntStrict(cmd.limit, '--limit')), sort_order: 'desc' });
      const events = result.events as { type?: string; event?: string; message?: string; created_at?: string; category?: string }[];
      if (options.json) {
        printJson(result.events);
        return;
      }
      if (!events.length) {
        console.log('No events yet.');
        return;
      }
      for (const e of [...events].reverse()) console.log(`${pc.dim(fmtDate(e.created_at))}  ${pc.bold(e.type ?? e.event ?? '')}  ${e.message ?? ''}`);
    });

  deploy
    .command('result')
    .description('Print the logs/results of a deployment job (latest job by default).')
    .argument('<id>', 'Deployment id')
    .option('--job <address>', 'Specific job address')
    .action(async (id: string, cmd: { job?: string }) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      let jobAddress = cmd.job;
      if (!jobAddress) {
        const jobs = (await dep.getJobs({ limit: 10 })).jobs as { job: string }[];
        if (!jobs.length) throw new CliError('This deployment has not run any job yet.');
        jobAddress = jobs[0].job;
      }
      const job = await dep.getJob(jobAddress);
      if (options.json) {
        printJson(job);
        return;
      }
      console.log(`Job ${jobAddress}  state ${statusColor(normalizeJobState(job.state))}  host ${job.node ?? '-'}  ${explorerJobUrl(jobAddress, options.network)}`);
      for (const line of formatJobResult(job.jobResult)) console.log(line);
    });

  deploy
    .command('extend')
    .description('Change the timeout (minutes) of a deployment.')
    .argument('<id>', 'Deployment id')
    .requiredOption('--timeout <minutes>', 'New timeout in minutes')
    .action(async (id: string, cmd: { timeout: string }) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      await dep.updateTimeout(parseIntStrict(cmd.timeout, '--timeout'));
      console.log(`${sym.ok} Timeout of ${id} set to ${cmd.timeout} min.`);
    });

  deploy
    .command('scale')
    .description('Change the replica count of a deployment.')
    .argument('<id>', 'Deployment id')
    .requiredOption('--replicas <count>', 'New replica count')
    .action(async (id: string, cmd: { replicas: string }) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      await dep.updateReplicaCount(parseIntStrict(cmd.replicas, '--replicas'));
      console.log(`${sym.ok} Replicas of ${id} set to ${cmd.replicas}.`);
    });

  deploy
    .command('rename')
    .description('Rename a deployment.')
    .argument('<id>', 'Deployment id')
    .requiredOption('--name <name>', 'New name')
    .action(async (id: string, cmd: { name: string }) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      await dep.updateName(cmd.name);
      console.log(`${sym.ok} Renamed ${id} to "${cmd.name}".`);
    });

  deploy
    .command('revision')
    .description('Upload a new job definition revision and make it active.')
    .argument('<id>', 'Deployment id')
    .requiredOption('-f, --file <path>', 'Job definition JSON')
    .action(async (id: string, cmd: { file: string }) => {
      const options = globals();
      const parsed = JSON.parse(fs.readFileSync(path.resolve(cmd.file), 'utf8')) as unknown;
      const validation = validateJobDefinition(parsed);
      if (!validation.success) throw new CliError(`Invalid job definition:\n${JSON.stringify(validation.errors, null, 2)}`, 2);
      const client = createClient(options);
      const dep = (await client.api.deployments.get(id)) as ApiDeployment;
      await dep.createRevision(parsed as JobDefinition);
      const after = (await client.api.deployments.get(id)) as ApiDeployment;
      console.log(`${sym.ok} New revision uploaded; active revision is now ${after.active_revision}. Restart the deployment to roll it out.`);
    });

  deploy
    .command('auth-header')
    .description('Print the Authorization header that grants access to a confidential deployment endpoint.')
    .argument('<id>', 'Deployment id')
    .action(async (id: string) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      const header = await dep.generateAuthHeader();
      if (options.json) printJson({ id, authorization: header });
      else console.log(`Authorization: ${header}`);
    });

  deploy
    .command('archive')
    .description('Archive a stopped deployment (hides it from the list).')
    .argument('<id>', 'Deployment id')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id: string, cmd: { yes?: boolean }) => {
      const options = globals();
      const dep = (await createClient(options).api.deployments.get(id)) as ApiDeployment;
      await confirmDestructive('archive', id, cmd.yes);
      await dep.archive();
      console.log(`${sym.ok} Archived ${id}.`);
    });

  deploy
    .command('delete')
    .description('Delete a deployment permanently (stops it first if it is still running; drafts must be started and stopped once).')
    .argument('<id>', 'Deployment id')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id: string, cmd: { yes?: boolean }) => {
      const options = globals();
      const client = createClient(options);
      let dep = (await client.api.deployments.get(id)) as ApiDeployment;
      await confirmDestructive('delete', id, cmd.yes);
      if (dep.status === 'DRAFT') {
        throw new CliError(
          `${id} is a DRAFT. The Nosana API refuses to stop, archive or delete drafts. Start it and stop it first (\`deploy start ${id}\`, then \`deploy stop ${id}\`), or remove it on deploy.nosana.com.`,
        );
      }
      if (!DELETABLE_STATUSES.has(dep.status)) {
        await dep.stop();
        for (let attempt = 0; attempt < 12 && !DELETABLE_STATUSES.has(dep.status); attempt += 1) {
          await sleep(5000);
          dep = (await client.api.deployments.get(id)) as ApiDeployment;
        }
        if (!DELETABLE_STATUSES.has(dep.status)) {
          throw new CliError(`${id} is still ${dep.status}; wait for it to stop, then run delete again.`);
        }
        console.log(`${sym.ok} Stopped ${id}.`);
      }
      await dep.delete();
      console.log(`${sym.ok} Deleted ${id}.`);
    });
}
