const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeCreditCode(value: string): string {
  return (value || '')
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, '')
    .replace(/[IO]/g, '')
    .replace(/[10]/g, '');
}

export function formatCreditCode(value: string): string {
  const raw = normalizeCreditCode(value).slice(0, 9);
  const chunks = raw.match(/.{1,3}/g) || [];
  return chunks.join('-');
}

export function estimateClicks(amountEur: number): number {
  if (!Number.isFinite(amountEur) || amountEur <= 0) return 0;
  return Math.floor(amountEur / 0.06);
}

export function isLikelyFormattedCreditCode(value: string): boolean {
  const normalized = normalizeCreditCode(value);
  return normalized.length === 9 && normalized.split('').every((char) => CODE_CHARS.includes(char));
}
