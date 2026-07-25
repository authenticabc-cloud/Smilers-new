/**
 * Study Materials — Bible & Quran client.
 * Talks to our FastAPI proxy (/api/bible/*, /api/quran/*) which wraps free,
 * public-domain sources (getbible.net, alquran.cloud). Copyrighted Bible
 * versions (ESV/NIV/NKJV) are intentionally not offered yet — they need a
 * licensed key and will be added later.
 */

const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

export type BibleVerse = { verse: number; text: string };
export type QuranAyah = { numberInSurah: number; text: string; arabic: string };
export type Surah = {
  number: number;
  name: string;
  englishName: string;
  englishNameTranslation: string;
  numberOfAyahs: number;
};

/** Languages → public-domain Bible translation id on getbible.net. */
export const BIBLE_LANGUAGES: {
  code: string;
  label: string;
  translation: string | null; // null = not available yet
  version: string;
}[] = [
  { code: 'en', label: 'English', translation: 'kjv', version: 'KJV' },
  { code: 'fr', label: 'French', translation: 'ls1910', version: 'Louis Segond' },
  { code: 'es', label: 'Spanish', translation: 'valera', version: 'Reina-Valera' },
  { code: 'it', label: 'Italian', translation: 'riveduta', version: 'Riveduta' },
  { code: 'de', label: 'German', translation: 'schlachter', version: 'Schlachter' },
  { code: 'pt', label: 'Portuguese', translation: 'almeida', version: 'Almeida' },
  { code: 'tw', label: 'Asante Twi', translation: null, version: 'Not available yet' },
];

/** Languages → Quran translation edition on alquran.cloud. */
export const QURAN_LANGUAGES: { code: string; label: string; edition: string }[] = [
  { code: 'en', label: 'English', edition: 'en.sahih' },
  { code: 'fr', label: 'French', edition: 'fr.hamidullah' },
  { code: 'es', label: 'Spanish', edition: 'es.cortes' },
  { code: 'it', label: 'Italian', edition: 'it.piccardo' },
  { code: 'de', label: 'German', edition: 'de.aburida' },
  { code: 'pt', label: 'Portuguese', edition: 'pt.elhayek' },
];

/** Canonical 66-book Bible list: [name, chapterCount]. Index+1 = getbible book nr. */
const BOOK_DATA: [string, number][] = [
  ['Genesis', 50], ['Exodus', 40], ['Leviticus', 27], ['Numbers', 36], ['Deuteronomy', 34],
  ['Joshua', 24], ['Judges', 21], ['Ruth', 4], ['1 Samuel', 31], ['2 Samuel', 24],
  ['1 Kings', 22], ['2 Kings', 25], ['1 Chronicles', 29], ['2 Chronicles', 36], ['Ezra', 10],
  ['Nehemiah', 13], ['Esther', 10], ['Job', 42], ['Psalms', 150], ['Proverbs', 31],
  ['Ecclesiastes', 12], ['Song of Solomon', 8], ['Isaiah', 66], ['Jeremiah', 52], ['Lamentations', 5],
  ['Ezekiel', 48], ['Daniel', 12], ['Hosea', 14], ['Joel', 3], ['Amos', 9],
  ['Obadiah', 1], ['Jonah', 4], ['Micah', 7], ['Nahum', 3], ['Habakkuk', 3],
  ['Zephaniah', 3], ['Haggai', 2], ['Zechariah', 14], ['Malachi', 4], ['Matthew', 28],
  ['Mark', 16], ['Luke', 24], ['John', 21], ['Acts', 28], ['Romans', 16],
  ['1 Corinthians', 16], ['2 Corinthians', 13], ['Galatians', 6], ['Ephesians', 6], ['Philippians', 4],
  ['Colossians', 4], ['1 Thessalonians', 5], ['2 Thessalonians', 3], ['1 Timothy', 6], ['2 Timothy', 4],
  ['Titus', 3], ['Philemon', 1], ['Hebrews', 13], ['James', 5], ['1 Peter', 5],
  ['2 Peter', 3], ['1 John', 5], ['2 John', 1], ['3 John', 1], ['Jude', 1], ['Revelation', 22],
];

export const BIBLE_BOOKS = BOOK_DATA.map(([name, chapters], i) => ({ nr: i + 1, name, chapters }));

export async function fetchBibleChapter(
  translation: string,
  book: number,
  chapter: number,
): Promise<{ book_name: string; chapter: number; verses: BibleVerse[] }> {
  const r = await fetch(
    `${BACKEND_URL}/api/bible/chapter?translation=${encodeURIComponent(translation)}&book=${book}&chapter=${chapter}`,
  );
  if (!r.ok) throw new Error('Could not load this passage. Try another version.');
  return r.json();
}

export async function fetchSurahs(): Promise<Surah[]> {
  const r = await fetch(`${BACKEND_URL}/api/quran/surahs`);
  if (!r.ok) throw new Error('Could not load the surah list.');
  return (await r.json()).surahs;
}

export async function fetchSurah(
  number: number,
  edition: string,
): Promise<{ number: number; name: string; ayahs: QuranAyah[] }> {
  const r = await fetch(
    `${BACKEND_URL}/api/quran/surah?number=${number}&edition=${encodeURIComponent(edition)}&with_arabic=true`,
  );
  if (!r.ok) throw new Error('Could not load this surah.');
  return r.json();
}
