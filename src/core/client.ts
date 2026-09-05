import { createNosanaClient, NosanaNetwork, type NosanaClient } from '@nosana/kit';
import { resolveApiKey, type Network } from './config.js';

export interface GlobalOptions {
  apiKey?: string;
  network: Network;
  rpc?: string;
  json?: boolean;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const NO_KEY_MESSAGE = [
  'No Nosana API key found.',
  '  Run `nosana-deploy login` to store one, set NOSANA_API_KEY, or pass --api-key.',
  '  Create a key at https://deploy.nosana.com (Account > API Keys).',
].join('\n');

export function requireApiKey(options: GlobalOptions): string {
  const resolved = resolveApiKey(options.apiKey);
  if (!resolved) throw new CliError(NO_KEY_MESSAGE);
  return resolved.key;
}

export function toKitNetwork(network: Network): NosanaNetwork {
  return network === 'devnet' ? NosanaNetwork.DEVNET : NosanaNetwork.MAINNET;
}

export type ClientLogLevel = 'none' | 'error';

export function createClient(
  options: GlobalOptions,
  apiKey: string = requireApiKey(options),
  logLevel: ClientLogLevel = 'error',
): NosanaClient {
  return createNosanaClient(toKitNetwork(options.network), {
    api: { apiKey },
    logLevel,
    ...(options.rpc ? { solana: { rpcEndpoint: options.rpc } } : {}),
  });
}

export function createPublicClient(options: GlobalOptions): NosanaClient {
  return createNosanaClient(toKitNetwork(options.network), {
    logLevel: 'error',
    ...(options.rpc ? { solana: { rpcEndpoint: options.rpc } } : {}),
  });
}

export type Api = NosanaClient['api'];
export type ApiDeployment = Awaited<ReturnType<Api['deployments']['get']>>;
export type CreateDeploymentBody = Parameters<Api['deployments']['create']>[0];
export type CreditsBalance = Awaited<ReturnType<Api['credits']['balance']>>;
export type { JobDefinition } from '@nosana/kit';
