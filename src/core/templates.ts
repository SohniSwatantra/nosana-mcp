import type { JobDefinition, NosanaClient } from '@nosana/kit';
import { CliError } from './client.js';

export interface TemplateVariant {
  id: string;
  name: string;
  description?: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description?: string;
  category: string[];
  icon?: string;
  readme: string;
  jobDefinition: JobDefinition | null;
  vramRequirementGb: number | null;
  cudaRequirement: string | null;
  isVariant: boolean;
  parentId: string | null;
  variants: TemplateVariant[];
}

interface RawTemplate {
  id: string;
  name: string;
  description?: string;
  jobDefinition?: unknown;
  icon?: string;
  readme?: string;
  category?: string | string[];
  vram_requirement?: number | string | null;
  cuda_requirement?: string | null;
  is_variant_template?: boolean;
  parent_template_id?: string | null;
  variants?: { id: string; name: string; description?: string }[] | null;
}

type MetaWithRequirements = { meta?: { system_requirements?: { vram_total_mb?: number } } };

function vramFrom(raw: RawTemplate, definition: JobDefinition | null): number | null {
  const mb = (definition as MetaWithRequirements | null)?.meta?.system_requirements?.vram_total_mb;
  if (typeof mb === 'number' && mb > 0) return Math.ceil(mb / 1024);
  if (raw.vram_requirement !== null && raw.vram_requirement !== undefined) {
    const n = Number(String(raw.vram_requirement).replace(/[^\d.]/g, ''));
    if (Number.isFinite(n) && n > 0) return n > 512 ? Math.ceil(n / 1024) : n;
  }
  return null;
}

function normalize(raw: RawTemplate): TemplateInfo {
  const jobDefinition =
    raw.jobDefinition && typeof raw.jobDefinition === 'object' ? (raw.jobDefinition as JobDefinition) : null;
  const category = Array.isArray(raw.category)
    ? raw.category
    : String(raw.category ?? '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    category,
    icon: raw.icon,
    readme: raw.readme ?? '',
    jobDefinition,
    vramRequirementGb: vramFrom(raw, jobDefinition),
    cudaRequirement: raw.cuda_requirement ?? null,
    isVariant: Boolean(raw.is_variant_template),
    parentId: raw.parent_template_id ?? null,
    variants: Array.isArray(raw.variants)
      ? raw.variants.map((v) => ({ id: v.id, name: v.name, description: v.description }))
      : [],
  };
}

export async function listTemplates(client: NosanaClient): Promise<TemplateInfo[]> {
  const raw = (await client.api.templates.list()) as unknown;
  return (Array.isArray(raw) ? (raw as RawTemplate[]) : []).map(normalize);
}

export const topLevelTemplates = (all: TemplateInfo[]): TemplateInfo[] => all.filter((t) => !t.isVariant);

export interface ResolvedTemplate {
  parent: TemplateInfo;
  variant: TemplateVariant | null;
  template: TemplateInfo;
  jobDefinition: JobDefinition;
  /** Identifier used for names and logs, e.g. "minimax-h3-i2v-32gb". */
  id: string;
}

export class NeedsVariantError extends CliError {
  constructor(readonly template: TemplateInfo) {
    super(
      [
        `Template "${template.id}" has ${template.variants.length} variants. Pick one with --variant <id>:`,
        ...template.variants.map(
          (v) => `  ${v.id.padEnd(14)} ${v.name}${v.description ? `  (${v.description})` : ''}`,
        ),
      ].join('\n'),
      2,
    );
    this.name = 'NeedsVariantError';
  }
}

