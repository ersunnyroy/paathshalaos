/**
 * The arithmetic and grouping behind the business console (M42.5).
 *
 * Kept out of the components so it is tested in Node. Two rules run through
 * it: money stays a decimal string from the API to the screen and is never
 * parsed into a float, and a capability that has been revoked is history, not
 * access.
 */

/** A decimal rupee string ("12500.5") as "₹12,500.50". String surgery only. */
export function rupeesDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const negative = value.startsWith('-');
  const [wholeRaw = '0', fractionRaw = ''] = (negative ? value.slice(1) : value).split('.');
  const whole = wholeRaw.replace(/^0+(?=\d)/, '');
  const fraction = (fractionRaw + '00').slice(0, 2);
  // Indian grouping: the last three digits, then pairs.
  const tail = whole.slice(-3);
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₹${head ? `${head},` : ''}${tail}.${fraction}`;
}

/** Adds decimal strings exactly, in paise, and returns a decimal string. */
export function sumDecimals(values: readonly string[]): string {
  let paise = 0n;
  for (const value of values) {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
    const amount = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
    paise += negative ? -amount : amount;
  }
  const negative = paise < 0n;
  const digits = (negative ? -paise : paise).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export interface AdminRow {
  user_account_id: string; login_email: string | null;
  capability: string; granted_at: string; revoked_at: string | null;
}
export interface TeamMember {
  userId: string; email: string;
  capabilities: string[];   // held now
  revoked: string[];        // held once, not now
}

export const CAPABILITIES = [
  'provision', 'support', 'billing', 'impersonate', 'impersonate_write', 'superadmin',
] as const;

/** What each capability lets somebody do, in the words the Team tab shows. */
export const CAPABILITY_MEANING: Record<string, string> = {
  provision: 'Create, suspend and resume schools; manage this team',
  support: 'Work support tickets',
  billing: 'Plans, subscriptions, invoices and credit notes',
  impersonate: 'Enter a school read-only, on the record',
  impersonate_write: 'Enter a school and change its records',
  superadmin: 'Grant capabilities. Does not itself open a school',
};

/**
 * One row per person, from one row per grant.
 *
 * A capability granted, revoked and granted again is held: what matters is
 * whether any grant of it is live. People with nothing live sort last — they
 * are former staff, and the list is for seeing who can do what today.
 */
export function groupTeam(rows: readonly AdminRow[]): TeamMember[] {
  const people = new Map<string, { email: string; live: Set<string>; ever: Set<string> }>();
  for (const row of rows) {
    const person = people.get(row.user_account_id)
      ?? { email: row.login_email ?? 'deleted account', live: new Set<string>(), ever: new Set<string>() };
    person.ever.add(row.capability);
    if (row.revoked_at === null) person.live.add(row.capability);
    people.set(row.user_account_id, person);
  }
  const order = (c: string) => CAPABILITIES.indexOf(c as (typeof CAPABILITIES)[number]);
  return [...people.entries()]
    .map(([userId, p]) => ({
      userId, email: p.email,
      capabilities: [...p.live].sort((a, b) => order(a) - order(b)),
      revoked: [...p.ever].filter((c) => !p.live.has(c)).sort((a, b) => order(a) - order(b)),
    }))
    .sort((a, b) =>
      Number(b.capabilities.length > 0) - Number(a.capabilities.length > 0)
      || a.email.localeCompare(b.email));
}

/** Capabilities this person could still be given. */
export function grantable(member: TeamMember): string[] {
  return CAPABILITIES.filter((c) => !member.capabilities.includes(c));
}

/**
 * What can be done to a plan version in its current state.
 *
 * A draft can be published; a published version can be retired; a retired one
 * is finished. There is no "edit": published terms are what schools agreed to.
 */
export function versionAction(status: string): 'publish' | 'retire' | null {
  if (status === 'draft') return 'publish';
  if (status === 'published') return 'retire';
  return null;
}

export interface SchoolRow { id: string; status: string; accounts: number; owners: number; live_sessions: number }

/** The headline counts above the schools table. */
export function estate(schools: readonly SchoolRow[]) {
  return {
    total: schools.length,
    active: schools.filter((s) => s.status === 'active').length,
    suspended: schools.filter((s) => s.status === 'suspended').length,
    // A school nobody can administer cannot fix anything itself. It is the row
    // to call about, so it is counted rather than left to be spotted.
    ownerless: schools.filter((s) => s.owners === 0).length,
    accounts: schools.reduce((n, s) => n + s.accounts, 0),
  };
}

/* ----------------------------------------------------------- plan builder */

export const METRICS = ['learners', 'staff', 'campuses', 'messages_per_month', 'storage_mb'] as const;
export const FEATURES = ['transport', 'hr', 'lms', 'public_api', 'whatsapp', 'advanced_reports'] as const;

/** A plan code from its name: "Growth Plus" → "growth_plus". Null if nothing usable is left. */
export function planCodeFrom(name: string): string | null {
  const code = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .replace(/^[0-9_]+/, '').slice(0, 31);
  return /^[a-z][a-z0-9_]{1,30}$/.test(code) ? code : null;
}

export interface TermsForm {
  limits: Record<string, { included: string; hardCap: string }>;
  features: Record<string, boolean>;
}
export interface Terms {
  limits: Array<{ metric: string; included: number; hardCap: number | null }>;
  features: Array<{ feature: string; enabled: boolean }>;
}

const wholeNumber = (text: string) => /^\d{1,9}$/.test(text.trim());

/**
 * The form as the API wants it, or the first thing wrong with it.
 *
 * A metric left blank is not limited at all, which is different from a limit
 * of zero. A hard cap below what the plan includes would refuse a school
 * something it has paid for, so it is rejected here rather than discovered by
 * the first school to hit it.
 */
export function buildTerms(form: TermsForm): { ok: true; terms: Terms } | { ok: false; error: string } {
  const limits: Terms['limits'] = [];
  for (const metric of METRICS) {
    const entry = form.limits[metric];
    const label = metric.replace(/_/g, ' ');
    if (!entry || entry.included.trim() === '') {
      if (entry && entry.hardCap.trim() !== '') {
        return { ok: false, error: `${label}: a hard cap needs an included amount.` };
      }
      continue;
    }
    if (!wholeNumber(entry.included)) return { ok: false, error: `${label}: included must be a whole number.` };
    const included = Number(entry.included.trim());
    let hardCap: number | null = null;
    if (entry.hardCap.trim() !== '') {
      if (!wholeNumber(entry.hardCap)) return { ok: false, error: `${label}: hard cap must be a whole number.` };
      hardCap = Number(entry.hardCap.trim());
      if (hardCap < included) {
        return { ok: false, error: `${label}: the hard cap (${hardCap}) is below what the plan includes (${included}).` };
      }
    }
    limits.push({ metric, included, hardCap });
  }
  // Every feature is sent, off ones included: a version's terms should say
  // what it does not have, not leave it to be inferred.
  const features = FEATURES.map((feature) => ({ feature, enabled: form.features[feature] === true }));
  return { ok: true, terms: { limits, features } };
}

/** A price as the API accepts it ("1500" or "1499.50"), or null. */
export function priceOrNull(text: string): string | null {
  const value = text.trim().replace(/,/g, '');
  return /^\d{1,12}(\.\d{1,2})?$/.test(value) ? value : null;
}

/* ------------------------------------------------------------ new school */

export interface SchoolForm {
  legalName: string; displayName: string; ownerEmail: string;
  campusName: string; campusCode: string; board: string;
}

/** A campus code from its name: "Main Campus" → "MAIN-CAMPUS". */
export function campusCodeFrom(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31)
    .replace(/-+$/, '');
}

/**
 * The request the console sends to create a school, or what is wrong.
 *
 * `requestKey` is passed in rather than made here: it must stay the same when
 * somebody presses the button twice or retries after a timeout, because that
 * key is what stops one form creating two schools.
 */
export function buildSchool(form: SchoolForm, requestKey: string):
  { ok: true; body: Record<string, string> } | { ok: false; error: string } {
  const legalName = form.legalName.trim();
  const displayName = form.displayName.trim() || legalName;
  const ownerEmail = form.ownerEmail.trim().toLowerCase();
  const campusName = form.campusName.trim();
  const campusCode = form.campusCode.trim();
  if (!legalName) return { ok: false, error: 'The legal name is needed: it goes on invoices.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
    return { ok: false, error: "The owner's email address does not look right." };
  }
  if (!campusName) return { ok: false, error: 'Name the first campus.' };
  if (!/^[A-Z0-9][A-Z0-9-]{1,30}$/.test(campusCode)) {
    return { ok: false, error: 'The campus code is 2 to 31 capital letters, digits and hyphens. It appears in receipt numbers.' };
  }
  if (requestKey.length < 8) return { ok: false, error: 'Internal: no request key.' };
  const board = form.board.trim();
  return {
    ok: true,
    body: {
      requestKey, legalName, displayName, ownerEmail, campusName, campusCode,
      ...(board ? { boardOrAffiliation: board } : {}),
    },
  };
}

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'read_only', 'ended'] as const;

/** What each subscription status does to the school, in one line. */
export const STATUS_MEANING: Record<string, string> = {
  trialing: 'Full use, not yet billed',
  active: 'Full use, billed',
  past_due: 'Full use, payment is late',
  read_only: 'Can see everything, can change nothing',
  ended: 'Subscription over',
};
