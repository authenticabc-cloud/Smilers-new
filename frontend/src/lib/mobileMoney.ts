/**
 * Mobile Money shared constants — verbatim mirror of the web app's
 * convex/lib/mobileMoney.ts so the native estimate never drifts from the
 * backend. The authoritative amount always comes back from
 * api.mobileMoneyRequests.createRequest; these values only drive the ≈ estimate
 * shown before submitting and the country picker.
 */

export type MobileMoneyCountry = { code: string; name: string; currency: string };

export const MOBILE_MONEY_COUNTRIES: MobileMoneyCountry[] = [
  { code: 'KE', name: 'Kenya', currency: 'KES' },
  { code: 'GH', name: 'Ghana', currency: 'GHS' },
  { code: 'UG', name: 'Uganda', currency: 'UGX' },
  { code: 'TZ', name: 'Tanzania', currency: 'TZS' },
  { code: 'RW', name: 'Rwanda', currency: 'RWF' },
  { code: 'ZM', name: 'Zambia', currency: 'ZMW' },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR' },
  { code: 'NG', name: 'Nigeria', currency: 'NGN' },
  { code: 'CI', name: "Côte d'Ivoire", currency: 'XOF' },
  { code: 'SN', name: 'Senegal', currency: 'XOF' },
  { code: 'CM', name: 'Cameroon', currency: 'XAF' },
  { code: 'BF', name: 'Burkina Faso', currency: 'XOF' },
  { code: 'ML', name: 'Mali', currency: 'XOF' },
  { code: 'BJ', name: 'Benin', currency: 'XOF' },
  { code: 'TG', name: 'Togo', currency: 'XOF' },
  { code: 'GA', name: 'Gabon', currency: 'XAF' },
  { code: 'MW', name: 'Malawi', currency: 'MWK' },
];

/** EUR → local currency fallback rates (used only for the ≈ estimate). */
export const FALLBACK_EUR_RATES: Record<string, number> = {
  KES: 140,
  GHS: 16,
  UGX: 4100,
  TZS: 2800,
  RWF: 1500,
  ZMW: 29,
  ZAR: 20,
  NGN: 1700,
  XOF: 655,
  XAF: 655,
  MWK: 1900,
};

const ZERO_DECIMAL_CURRENCIES = ['UGX', 'RWF', 'XOF', 'XAF', 'TZS', 'MWK'];

/** Rounding rule matching the web backend exactly. */
export function roundLocalAmount(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.includes(currency)) {
    return Math.max(1, Math.round(amount));
  }
  return Math.max(1, Math.round(amount * 100) / 100);
}

/** Client-side ≈ estimate shown before submitting (authoritative value is
 *  returned by createRequest). */
export function estimateLocalAmount(eurAmount: number, currency: string): number {
  return roundLocalAmount(eurAmount * (FALLBACK_EUR_RATES[currency] ?? 1), currency);
}

export type PremiumPlan = { variantId: string; eur: number; months: number; label: string };

export const PREMIUM_PLANS: Record<string, PremiumPlan> = {
  var_premium_monthly: { variantId: 'var_premium_monthly', eur: 3, months: 1, label: 'Monthly' },
  var_premium_6months: { variantId: 'var_premium_6months', eur: 15, months: 6, label: '6 Months' },
  var_premium_yearly: { variantId: 'var_premium_yearly', eur: 24, months: 12, label: 'Yearly' },
};

export function currencyForCountry(code: string): string {
  return MOBILE_MONEY_COUNTRIES.find((c) => c.code === code)?.currency || '';
}

/** Ad-click price (EUR per paid click) — mirrors the web app. */
export const AD_CLICK_PRICE_EUR = 0.04;

/** ≈ estimate for buying `clicks` paid ad clicks, in local currency. */
export function estimateAdClicksAmount(clicks: number, currency: string): number {
  return estimateLocalAmount(clicks * AD_CLICK_PRICE_EUR, currency);
}

/** Compact money label, e.g. "KES 3,360" or "GHS 48.00". */
export function formatLocalAmount(amount: number, currency: string): string {
  const zero = ZERO_DECIMAL_CURRENCIES.includes(currency);
  const n = zero
    ? Math.round(amount).toLocaleString('en-US')
    : Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${n}`;
}