export function findTemplate(all: TemplateInfo[], query: string): TemplateInfo | undefined {
  const q = query.trim().toLowerCase();
  return (
    all.find((t) => t.id.toLowerCase() === q) ??
    all.find((t) => t.name.toLowerCase() === q) ??
    topLevelTemplates(all).find((t) => t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
  );
}

export function findVariant(template: TemplateInfo, variantId: string): TemplateVariant | undefined {
  const vq = variantId.trim().toLowerCase();
  return (
    template.variants.find((v) => v.id.toLowerCase() === vq) ??
    template.variants.find((v) => v.name.toLowerCase() === vq) ??
    template.variants.find((v) => `${template.id}-${v.id}`.toLowerCase() === vq)
  );
}

function finish(parent: TemplateInfo, variant: TemplateVariant | null, template: TemplateInfo): ResolvedTemplate {
  if (!template.jobDefinition) {
    throw new CliError(`Template "${template.id}" has no job definition to deploy.`);
  }
  return { parent, variant, template, jobDefinition: template.jobDefinition, id: template.id };
}

export function resolveVariant(all: TemplateInfo[], parent: TemplateInfo, variant: TemplateVariant): ResolvedTemplate {
  const variantTemplate = all.find((t) => t.id === `${parent.id}-${variant.id}`);
  if (!variantTemplate) {
    throw new CliError(`Variant template "${parent.id}-${variant.id}" was not returned by the templates API.`);
  }
  return finish(parent, variant, variantTemplate);
}

export function resolveTemplate(all: TemplateInfo[], query: string, variantId?: string): ResolvedTemplate {
  const found = findTemplate(all, query);
  if (!found) {
    throw new CliError(`Unknown template "${query}". Run \`nosana-deploy templates list\` to see what is available.`);
  }
  if (found.isVariant) {
    const parent = all.find((t) => t.id === found.parentId) ?? found;
    const variant = parent.variants.find((v) => `${parent.id}-${v.id}` === found.id) ?? null;
    return finish(parent, variant, found);
  }
  if (found.variants.length > 0) {
    if (variantId) {
      const variant = findVariant(found, variantId);
      if (!variant) {
        throw new CliError(
          `Template "${found.id}" has no variant "${variantId}". Available: ${found.variants.map((v) => v.id).join(', ')}`,
          2,
        );
      }
      return resolveVariant(all, found, variant);
    }
    if (found.variants.length === 1) return resolveVariant(all, found, found.variants[0]);
    throw new NeedsVariantError(found);
  }
  if (variantId) throw new CliError(`Template "${found.id}" has no variants; drop --variant.`, 2);
  return finish(found, null, found);
}

/** Copy the template definition and mark it as submitted from the CLI. */
export function prepareJobDefinition(definition: JobDefinition, trigger: 'cli' | 'mcp' = 'cli'): JobDefinition {
  const clone = JSON.parse(JSON.stringify(definition)) as JobDefinition & { meta?: Record<string, unknown> };
  clone.meta = { ...(clone.meta ?? {}), trigger };
  return clone;
}

export interface HardwareHints {
  blackwellOnly: boolean;
  minDriver: string | null;
  notes: string[];
}

export function hardwareHints(template: TemplateInfo): HardwareHints {
  const text = `${template.readme}\n${template.description ?? ''}`;
  const blackwellOnly = /blackwell/i.test(text);
  const driver = /r(\d{3})\+?\s*driver/i.exec(text);
  const weights = /(\d+)\s*[-–]\s*(\d+)\s*GB of weights/i.exec(text);
  const notes: string[] = [];
  if (blackwellOnly) notes.push('Needs a Blackwell GPU (RTX 5090 or RTX PRO 6000); older cards cannot run the nvfp4 weights.');
  if (driver) notes.push(`The host needs NVIDIA driver r${driver[1]} or newer.`);
  if (weights) notes.push(`First start downloads ${weights[1]} to ${weights[2]} GB of weights, so expect a long startup.`);
  return { blackwellOnly, minDriver: driver ? `r${driver[1]}` : null, notes };
}

export const isBlackwell = (name: string, slug: string): boolean =>
  /\b50\d0\b|pro.?6000|rtx.?pro|b200|b100|gb200/i.test(`${name} ${slug}`);

export function exposesPorts(definition: JobDefinition): boolean {
  const ops = (definition as { ops?: { args?: { expose?: unknown } }[] }).ops ?? [];
  return ops.some((op) => op.args?.expose !== undefined && op.args.expose !== null);
}

export function vramFromDefinition(definition: JobDefinition): number | null {
  const mb = (definition as MetaWithRequirements).meta?.system_requirements?.vram_total_mb;
  return typeof mb === 'number' && mb > 0 ? Math.ceil(mb / 1024) : null;
}
