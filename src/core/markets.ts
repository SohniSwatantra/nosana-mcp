import type { NosanaClient } from '@nosana/kit';
import pc from 'picocolors';
import { table, usd, withRetry, withTimeout } from './format.js';

export interface GpuMarket {
  slug: string;
  name: string;
  address: string;
  type: string;
  vramGb: number | null;
  basePricePerHour: number;
  feePercent: number;
  /** Price shown on deploy.nosana.com: base reward plus the network fee. */
  pricePerHour: number;
  /** Idle hosts waiting in this market's queue (the dashboard's "Available" number). */
  availableNodes: number;
  /** Jobs waiting for a host (only when the on-chain read is requested). */
  queuedJobs: number | null;
}

interface RawMarket {
  address: string;
  slug: string;
  name: string;
  type: string;
  usd_reward_per_hour: number | null;
  network_fee_percentage: number | null;
  metadata?: { key: string; value: string }[] | null;
}

interface RawQueuedNode {
  nodeAddress: string;
  marketAddress: string;
  state?: string;
}

export function parseVramGb(metadata: RawMarket['metadata']): number | null {
  const entry = metadata?.find((m) => String(m.key).toLowerCase() === 'vram');
  if (!entry) return null;
  const match = /([\d.]+)\s*(GB|MB)?/i.exec(String(entry.value));
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  return (match[2] ?? 'GB').toUpperCase() === 'MB' ? Math.round(n / 1024) : n;
}

export interface CatalogOptions {
  /** Include COMMUNITY and OTHER markets, not only the PREMIUM ones the dashboard shows. */
  includeAll?: boolean;
  /** Also read the on-chain market accounts to count jobs waiting for a host. */
  onchain?: boolean;
}

export async function loadGpuCatalog(client: NosanaClient, options: CatalogOptions = {}): Promise<GpuMarket[]> {
  const [rawMarkets, rawQueued] = await Promise.all([
    withRetry(() => client.api.markets.list()) as Promise<unknown>,
    (withRetry(() => client.api.hosts.getQueuedNodes()) as Promise<unknown>).catch(() => []),
  ]);
  const markets = (Array.isArray(rawMarkets) ? rawMarkets : []) as RawMarket[];
  const queuedNodes = (Array.isArray(rawQueued) ? rawQueued : []) as RawQueuedNode[];

  const availability = new Map<string, number>();
  for (const node of queuedNodes) {
    if (node.state && node.state !== 'QUEUED') continue;
    availability.set(node.marketAddress, (availability.get(node.marketAddress) ?? 0) + 1);
  }

  let queuedJobs: Map<string, number> | undefined;
  if (options.onchain) {
    try {
      const chain = await withTimeout(client.jobs.markets(), 20_000, 'on-chain market read');
      queuedJobs = new Map();
      for (const market of chain) {
        const queue = Array.isArray(market.queue) ? market.queue.length : 0;
        queuedJobs.set(String(market.address), Number(market.queueType) === 0 ? queue : 0);
      }
    } catch {
      queuedJobs = undefined;
    }
  }

  return markets
    .filter((m) => options.includeAll || m.type === 'PREMIUM')
    .filter((m) => typeof m.usd_reward_per_hour === 'number')
    .map((m): GpuMarket => {
      const base = m.usd_reward_per_hour ?? 0;
      const fee = m.network_fee_percentage ?? 0;
      return {
        slug: m.slug,
        name: m.name,
        address: m.address,
        type: m.type,
        vramGb: parseVramGb(m.metadata),
        basePricePerHour: base,
        feePercent: fee,
        pricePerHour: base * (1 + fee / 100),
        availableNodes: availability.get(m.address) ?? 0,
        queuedJobs: queuedJobs ? (queuedJobs.get(m.address) ?? 0) : null,
      };
    })
    .sort((a, b) => a.pricePerHour - b.pricePerHour || a.name.localeCompare(b.name));
}

