/**
 * Which school this phone belongs to (M19.4).
 *
 * The app used to carry a tenant id in `app.json`, which is one build per
 * school and means a teacher cannot install it from a store. Instead the
 * teacher types their school's web address once — the same address they use in
 * a browser — and the app resolves the school from it and remembers.
 *
 * The API address comes from the same place. A school on
 * `stjosephs.paathshala.app` has its API wherever that deployment says, and
 * asking a teacher for an API URL is asking the wrong person a question they
 * cannot answer.
 */
import type { AsyncStorageModule } from './storage.ts';

const KEY = 'paathshala.school';

export interface School {
  host: string;
  tenantId: string;
  name: string;
  logoUrl: string | null;
  primaryColour: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
}

/**
 * Accepts what somebody would actually type.
 *
 * A teacher given a box labelled "your school's address" types
 * `stjosephs.paathshala.app`, or pastes `https://stjosephs.paathshala.app/` out
 * of a browser, or types it with a capital S. All three are the same school,
 * and refusing two of them is a support call.
 */
export function normaliseHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  if (!trimmed) return null;
  // A hostname, not an IP and not a bare word: the address of a school is
  // always a dotted name, and accepting a bare word would send the lookup off
  // to resolve something meaningless.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Where the API lives for a school reached at this host. */
export function apiUrlForHost(host: string, override?: string | undefined): string {
  if (override) return override.replace(/\/+$/, '');
  return `https://${host}`;
}

export class SchoolStore {
  constructor(private readonly store: AsyncStorageModule) {}

  async read(): Promise<School | null> {
    try {
      const raw = await this.store.getItem(KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      // Shape-checked rather than trusted: a half-written record would
      // otherwise produce a signed-in-looking app pointed at nothing.
      if (
        typeof parsed === 'object' && parsed !== null
        && typeof (parsed as School).host === 'string'
        && typeof (parsed as School).tenantId === 'string'
      ) {
        return parsed as School;
      }
      return null;
    } catch {
      return null;
    }
  }

  async write(school: School): Promise<void> {
    await this.store.setItem(KEY, JSON.stringify(school));
  }

  async clear(): Promise<void> {
    await this.store.setItem(KEY, '');
  }
}
