import type { Command } from 'commander';
import { createClient, createPublicClient, type GlobalOptions } from '../../core/client.js';
import { resolveApiKey } from '../../core/config.js';
import { parseIntStrict, printJson } from '../../core/format.js';
import { gpuTable, loadGpuCatalog, type GpuMarket } from '../../core/markets.js';
import { hardwareHints, isBlackwell, listTemplates, resolveTemplate } from '../../core/templates.js';

export function registerGpuCommands(program: Command, globals: () => GlobalOptions): void {
  program
    .command('gpus')
    .alias('markets')
    .description('List GPU markets with price per hour and how many hosts are idle right now.')
    .option('--template <id>', 'Mark which GPUs fit a template (uses its VRAM and hardware requirements)')
    .option('--variant <id>', 'Template variant, e.g. i2v-32gb')
    .option('--vram <gb>', 'Mark which GPUs have at least this much VRAM')
    .option('--all', 'Include community and special markets, not only the premium ones the dashboard shows')
    .option('--queue', 'Also read the on-chain queues to show how many jobs are waiting per market')
    .action(async (cmd: { template?: string; variant?: string; vram?: string; all?: boolean; queue?: boolean }) => {
      const options = globals();
      const client = resolveApiKey(options.apiKey) ? createClient(options) : createPublicClient(options);
      let minVramGb: number | null = cmd.vram ? parseIntStrict(cmd.vram, '--vram') : null;
      let recommend: ((m: GpuMarket) => boolean) | undefined;
      if (cmd.template) {
        const resolved = resolveTemplate(await listTemplates(client), cmd.template, cmd.variant);
        minVramGb = minVramGb ?? resolved.template.vramRequirementGb;
        if (hardwareHints(resolved.parent).blackwellOnly) recommend = (m) => isBlackwell(m.name, m.slug);
      }
      const catalog = await loadGpuCatalog(client, { includeAll: cmd.all, onchain: cmd.queue });
      if (options.json) {
        printJson(catalog);
        return;
      }
      console.log(gpuTable(catalog, { minVramGb, recommend, showQueue: cmd.queue }));
      console.log('\nPrice/h includes the network fee, matching deploy.nosana.com. "Available" counts idle hosts waiting for work in that market.');
      if (!cmd.all) console.log('Add --all to include community markets.');
    });
}
