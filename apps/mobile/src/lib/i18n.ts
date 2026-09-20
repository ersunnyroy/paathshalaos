/**
 * The parent app's words (M29.2).
 *
 * M29.1 resolved *which* language a family reads. This is the other half: the
 * strings themselves, and what happens when the one they asked for is not
 * there.
 *
 * ## Why the English catalogue is the type
 *
 * `Strings` is derived from `EN`, and every other catalogue is a `Partial` of
 * it. That single decision does three things no test could do as well:
 *
 *   - A new string added to the app is a type error in nothing, because the
 *     other locales are partial — a translation is allowed to be late.
 *   - A key **removed** from English is a type error in every locale that
 *     still translates it, so dead strings cannot accumulate unnoticed.
 *   - A key MISSPELLED in a translation is a type error immediately, rather
 *     than a string that silently falls back to English forever. That is the
 *     failure this shape exists to prevent: a translated app where one screen
 *     is quietly in the wrong language and nobody can see why.
 *
 * ## Why a missing value leaves its placeholder standing
 *
 * The API throws when a template variable is missing, because a half-rendered
 * SMS goes to eight hundred people and cannot be recalled. A phone is
 * different: throwing inside a render takes the screen down, and a parent with
 * a blank screen has lost more than a parent with a visibly broken sentence.
 * So `t` leaves `{days}` in place. "Due {days} days ago" is obviously wrong and
 * gets reported; "Due  days ago" reads like a sentence and does not.
 */

/**
 * A string, or a pair for the two forms English needs.
 *
 * Not a full plural-rule engine. Hindi, Tamil and Bengali all distinguish one
 * from many the same way English does for the handful of counted nouns this
 * app shows, and the languages that need more forms than that — Arabic, Welsh,
 * Russian — are not languages this product is for. Inventing a CLDR plural
 * engine on that evidence would be building for a user who does not exist.
 */
export type Phrase = string | { one: string; other: string };

/**
 * English, complete. The shape of this object is the contract.
 *
 * Every string a parent can read is here — including the ones that used to sit
 * inline in the screen, where they were unreachable to a translator and
 * invisible to this file.
 */
export const EN = {
  'tab.attendance': 'Attendance',
  'tab.fees': 'Fees',
  'tab.work': 'Homework',
  'tab.results': 'Results',
  'tab.bus': 'Bus',

  'attendance.present': 'Present',
  'attendance.absent': 'Absent',
  'attendance.late': 'Late',
  'attendance.excused': 'Excused',
  'attendance.none': 'Nothing recorded yet',
  'attendance.noRegister': 'The school has not marked a register in this period.',
  'attendance.daysInSchool': '{inSchool} of {recorded} days in school',

  'fees.clear': 'Nothing outstanding',
  'fees.dueToday': 'Due today',
  'fees.overdue': { one: 'Due {days} day ago', other: 'Due {days} days ago' },
  'fees.dueIn': { one: 'Due in {days} day', other: 'Due in {days} days' },
  'fees.invoiceDue': 'Due {date}',

  'work.none': 'Nothing set at the moment. Homework appears here once a teacher publishes it.',
  'work.clear': 'Nothing outstanding',
  'work.waiting': {
    one: 'piece of work still to hand in',
    other: 'pieces of work still to hand in',
  },

  'results.overall': 'Overall',
  'results.heading': 'Results',
  'results.none': 'Nothing published yet. Results appear here once the school releases them.',
  'results.notGraded': '—',

  'bus.none': 'This child does not travel by school bus.',
  'bus.stop': 'Stop',
  'bus.pickup': 'Pickup',
  'bus.drop': 'Drop',
  'bus.vehicle': 'Bus',

  'child.noClass': 'Not in a class yet',
  'family.noChildren':
    'This account is not linked to any child yet. The school office can do that for you.',

  'error.children': 'Could not load your children.',
  'error.panel': 'Could not load that.',
  'error.offline': 'No signal, and nothing saved on this phone for this yet.',
  'cache.stale': 'No signal. This is what the school said {when}.',

  'action.signOut': 'Sign out',
} as const satisfies Record<string, Phrase>;

export type StringKey = keyof typeof EN;
export type Strings = Partial<Record<StringKey, Phrase>>;

/**
 * Hindi, deliberately incomplete.
 *
 * What is here is what this file's author can write correctly. What is missing
 * is **not publicly verified** and is left to somebody who speaks the language;
 * every absent key falls through to English, which is the behaviour the
 * fallback tests pin down.
 *
 * Shipping a half-translated catalogue rather than waiting for a complete one
 * is the deliberate choice. A parent who reads Hindi and sees five familiar
 * words among twenty English ones is better served than one who sees twenty
 * English words because the translation was not finished — and the half state
 * is visible to everybody, which is how the rest gets written.
 */
export const HI: Strings = {
  'tab.attendance': 'उपस्थिति',
  'tab.fees': 'शुल्क',
  'tab.work': 'गृहकार्य',
  'tab.results': 'परिणाम',
  'tab.bus': 'बस',

  'attendance.present': 'उपस्थित',
  'attendance.absent': 'अनुपस्थित',
  'attendance.late': 'देर से',
  'attendance.excused': 'अनुमति प्राप्त',

  'fees.clear': 'कुछ भी बकाया नहीं',
  'fees.dueToday': 'आज देय',

  'results.heading': 'परिणाम',

  'action.signOut': 'साइन आउट',
};

