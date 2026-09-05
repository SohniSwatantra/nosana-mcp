import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Network = 'mainnet' | 'devnet';

export interface StoredConfig {
  apiKey?: string;
  network?: Network;
  rpc?: string;
}

export const CONFIG_DIR =
  process.env.NOSANA_DEPLOY_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'nosana-deploy');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function readConfig(): StoredConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: StoredConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

export function clearConfig(): boolean {
  try {
    fs.unlinkSync(CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

export type ApiKeySource = 'flag' | 'env' | 'config';

export function resolveApiKey(explicit?: string): { key: string; source: ApiKeySource } | undefined {
  if (explicit) return { key: explicit, source: 'flag' };
  if (process.env.NOSANA_API_KEY) return { key: process.env.NOSANA_API_KEY, source: 'env' };
  const stored = readConfig().apiKey;
  if (stored) return { key: stored, source: 'config' };
  return undefined;
}

export function maskKey(key: string): string {
  if (key.length <= 12) return '****';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
