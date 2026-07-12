/**
 * personalChatLink — every user has a shareable link that opens a direct chat
 * with them. Format (per web-team contract):
 *   https://smilers.online/u/<USER_CONVEX_ID>
 * with a native deep-link equivalent `smilers://chat-with/<USER_CONVEX_ID>`.
 *
 * The id is the user's `users._id` (same id used by QR contact codes).
 */

// Production web domain that also serves the public /u/<id> preview page and,
// via Android App Links, hands off to the installed app.
export const PERSONAL_CHAT_LINK_BASE = 'https://smilers.online/u';

export function buildPersonalChatLink(userId: string): string {
  return `${PERSONAL_CHAT_LINK_BASE}/${encodeURIComponent(String(userId))}`;
}

export function buildPersonalChatShareMessage(
  name: string | undefined | null,
  userId: string,
): string {
  const link = buildPersonalChatLink(userId);
  const who = name && name.trim() ? name.trim() : 'me';
  return `Chat with ${who} on Smilers: ${link}`;
}
