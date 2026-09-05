import { password } from '@inquirer/prompts';
import type { Command } from 'commander';
import { CliError, createClient, type CreditsBalance, type GlobalOptions } from '../../core/client.js';
import { CONFIG_FILE, clearConfig, isInteractive, maskKey, readConfig, resolveApiKey, writeConfig } from '../../core/config.js';
import { formatError, pageSize, printJson, sym, table, withTimeout } from '../../core/format.js';

import { availableCredits, summarizeBalance } from '../../core/credits.js';

export { availableCredits };

export function balanceTable(balance: CreditsBalance): string {
  const b = summarizeBalance(balance);
  return table(
    ['Assigned', 'Reserved', 'Settled', 'Available'],
    [[b.assigned.toFixed(3), b.reserved.toFixed(3), b.settled.toFixed(3), b.available.toFixed(3)]],
  );
}

export async function loginInteractive(options: GlobalOptions, provided?: string): Promise<string> {
  let key = provided?.trim();
  if (!key) {
    if (!isInteractive()) throw new CliError('Pass --key <apiKey> or set NOSANA_API_KEY when not running in a terminal.', 2);
    console.log('Create an API key at https://deploy.nosana.com (Account > API Keys) and paste it below.');
    key = (await password({ message: 'Nosana API key', mask: '*' })).trim();
  }
  if (!key) throw new CliError('Empty API key.', 2);
  const client = createClient(options, key);
  let balance: CreditsBalance;
  try {
    balance = await client.api.credits.balance();
  } catch (error) {
    throw new CliError(`Nosana rejected the API key: ${formatError(error)}`);
  }
  writeConfig({ ...readConfig(), apiKey: key, network: options.network });
  console.log(`${sym.ok} API key ${maskKey(key)} verified and saved to ${CONFIG_FILE}`);
  console.log(balanceTable(balance));
  return key;
}

export function registerAccountCommands(program: Command, globals: () => GlobalOptions): void {
  program
    .command('login')
    .description('Verify a Nosana API key and store it in ~/.config/nosana-deploy/config.json.')
    .option('--key <apiKey>', 'API key (prompted when omitted)')
    .action(async (cmd: { key?: string }) => {
      const options = globals();
      await loginInteractive(options, cmd.key ?? options.apiKey);
    });

  program
    .command('logout')
    .description('Remove the stored API key.')
    .action(() => {
      console.log(clearConfig() ? `${sym.ok} Removed ${CONFIG_FILE}` : `${sym.info} No stored credentials at ${CONFIG_FILE}`);
    });

  program
    .command('balance')
    .description('Show the credit balance of the account behind the API key.')
    .action(async () => {
      const options = globals();
      const client = createClient(options);
      const balance = await client.api.credits.balance();
      if (options.json) {
        printJson({ ...(balance as object), availableCredits: availableCredits(balance) });
        return;
      }
      console.log(balanceTable(balance));
      console.log(`\nTop up at https://deploy.nosana.com (Billing) with a card or crypto.`);
    });

  program
    .command('doctor')
    .description('Check Node.js, the API key, and connectivity to every Nosana API this CLI uses.')
    .action(async () => {
      const options = globals();
      const checks: { name: string; ok: boolean; detail: string; critical: boolean }[] = [];
      const run = async (name: string, critical: boolean, fn: () => Promise<string>): Promise<void> => {
        try {
          checks.push({ name, ok: true, detail: await fn(), critical });
        } catch (error) {
          checks.push({ name, ok: false, detail: formatError(error), critical });
        }
      };

      const major = Number(process.versions.node.split('.')[0]);
      checks.push({ name: 'Node.js', ok: major >= 20, detail: `v${process.versions.node}${major >= 20 ? '' : ' (need 20 or newer)'}`, critical: true });

      const resolved = resolveApiKey(options.apiKey);
      checks.push({
        name: 'API key',
        ok: Boolean(resolved),
        detail: resolved ? `${maskKey(resolved.key)} (from ${resolved.source})` : 'missing: run `nosana-deploy login`',
        critical: true,
      });

      if (resolved) {
        const client = createClient(options, resolved.key);
        await run('Credits API', true, async () => `${availableCredits(await client.api.credits.balance()).toFixed(3)} credits available`);
        await run('Markets API', true, async () => `${((await client.api.markets.list()) as unknown[]).length} GPU markets`);
        await run('Templates API', true, async () => `${((await client.api.templates.list()) as unknown[]).length} templates`);
        await run('Host availability', false, async () => `${((await client.api.hosts.getQueuedNodes()) as unknown as unknown[]).length} idle hosts network-wide`);
        await run('Deployments API', true, async () => `${(await client.api.deployments.list({ limit: pageSize(10) })).total_items} deployments on this account`);
        await run('Solana RPC (optional, for --queue)', false, async () => `${(await withTimeout(client.jobs.markets(), 15_000, 'RPC read')).length} on-chain markets`);
      }

      if (options.json) {
        printJson(checks);
      } else {
        for (const check of checks) {
          const marker = check.ok ? sym.ok : check.critical ? sym.err : sym.warn;
          console.log(`${marker} ${check.name.padEnd(36)} ${check.detail}`);
        }
      }
      if (checks.some((c) => !c.ok && c.critical)) throw new CliError('Some critical checks failed.');
    });
}
