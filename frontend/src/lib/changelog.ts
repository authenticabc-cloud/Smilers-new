/**
 * changelog.ts — release notes SHIPPED WITH THE APP BUNDLE.
 *
 * Why local (not backend)? The "What's New" popup announces the bundled build
 * version (Constants.expoConfig.version, which the deploy pipeline auto-bumps).
 * Previously the notes came from the backend /api/app-version defaults, which
 * were static — so every new version showed the SAME old bullets. Keeping the
 * notes here guarantees they always match the build the user actually installed.
 *
 * HOW TO ADD NOTES FOR A NEW RELEASE:
 *   Add an entry to CHANGELOG below keyed by the release's version string, with
 *   its user-facing bullets. When the app announces a version, it shows the
 *   notes for the highest entry whose version is <= the running build, so patch
 *   bumps (e.g. 2.4.1) still show the latest feature notes (from 2.4.0) without
 *   needing a new entry every patch.
 */
import { compareVersions } from './appVersion';

export const CHANGELOG: Record<string, string[]> = {
  // Keyed just above the current live build (v2.3.63) so these show on the NEXT
  // update and every build after it (the lookup picks the highest entry <= the
  // running version). Add a NEW higher-keyed entry for the next feature release.
  '2.3.64': [
    'Sub Groups — create groups within a group, with roles, ranking and synced icons',
    'One active device at a time for stronger account security',
    'Pinch-to-zoom photos across chats, profiles, stories and ads',
    'Smoother chats that land on your latest message instantly',
    'Performance and stability improvements',
  ],
};

// Shown when the running build is newer than every changelog entry OR the
// version can't be matched — keeps the popup honest instead of stale.
export const GENERIC_NOTES: string[] = ['Performance and stability improvements'];

/**
 * Notes for the given build version: the entry with the greatest version that
 * is <= `version`. Returns [] when `version` predates every entry (so no popup
 * shows for old builds). Callers may fall back to GENERIC_NOTES.
 */
export function getReleaseNotesFor(version: string): string[] {
  if (!version) return [];
  let bestKey: string | null = null;
  for (const key of Object.keys(CHANGELOG)) {
    if (compareVersions(key, version) <= 0) {
      if (!bestKey || compareVersions(key, bestKey) > 0) bestKey = key;
    }
  }
  return bestKey ? CHANGELOG[bestKey] : [];
}
