/**
 * chatFormat — small pure formatters shared by the chat timeline
 * components. Extracted from app/chat/[conversationId].tsx (iter-184
 * chat screen refactor) — logic unchanged.
 */

export function formatChatDayChip(ts?: number) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function isSameCalendarDay(a?: number, b?: number) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

export function isGifAsset(file?: { mimeType?: string | null; name?: string | null }) {
  const mime = (file?.mimeType || '').toLowerCase();
  const name = (file?.name || '').toLowerCase();
  return mime === 'image/gif' || name.endsWith('.gif');
}

export function formatCallDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}
