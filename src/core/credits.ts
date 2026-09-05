import type { CreditsBalance } from './client.js';

type BalanceLike = { assignedCredits: number; reservedCredits: number; settledCredits: number };

export interface BalanceSummary {
  assigned: number;
  reserved: number;
  settled: number;
  available: number;
}

export function summarizeBalance(balance: CreditsBalance): BalanceSummary {
  const b = balance as unknown as BalanceLike;
  const assigned = b.assignedCredits ?? 0;
  const reserved = b.reservedCredits ?? 0;
  const settled = b.settledCredits ?? 0;
  return { assigned, reserved, settled, available: assigned - reserved - settled };
}

export const availableCredits = (balance: CreditsBalance): number => summarizeBalance(balance).available;
