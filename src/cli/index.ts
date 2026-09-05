#!/usr/bin/env node
import { createRequire } from 'node:module';
import { Command, Option } from 'commander';
import { CliError, type GlobalOptions } from '../core/client.js';
import { formatError, sym } from '../core/format.js';
import { registerAccountCommands } from './commands/account.js';
import { registerDeployCommands } from './commands/deploy.js';
import { registerGpuCommands } from './commands/gpus.js';
import { registerJobCommands } from './commands/job.js';
import { registerRunCommand } from './commands/run.js';
import { registerTemplateCommands } from './commands/templates.js';

const { version: VERSION } = createRequire(import.meta.url)('../../package.json') as { version: string };

const program = new Command()
  .name('nosana-deploy')
  .description('Nosana Deploy CLI (part of Nosana MCP): deploy GPU workloads on Nosana with account credits. Pick a template such as MiniMax H3, choose a GPU, run it.')
  .version(VERSION)
  .addOption(new Option('-n, --network <network>', 'Nosana network').choices(['mainnet', 'devnet']).default('mainnet'))
  .option('--api-key <key>', 'Nosana API key (defaults to NOSANA_API_KEY or the key saved by `login`)')
  .option('--rpc <url>', 'Solana RPC URL, only used for optional on-chain queue reads')
  .option('--json', 'Machine-readable JSON output')
  .showHelpAfterError('(add --help for usage)')
  .addHelpText(
    'after',
    `
Quick start:
  nosana-deploy login                      store your API key from deploy.nosana.com
  nosana-deploy templates list             see what you can run (MiniMax H3, Qwen, ComfyUI, Jupyter, ...)
  nosana-deploy gpus --template minimax-h3 --variant i2v-32gb
  nosana-deploy run                        guided: template -> GPU -> timeout -> confirm -> live status
  nosana-deploy deploy list                everything you have deployed
  nosana-deploy deploy stop <id>           stop paying for a running deployment`,
  );

const globals = (): GlobalOptions => program.opts<GlobalOptions>();

registerAccountCommands(program, globals);
registerTemplateCommands(program, globals);
registerGpuCommands(program, globals);
registerRunCommand(program, globals);
registerDeployCommands(program, globals);
registerJobCommands(program, globals);

program.parseAsync().catch((error: unknown) => {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    console.error('\nCancelled.');
    process.exit(130);
  }
  console.error(`${sym.err} ${formatError(error)}`);
  process.exit(error instanceof CliError ? error.exitCode : 1);
});