/**
 * The catalogues this bundle carries, by tag.
 *
 * A locale absent from here is not an error — the family's language may simply
 * have no strings yet, and the chain will find English. `TEACHING_LOCALES` on
 * the server lists twenty-three languages a school may *choose*; this lists the
 * ones the app has words in, and the two are allowed to differ.
 */
export const CATALOGUES: Record<string, Strings> = {
  'en-IN': EN,
  'hi-IN': HI,
};

/**
 * Widens a chain of tags so `hi-IN` also finds a catalogue filed as `hi`, and
 * a catalogue filed as `hi-IN` is found by a device that reports plain `hi`.
 *
 * A phone reports its locale in whatever form its OS likes. Matching only on
 * the exact string is how a Hindi phone gets an English app with a Hindi
 * catalogue sitting in the bundle unused.
 */
export function expand(chain: readonly string[]): string[] {
  const out: string[] = [];
  const push = (tag: string) => { if (tag && !out.includes(tag)) out.push(tag); };
  for (const raw of chain) {
    const tag = raw.trim();
    if (!tag) continue;
    const [language] = tag.split(/[-_]/);
    push(tag);
    if (language && language !== tag) push(language);
    // The region-qualified form of a bare language, so `hi` finds `hi-IN`.
    if (language === tag) {
      for (const known of Object.keys(CATALOGUES)) {
        if (known.split('-')[0] === language) push(known);
      }
    }
  }
  if (!out.includes('en-IN')) out.push('en-IN');
  return out;
}

export interface Translator {
  (key: StringKey, values?: Record<string, string | number>): string;
  /** Which tag each lookup starts from; useful in tests and in a settings screen. */
  readonly chain: readonly string[];
}

const PLACEHOLDER = /\{(\w+)\}/g;

function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name];
    // Left standing on purpose; see the note at the top of this file.
    return value === undefined ? whole : String(value);
  });
}

/**
 * Builds the lookup for one reader.
 *
 * Resolution is **per key, not per catalogue**: the first catalogue in the
 * chain that has this particular string wins, and the search continues past a
 * catalogue that exists but is missing this one. Picking a whole catalogue up
 * front — the obvious implementation — means a language with three strings in
 * it renders an app with three strings and seventeen blanks.
 */
export function translator(chain: readonly string[]): Translator {
  const order = expand(chain);
  const t = ((key: StringKey, values: Record<string, string | number> = {}) => {
    let phrase: Phrase | undefined;
    for (const tag of order) {
      const found = CATALOGUES[tag]?.[key];
      if (found !== undefined) { phrase = found; break; }
    }
    // English is in `order` and is complete by construction, so this only fires
    // if a caller reaches for a key that does not exist — which the types
    // refuse. Returning the key beats returning `undefined` into a <Text>.
    if (phrase === undefined) return key;

    if (typeof phrase === 'string') return fill(phrase, values);
    const count = Number(values['days'] ?? values['count'] ?? 0);
    return fill(Math.abs(count) === 1 ? phrase.one : phrase.other, values);
  }) as { (key: StringKey, values?: Record<string, string | number>): string;
          chain: readonly string[] };
  t.chain = order;
  return t as Translator;
}

/** The translator to use when nobody has said otherwise yet. */
export const english = translator(['en-IN']);

/**
 * What is wrong with a catalogue, as a list of sentences.
 *
 * Extracted from the test rather than written inside it, for a reason the
 * first version of this file got wrong: the checks below are only worth having
 * if they *fail* on a bad catalogue, and a check written inline in a test that
 * currently has nothing to catch passes whether or not it works. This function
 * is run twice — over the real catalogues, where it must come back empty, and
 * over deliberately broken fixtures, where it must not.
 *
 * The three failures it names are the three ways a translation goes wrong
 * quietly, in a diff nobody reviewing it can read:
 *
 *   - a key English does not have, which is a typo that falls back forever;
 *   - a dropped `{placeholder}`, so a parent reads "Due days ago";
 *   - a plural pair flattened to one string, so the app says "1 days".
 */
export function auditCatalogue(tag: string, catalogue: Strings): string[] {
  const problems: string[] = [];
  for (const [key, phrase] of Object.entries(catalogue) as [string, Phrase][]) {
    if (!(key in EN)) {
      problems.push(`${tag}: ${key} is not a key English has`);
      continue;
    }
    const english = EN[key as StringKey] as Phrase;
    if (typeof phrase !== typeof english) {
      problems.push(
        `${tag}: ${key} is ${typeof phrase} where English is ${typeof english}`
        + ' — a plural pair flattened to one string reads as "1 days"');
      continue;
    }
    const mine = placeholdersIn(phrase);
    const theirs = placeholdersIn(english);
    if (mine.join(',') !== theirs.join(',')) {
      problems.push(
        `${tag}: ${key} uses {${mine.join('}, {')}} where English uses `
        + `{${theirs.join('}, {')}}`);
    }
  }
  return problems;
}

export function placeholdersIn(phrase: Phrase): string[] {
  const text = typeof phrase === 'string' ? phrase : `${phrase.one} ${phrase.other}`;
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))].sort();
}