/** Accepts a market address, slug ("nvidia-5090"), short form ("5090") or display name ("NVIDIA 5090"). */
export function resolveGpu(catalog: GpuMarket[], query: string): GpuMarket | undefined {
  const q = query.trim().toLowerCase();
  const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  return (
    catalog.find((m) => m.address === query.trim()) ??
    catalog.find((m) => m.slug.toLowerCase() === q) ??
    catalog.find((m) => m.name.toLowerCase() === q) ??
    catalog.find((m) => m.slug.toLowerCase() === `nvidia-${q}`) ??
    catalog.find((m) => squash(m.name) === squash(q)) ??
    catalog.find((m) => squash(m.name) === `nvidia${squash(q)}`) ??
    catalog.find((m) => m.slug.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  );
}

export function fitsVram(market: GpuMarket, minVramGb?: number | null): boolean {
  if (!minVramGb) return true;
  return market.vramGb !== null && market.vramGb >= minVramGb;
}

export interface GpuTableOptions {
  minVramGb?: number | null;
  /** Extra hardware check, e.g. "needs a Blackwell card". */
  recommend?: (market: GpuMarket) => boolean;
  showQueue?: boolean;
}

export function fitLabel(market: GpuMarket, options: GpuTableOptions): string {
  if (!fitsVram(market, options.minVramGb)) return pc.red('too little VRAM');
  if (options.recommend && !options.recommend(market)) return pc.yellow('check hardware');
  return options.minVramGb || options.recommend ? pc.green('fits') : '';
}

export function gpuTable(catalog: GpuMarket[], options: GpuTableOptions = {}): string {
  const headers = ['GPU', 'Slug', 'VRAM', 'Price/h', 'Available'];
  if (options.showQueue) headers.push('Jobs waiting');
  const showFit = Boolean(options.minVramGb || options.recommend);
  if (showFit) headers.push('Fit');
  const rows = catalog.map((m) => {
    const row = [
      m.name,
      m.slug,
      m.vramGb ? `${m.vramGb} GB` : pc.dim('?'),
      usd(m.pricePerHour),
      m.availableNodes > 0 ? pc.green(String(m.availableNodes)) : pc.dim('0'),
    ];
    if (options.showQueue) row.push(m.queuedJobs === null ? pc.dim('?') : String(m.queuedJobs));
    if (showFit) row.push(fitLabel(m, options));
    return row;
  });
  return table(headers, rows);
}

export type GpuBucketName = 'ready_now' | 'fits_but_queued' | 'idle_with_risk' | 'unsupported' | 'too_small';

export interface GpuFitRequirements {
  minVramGb?: number | null;
  /** The workload only runs on Blackwell cards (RTX 5090, RTX PRO 6000). */
  blackwellOnly?: boolean;
  isBlackwell?: (market: GpuMarket) => boolean;
}

export interface BucketedGpu {
  market: GpuMarket;
  bucket: GpuBucketName;
  risks: string[];
}

export interface GpuBuckets {
  ready_now: BucketedGpu[];
  fits_but_queued: BucketedGpu[];
  idle_with_risk: BucketedGpu[];
  unsupported: BucketedGpu[];
  too_small: BucketedGpu[];
}

/**
 * Sort GPUs the way a careful buyer would: fits and idle first, then fits but queued, then idle with a caveat.
 * Hard incompatibilities (wrong architecture, too little VRAM) are kept apart so nobody "forces" them by accident.
 */
export function bucketGpus(catalog: GpuMarket[], req: GpuFitRequirements = {}): GpuBuckets {
  const buckets: GpuBuckets = { ready_now: [], fits_but_queued: [], idle_with_risk: [], unsupported: [], too_small: [] };
  for (const market of catalog) {
    const risks: string[] = [];
    if (req.minVramGb && market.vramGb !== null && market.vramGb < req.minVramGb) {
      buckets.too_small.push({ market, bucket: 'too_small', risks: [`${market.vramGb} GB VRAM, workload needs ${req.minVramGb} GB`] });
      continue;
    }
    if (req.blackwellOnly && req.isBlackwell && !req.isBlackwell(market)) {
      buckets.unsupported.push({ market, bucket: 'unsupported', risks: ['not a Blackwell GPU; this workload will not run here'] });
      continue;
    }
    if (req.minVramGb && market.vramGb === null) risks.push('VRAM not published for this market');
    const idle = market.availableNodes > 0;
    if (risks.length) {
      if (idle) buckets.idle_with_risk.push({ market, bucket: 'idle_with_risk', risks });
      else buckets.fits_but_queued.push({ market, bucket: 'fits_but_queued', risks });
    } else if (idle) buckets.ready_now.push({ market, bucket: 'ready_now', risks });
    else buckets.fits_but_queued.push({ market, bucket: 'fits_but_queued', risks });
  }
  return buckets;
}

/** Cheapest GPU that fits and has an idle host, or null when nothing is ready right now. */
export function autoPickGpu(buckets: GpuBuckets): GpuMarket | null {
  return buckets.ready_now[0]?.market ?? null;
}
