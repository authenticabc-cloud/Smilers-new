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
