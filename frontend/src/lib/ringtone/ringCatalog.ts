// Single source of truth for available ringtones.
// Used by both:
//   - Settings → Ringtones (preview & selection)
//   - Incoming call screen (playback)
//
// Bundled MP3s live in /assets/sounds/. Add new files here as the user uploads them.

export type RingId =
  | 'smilers_never_cry'
  | 'smilers_never_cry_1'
  | 'smilers_never_cry_2'
  | 'smilers_never_cry_3'
  | 'silent';

export const DEFAULT_RING_ID: RingId = 'smilers_never_cry';

export interface RingDefinition {
  id: RingId;
  name: string;
  description: string;
  source: number | null; // null = silent. Otherwise asset module ID from require().
}

// require() must use literal paths so Metro can bundle the asset.
export const RING_CATALOG: RingDefinition[] = [
  {
    id: 'smilers_never_cry',
    name: 'Smilers Never Cry',
    description: 'The signature Smilers theme',
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    source: require('../../../assets/sounds/Smilers_Never_Cry.mp3'),
  },
  {
    id: 'smilers_never_cry_1',
    name: 'Smilers Never Cry · 1',
    description: 'Full-length signature tune',
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    source: require('../../../assets/sounds/Smilers_Never_Cry_1.mp3'),
  },
  {
    id: 'smilers_never_cry_2',
    name: 'Smilers Never Cry · 2',
    description: 'Bright, melodic short version',
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    source: require('../../../assets/sounds/Smilers_Never_Cry_2.mp3'),
  },
  {
    id: 'smilers_never_cry_3',
    name: 'Smilers Never Cry · 3',
    description: 'Bouncy alternate cut',
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    source: require('../../../assets/sounds/Smilers_Never_Cry_3.mp3'),
  },
  {
    id: 'silent',
    name: 'Silent',
    description: 'No sound, vibration only',
    source: null,
  },
];

const RING_BY_ID: Record<RingId, RingDefinition> = RING_CATALOG.reduce(
  (acc, r) => {
    acc[r.id] = r;
    return acc;
  },
  {} as Record<RingId, RingDefinition>,
);

/** Look up a ringtone by id, falling back to the default. */
export function getRingSource(id: RingId | string | null | undefined): number | null {
  if (!id) return RING_BY_ID[DEFAULT_RING_ID].source;
  const entry = RING_BY_ID[id as RingId];
  if (!entry) return RING_BY_ID[DEFAULT_RING_ID].source;
  return entry.source;
}

/** Get the ring definition (or default) by id. */
export function getRingDefinition(id: RingId | string | null | undefined): RingDefinition {
  if (!id) return RING_BY_ID[DEFAULT_RING_ID];
  return RING_BY_ID[id as RingId] || RING_BY_ID[DEFAULT_RING_ID];
}
