import pc from 'picocolors';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

export function table(headers: string[], rows: string[][], indent = 0): string {
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? '').length)),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - stripAnsi(s).length));
  const prefix = ' '.repeat(indent);
  const render = (cells: string[]) =>
    (prefix + cells.map((c, i) => pad(c ?? '', widths[i])).join('  ')).trimEnd();
  return [
    render(headers.map((h) => pc.bold(h))),
    prefix + widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(render),
  ].join('\n');
}

export const usd = (n: number, digits = 3): string => `$${n.toFixed(digits)}`;
export const printJson = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

export const sym = {
  ok: pc.green('OK '),
  warn: pc.yellow('!  '),
  err: pc.red('ERR'),
  info: pc.cyan('>  '),
};

export const heading = (s: string): void => console.log(`\n${pc.bold(s)}`);

export function fmtDate(d: string | Date | number | undefined | null): string {
  if (d === undefined || d === null || d === '') return '-';
  const date = typeof d === 'number' ? new Date(d < 1e12 ? d * 1000 : d) : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return `${date.toISOString().replace('T', ' ').slice(0, 19)}Z`;
}

export function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function elapsed(sinceMs: number): string {
  const total = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const short = (address: string, keep = 4): string =>
  address.length > keep * 2 + 3 ? `${address.slice(0, keep)}...${address.slice(-keep)}` : address;

export function statusColor(status: string): string {
  switch (status) {
    case 'RUNNING':
    case 'COMPLETED':
      return pc.green(status);
    case 'STARTING':
    case 'QUEUED':
    case 'STOPPING':
      return pc.yellow(status);
    case 'ERROR':
    case 'INSUFFICIENT_FUNDS':
      return pc.red(status);
    case 'STOPPED':
    case 'ARCHIVED':
    case 'DRAFT':
      return pc.dim(status);
    default:
      return status;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & {
      status?: unknown;
      statusCode?: unknown;
      body?: unknown;
      data?: unknown;
      cause?: unknown;
    };
    const parts = [error.message];
    for (const key of ['status', 'statusCode'] as const) {
      if (extra[key] !== undefined && !parts[0].includes(String(extra[key]))) parts.push(`HTTP ${String(extra[key])}`);
    }
    for (const key of ['body', 'data'] as const) {
      const value = extra[key];
      if (value === undefined || value === null) continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (text && !parts[0].includes(text)) parts.push(text);
    }
    if (extra.cause instanceof Error && extra.cause.message && !parts[0].includes(extra.cause.message)) {
      parts.push(`cause: ${extra.cause.message}`);
    }
    return parts.join(' | ');
  }
  if (typeof error === 'object' && error !== null) return JSON.stringify(error);
  return String(error);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function parseIntStrict(value: string, flag: string, min = 1): number {
  const n = Number(value);
  if (!/^\d+$/.test(String(value).trim()) || !Number.isInteger(n) || n < min) {
    throw new Error(`${flag} must be a whole number >= ${min} (got "${value}").`);
  }
  return n;
}

/** Nosana list endpoints accept page sizes of 10, 20, 50 or 100 only. */
export function pageSize(requested: number): 10 | 20 | 50 | 100 {
  if (requested <= 10) return 10;
  if (requested <= 20) return 20;
  if (requested <= 50) return 50;
  return 100;
}
