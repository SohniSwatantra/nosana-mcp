import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliError, createClient, type GlobalOptions } from '../../core/client.js';
import { heading, printJson, sym, table } from '../../core/format.js';
import { hardwareHints, listTemplates, prepareJobDefinition, resolveTemplate, topLevelTemplates, findTemplate, NeedsVariantError } from '../../core/templates.js';

export function registerTemplateCommands(program: Command, globals: () => GlobalOptions): void {
  const templates = program.command('templates').alias('template').description('Browse the ready-to-run Nosana templates (MiniMax H3, Ollama models, ComfyUI, Jupyter, ...).');

  templates
    .command('list', { isDefault: true })
    .description('List templates. Variants (e.g. minimax-h3-i2v-32gb) are folded under their parent unless --all is given.')
    .option('--all', 'Show every variant template as its own row')
    .option('--search <text>', 'Filter by id, name or category')
    .action(async (cmd: { all?: boolean; search?: string }) => {
      const options = globals();
      const client = createClient(options);
      let all = await listTemplates(client);
      if (cmd.search) {
        const q = cmd.search.toLowerCase();
        all = all.filter((t) => t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.category.join(' ').toLowerCase().includes(q));
      }
      const rows = cmd.all ? all : topLevelTemplates(all);
      const vramLabel = (t: (typeof rows)[number]): string => {
        const values = t.variants.length
          ? t.variants.map((v) => all.find((x) => x.id === `${t.id}-${v.id}`)?.vramRequirementGb ?? null).filter((n): n is number => n !== null)
          : t.vramRequirementGb !== null
            ? [t.vramRequirementGb]
            : [];
        if (!values.length) return pc.dim('-');
        const min = Math.min(...values);
        const max = Math.max(...values);
        return min === max ? `${min} GB` : `${min} to ${max} GB`;
      };
      if (options.json) {
        printJson(rows.map(({ readme: _readme, jobDefinition: _def, ...rest }) => rest));
        return;
      }
      console.log(
        table(
          ['ID', 'Name', 'Category', 'Variants', 'VRAM'],
          rows.map((t) => [
            t.id,
            t.name,
            t.category.filter((c) => c !== 'Official').join(', '),
            t.variants.length ? t.variants.map((v) => v.id).join(', ') : pc.dim('-'),
            vramLabel(t),
          ]),
        ),
      );
      console.log(`\n${rows.length} templates. Use \`nosana-deploy templates show <id>\` for details or \`nosana-deploy run --template <id>\` to deploy one.`);
    });

  templates
    .command('show')
    .description('Show a template: variants, hardware needs, exposed ports and the job definition it deploys.')
    .argument('<id>', 'Template id or name, e.g. minimax-h3')
    .option('--variant <id>', 'Variant id, e.g. i2v-32gb')
    .option('--readme', 'Print the full README instead of a summary')
    .action(async (id: string, cmd: { variant?: string; readme?: boolean }) => {
      const options = globals();
      const client = createClient(options);
      const all = await listTemplates(client);
      const parent = findTemplate(all, id);
      if (!parent) throw new CliError(`Unknown template "${id}".`);
      let resolved;
      try {
        resolved = resolveTemplate(all, id, cmd.variant);
      } catch (error) {
        if (!(error instanceof NeedsVariantError)) throw error;
        resolved = null;
      }
      const template = resolved?.template ?? parent;
      if (options.json) {
        printJson({ parent: { ...parent, readme: undefined }, template: { ...template, readme: cmd.readme ? template.readme : undefined } });
        return;
      }
      const hints = hardwareHints(parent);
      console.log(`${pc.bold(parent.name)}  ${pc.dim(parent.id)}`);
      if (parent.description) console.log(parent.description);
      console.log(`Category: ${parent.category.join(', ')}`);
      if (parent.variants.length) {
        heading('Variants');
        console.log(table(['ID', 'Name', 'Description'], parent.variants.map((v) => [v.id, v.name, v.description ?? ''])));
        if (!resolved) console.log(`\n${sym.info} Add --variant <id> to see one variant's job definition.`);
      }
      heading('Hardware');
      console.log(`VRAM needed: ${template.vramRequirementGb ? `${template.vramRequirementGb} GB` : 'not specified'}`);
      for (const note of hints.notes) console.log(`${sym.warn} ${note}`);
      if (resolved) {
        heading(`Job definition (${resolved.id})`);
        console.log(JSON.stringify(prepareJobDefinition(resolved.jobDefinition), null, 2));
      }
      if (cmd.readme && parent.readme) {
        heading('README');
        console.log(parent.readme);
      }
    });

  templates
    .command('export')
    .description('Write a template job definition to a file so you can customise it and deploy with --file.')
    .argument('<id>', 'Template id, e.g. minimax-h3')
    .option('--variant <id>', 'Variant id, e.g. i2v-32gb')
    .option('-o, --output <file>', 'Output path (defaults to <template-id>.json)')
    .action(async (id: string, cmd: { variant?: string; output?: string }) => {
      const options = globals();
      const client = createClient(options);
      const resolved = resolveTemplate(await listTemplates(client), id, cmd.variant);
      const target = path.resolve(cmd.output ?? `${resolved.id}.json`);
      fs.writeFileSync(target, `${JSON.stringify(prepareJobDefinition(resolved.jobDefinition), null, 2)}\n`);
      console.log(`${sym.ok} Wrote ${target}`);
      console.log(`Deploy it with: nosana-deploy run --file ${path.relative(process.cwd(), target) || target} --gpu <slug>`);
    });
}
