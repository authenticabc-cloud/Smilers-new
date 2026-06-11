/**
 * inviteLink (iter-186) — single source of truth for "join Smilers"
 * invitation links. Per user requirement, all invites now point to the
 * PUBLISHED PLAY STORE LISTING so recipients land directly on the
 * download page, and the inviter's referral code rides along:
 *
 *  1. In the URL via the Play `referrer` parameter (delivered to the app
 *     by the Play Install Referrer API on first launch after install —
 *     ready for automated attribution).
 *  2. Spelled out in the message text ("Use my referral code X when you
 *     sign up") so the code is counted even when the new user types it
 *     manually at signup — this is how earnings referrals are credited
 *     today (matches the web app behavior).
 */
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.smilers.app';

export function buildInviteUrl(referralCode?: string | null): string {
  const code = (referralCode || '').toString().trim();
  if (!code) return PLAY_STORE_URL;
  return `${PLAY_STORE_URL}&referrer=${encodeURIComponent(`ref=${code}`)}`;
}

export function buildInviteMessage(referralCode?: string | null): string {
  const code = (referralCode || '').toString().trim();
  const url = buildInviteUrl(code);
  return code
    ? `Join me on Smilers! Use my referral code ${code} when you sign up. Download the app: ${url}`
    : `Join me on Smilers — a smarter, safer messenger. Download the app: ${url}`;
}
