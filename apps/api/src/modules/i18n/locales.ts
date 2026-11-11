/**
 * The language vocabulary (M29.1).
 *
 * `organization.locale` has existed since migration 0002 with a default of
 * `en-IN`, and until this module nothing in the product had ever read it.
 * Every locale decision in the system resolved to a hard-coded `'en-IN'` in two
 * places — `dispatch.service.ts` and `template.service.ts` — which meant a
 * Hindi-medium school with Hindi templates and no per-parent preference on file
 * sent nothing at all: the send looked for an `en-IN` template, found none, and
 * recorded `no_approved_template` against every recipient. "India-first" was a
 * claim about the schema, not a behaviour.
 *
 * This file is the vocabulary only — no database, no I/O — so the API, the web
 * app and the mobile app can share it without sharing a connection.
 *
 * ## Why unknown tags are kept rather than rejected
 *
 * `normalise` canonicalises case and separator and returns a *well-formed* tag
 * even when it is not in the list below. That is deliberate. `message_template_version.locale`
 * is a free-text column; a school that registered its templates under `bho-IN`
 * (Bhojpuri, not in the Eighth Schedule) should still receive them. Dropping an
 * unrecognised tag here would silently route that school's parents to English
 * while its own templates sat unused. Only a *malformed* string is discarded,
 * because a malformed tag cannot match a template row anyway.
 *
 * `TEACHING_LOCALES` is therefore a picker list, not a permission list.
 */

/**
 * The last resort, and only that.
 *
 * Not "the language of the product" — it is the tag the schema has defaulted to
 * since 0002, so it is the one locale every existing row and every seeded
 * template is guaranteed to carry. Changing it would orphan them.
 */
export const DEFAULT_LOCALE = 'en-IN';

export interface TeachingLocale {
  /** BCP-47, region always IN: these are Indian-medium tags, not world locales. */
  tag: string;
  /** The English name, which is what an administrator searches for. */
  english: string;
  /**
   * The name in its own script, which is what a parent recognises.
   *
   * Absent where this file's author could not verify the spelling. An endonym
   * printed wrong in a language-picker is worse than one that is missing: the
   * missing one reads as incomplete, the wrong one reads as carelessness about
   * the reader. These are gaps for somebody who reads the script to fill, and
   * `endonymOf` falls back to the English name until then.
   */
  endonym?: string;
}

/**
 * English plus the twenty-two languages of the Eighth Schedule to the
 * Constitution of India.
 *
 * The Eighth Schedule is the list, rather than a list of "languages we have
 * translated into", because the two are different promises. A school picks the
 * language it teaches in; whether a *template* or an app string exists in that
 * language is a separate question the template table answers per row. Offering
 * only what is translated would tell a Bodo-medium school that its language is
 * not a thing this product has heard of.
 */
export const TEACHING_LOCALES: readonly TeachingLocale[] = [
  { tag: 'en-IN',  english: 'English' },
  { tag: 'hi-IN',  english: 'Hindi',     endonym: 'हिन्दी' },
  { tag: 'bn-IN',  english: 'Bengali',   endonym: 'বাংলা' },
  { tag: 'mr-IN',  english: 'Marathi',   endonym: 'मराठी' },
  { tag: 'te-IN',  english: 'Telugu',    endonym: 'తెలుగు' },
  { tag: 'ta-IN',  english: 'Tamil',     endonym: 'தமிழ்' },
  { tag: 'gu-IN',  english: 'Gujarati',  endonym: 'ગુજરાતી' },
  { tag: 'ur-IN',  english: 'Urdu',      endonym: 'اردو' },
  { tag: 'kn-IN',  english: 'Kannada',   endonym: 'ಕನ್ನಡ' },
  { tag: 'or-IN',  english: 'Odia',      endonym: 'ଓଡ଼ିଆ' },
  { tag: 'ml-IN',  english: 'Malayalam', endonym: 'മലയാളം' },
  { tag: 'pa-IN',  english: 'Punjabi',   endonym: 'ਪੰਜਾਬੀ' },
  { tag: 'as-IN',  english: 'Assamese',  endonym: 'অসমীয়া' },
  { tag: 'mai-IN', english: 'Maithili',  endonym: 'मैथिली' },
  { tag: 'sa-IN',  english: 'Sanskrit',  endonym: 'संस्कृतम्' },
  { tag: 'ne-IN',  english: 'Nepali',    endonym: 'नेपाली' },
  { tag: 'kok-IN', english: 'Konkani',   endonym: 'कोंकणी' },
  { tag: 'doi-IN', english: 'Dogri',     endonym: 'डोगरी' },
  // Not publicly verified by this file's author: the endonym spellings for the
  // languages below. Listed by their English names so a school can still
  // choose them; the script names are a gap, not an omission on purpose.
  { tag: 'ks-IN',  english: 'Kashmiri' },
  { tag: 'sd-IN',  english: 'Sindhi' },
  { tag: 'mni-IN', english: 'Manipuri' },
  { tag: 'sat-IN', english: 'Santali' },
  { tag: 'brx-IN', english: 'Bodo' },
] as const;

const BY_TAG = new Map(TEACHING_LOCALES.map((l) => [l.tag, l]));

/**
 * A language subtag is 2–3 letters (ISO 639-1/-2/-3); a region is 2 letters or
 * 3 digits. Anything else is not a tag we can match a template row against.
 */
const WELL_FORMED = /^([a-z]{2,3})(?:[-_]([a-z]{2}|\d{3}))?$/i;

/**
 * Canonical form, or `undefined` if the input could not be a locale at all.
 *
 * A bare language gets `-IN` rather than being left bare, because every locale
 * column in this database was populated with a region and `hi` would never
 * match `hi-IN`. This product is single-country by design; when that stops
 * being true, this is the line that has to change, and it is one line.
 */
export function normalise(input: string | null | undefined): string | undefined {
  if (typeof input !== 'string') return undefined;
  const match = WELL_FORMED.exec(input.trim());
  if (!match) return undefined;
  const language = match[1]!.toLowerCase();
  const region = (match[2] ?? 'IN').toUpperCase();
  return `${language}-${region}`;
}

/** Whether a tag is one a picker should offer. Not a permission check. */
export function isTeachingLocale(input: string | null | undefined): boolean {
  const tag = normalise(input);
  return tag !== undefined && BY_TAG.has(tag);
}

/** The name to print for a tag, preferring the reader's own script. */
export function endonymOf(input: string | null | undefined): string {
  const tag = normalise(input);
  const known = tag ? BY_TAG.get(tag) : undefined;
  return known?.endonym ?? known?.english ?? tag ?? DEFAULT_LOCALE;
}

/**
 * The ordered list of locales to try, most-wanted first.
 *
 * Returned as a chain rather than a single winning tag because the caller that
 * matters — finding an approved template — can accept a later entry when the
 * earlier one has nothing approved. Collapsing this to one string is what the
 * old code did, and it is why the school default could never be consulted: by
 * the time the template lookup ran, the alternatives had already been thrown
 * away.
 *
 * `DEFAULT_LOCALE` is always last and always present. A chain that could come
 * back empty would give the SQL `locale = ANY('{}')`, which matches nothing —
 * so a person with no preference at a school with a blank locale would stop
 * receiving messages entirely, which is the failure this module exists to end.
 */
export function chain(...candidates: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    const tag = normalise(candidate);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  if (!out.includes(DEFAULT_LOCALE)) out.push(DEFAULT_LOCALE);
  return out;
}
