import type { Command } from 'commander';
import { createClient, type GlobalOptions } from '../../core/client.js';
import { explorerJobUrl, normalizeJobState } from '../../core/deploy.js';
import { fmtDate, printJson, statusColor } from '../../core/format.js';

export function registerJobCommands(program: Command, globals: () => GlobalOptions): void {
  const job = program.command('job').description('Look up individual jobs by address.');

  job
    .command('get')
    .description('Show a job by its address (as listed on explore.nosana.com).')
    .argument('<address>', 'Job address')
    .action(async (address: string) => {
      const options = globals();
      const client = createClient(options);
      const result = (await client.api.jobs.get(address)) as Record<string, unknown>;
      if (options.json) {
        printJson(result);
        return;
      }
      const state = normalizeJobState(result.state);
      console.log(`Job       ${address}`);
      console.log(`State     ${statusColor(state)}`);
      for (const key of ['market', 'node', 'project', 'ipfsJob', 'ipfsResult', 'timeStart', 'timeEnd', 'timeout', 'price'] as const) {
        if (result[key] !== undefined && result[key] !== null) {
          const isTimestamp = (key === 'timeStart' || key === 'timeEnd') && typeof result[key] === 'number';
          const value = isTimestamp ? fmtDate(result[key] as number) : key === 'timeout' ? `${String(result[key])} s` : String(result[key]);
          console.log(`${key.padEnd(9)} ${value}`);
        }
      }
      console.log(`Explorer  ${explorerJobUrl(address, options.network)}`);
    });
}
