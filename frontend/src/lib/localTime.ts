/**
 * localTime — derive a human "City HH:MM local time" label from an IANA
 * timezone string (e.g. "Europe/Rome" → "Rome 14:54 local time").
 *
 * Used in the 1:1 chat header so each side sees the OTHER person's city and
 * current 24-hour local time between their name and the last-seen line.
 */

/** "Europe/Rome" → "Rome"; "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function cityFromTimezone(tz?: string | null): string | null {
  if (!tz || typeof tz !== 'string') return null;
  const parts = tz.split('/');
  let city = (parts[parts.length - 1] || '').replace(/_/g, ' ').trim();
  if (!city) return null;
  // Reasonably shorten very long city names so the header stays on one line.
  if (city.length > 16) city = `${city.slice(0, 15).trimEnd()}…`;
  return city;
}

/** Current 24-hour time (HH:MM) in the given timezone, or null if invalid. */
export function localTimeInTimezone(tz?: string | null, now: Date = new Date()): string | null {
  if (!tz || typeof tz !== 'string') return null;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return null;
  }
}

/** "Rome 14:54 local time" or null when the timezone is missing/invalid. */
export function formatCityLocalTime(tz?: string | null, now: Date = new Date()): string | null {
  const city = cityFromTimezone(tz);
  const time = localTimeInTimezone(tz, now);
  if (!city || !time) return null;
  return `${city} ${time} local time`;
}

/** The device's own IANA timezone, or null if unavailable. */
export function getLocalTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** UTC offset (in minutes) for an IANA timezone at a given instant. */
function tzOffsetMinutes(tz: string, date: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    // Intl can emit hour "24" at midnight — normalise to 0.
    const hour = map.hour === '24' ? '0' : map.hour;
    const asUTC = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(hour),
      Number(map.minute),
      Number(map.second),
    );
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return null;
  }
}

/**
 * Human time difference of `peerTz` relative to `myTz`, e.g.
 * "2 hours ahead of you", "3 hours 30 min behind you", "Same time as you".
 * Returns null if either timezone is missing/invalid.
 */
export function formatTimeDifference(
  peerTz?: string | null,
  myTz?: string | null,
  now: Date = new Date(),
): string | null {
  if (!peerTz || !myTz) return null;
  const peer = tzOffsetMinutes(peerTz, now);
  const mine = tzOffsetMinutes(myTz, now);
  if (peer == null || mine == null) return null;
  const diff = peer - mine;
  if (diff === 0) return 'Same time as you';
  const ahead = diff > 0;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  if (m) parts.push(`${m} min`);
  return `${parts.join(' ')} ${ahead ? 'ahead of' : 'behind'} you`;
}
