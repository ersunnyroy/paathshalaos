/**
 * The one place this app talks to the API.
 *
 * Two decisions worth stating, because both are easy to get wrong later:
 *
 *   **The access token lives in memory plus sessionStorage, not a cookie set by
 *   this app.** It is short-lived (ten minutes) and refreshed; a long-lived
 *   credential in `localStorage` survives until somebody clears it, which is the
 *   difference between "signed out when I closed the tab" and "signed in on the
 *   library computer forever".
 *
 *   **Money never becomes a number.** The API sends paise as a decimal string.
 *   `JSON.parse` would happily turn it into a double, and a fee that has been
 *   through a double is no longer exact. It is formatted from the string.
 */
const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
const TENANT_ID = process.env['NEXT_PUBLIC_TENANT_ID'] ?? '';

const ACCESS_KEY = 'paathshala.access';
const REFRESH_KEY = 'paathshala.refresh';

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export function tenantId(): string {
  return TENANT_ID;
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(ACCESS_KEY, session.accessToken);
    sessionStorage.setItem(REFRESH_KEY, session.refreshToken);
  } catch {
    // Private browsing, blocked storage. The in-memory token still works for
    // this page; the user signs in again on reload rather than seeing an error.
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(ACCESS_KEY);
    sessionStorage.removeItem(REFRESH_KEY);
  } catch { /* see above */ }
}

export function currentToken(): string | null {
  try {
    return sessionStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { code: 'bad_response', message: text.slice(0, 200) } };
  }
}

export async function login(email: string, password: string): Promise<Session> {
  if (!TENANT_ID) {
    throw new ApiError(0, 'no_tenant',
      'NEXT_PUBLIC_TENANT_ID is not set. Run the seed script and copy the tenant id into apps/web/.env.local.');
  }
  const response = await fetch(`${API_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId: TENANT_ID }),
  });
  const body = (await parse(response)) as
    { data?: Session; error?: { code: string; message: string } } | undefined;

  if (!response.ok || !body?.data) {
    // The API deliberately says the same thing for "no such account" and "wrong
    // password", and so does this. Distinguishing them is an account-existence
    // oracle for anybody with a list of email addresses.
    throw new ApiError(response.status, body?.error?.code ?? 'login_failed',
      body?.error?.message ?? 'Those details were not accepted.');
  }
  saveSession(body.data);
  return body.data;
}

export async function apiGet<T>(path: string): Promise<T> {
  const token = currentToken();
  const response = await fetch(`${API_URL}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
  });
  const body = (await parse(response)) as
    { data?: T; error?: { code: string; message: string } } | undefined;

  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `The request failed (${response.status}).`);
  }
  return body?.data as T;
}

export async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const token = currentToken();
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  const body = (await parse(response)) as
    { data?: T; error?: { code: string; message: string } } | undefined;

  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `The request failed (${response.status}).`);
  }
  return body?.data as T;
}

/**
 * Paise (an integer string) to rupees, for display only.
 *
 * Done by string surgery rather than division, because `52800000 / 100` is a
 * float and the whole point of carrying paise is that it never becomes one.
 */
export function rupees(paise: string | null | undefined): string {
  if (paise === null || paise === undefined || paise === '') return '—';
  const negative = paise.startsWith('-');
  const digits = (negative ? paise.slice(1) : paise).padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  const grouped = Number(whole).toLocaleString('en-IN');
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/**
 * Paise to a compact Indian figure, for stat tiles only.
 *
 * `₹7,92,000.00` overflows a tile on a phone, and a truncated number is worse
 * than a rounded one — you cannot tell which digits went missing. Lakh and crore
 * are also what the reader actually thinks in: an Indian principal reads "7.92
 * lakh", not "seven hundred and ninety-two thousand".
 *
 * Tables keep the exact figure. This is for the glance, and the exact value
 * travels with it as a title attribute so the precise number is one hover away.
 */
export function rupeesCompact(paise: string | null | undefined): string {
  if (paise === null || paise === undefined || paise === '') return '—';
  const negative = paise.startsWith('-');
  const abs = BigInt(negative ? paise.slice(1) : paise);
  const sign = negative ? '-' : '';

  const CRORE = 10_000_000_00n;  // 1 crore rupees, in paise
  const LAKH = 100_000_00n;
  const THOUSAND = 1_000_00n;

  const trim = (value: string) => value.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1');
  const scaled = (unit: bigint, suffix: string) =>
    // Two decimals of the unit, computed in BigInt so the rounding is ours and
    // not the float's.
    `${sign}₹${trim((Number((abs * 100n) / unit) / 100).toFixed(2))}${suffix}`;

  if (abs >= CRORE) return scaled(CRORE, 'Cr');
  if (abs >= LAKH) return scaled(LAKH, 'L');
  if (abs >= THOUSAND) return `${sign}₹${Number(abs / 100n).toLocaleString('en-IN')}`;
  return rupees(paise);
}

/* ------------------------------------------------------------------ console */
/*
 * The platform console keeps its own token, under its own key.
 *
 * Deliberately not shared with the school session. A console token and a school
 * token are different authorities and the console mints school tokens — keeping
 * them in one slot means entering a school signs you out of the console you
 * need to leave it from, and, worse, makes "which token is this?" a question the
 * UI answers by accident.
 */
const CONSOLE_KEY = 'paathshala.console';

export interface ConsoleSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  capabilities: string[];
}

export function consoleToken(): string | null {
  try { return sessionStorage.getItem(CONSOLE_KEY); } catch { return null; }
}

export function clearConsole(): void {
  try { sessionStorage.removeItem(CONSOLE_KEY); } catch { /* fine */ }
}

export async function consoleLogin(email: string, password: string): Promise<ConsoleSession> {
  const response = await fetch(`${API_URL}/platform/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = (await parse(response)) as
    { data?: ConsoleSession; error?: { code: string; message: string } } | undefined;
  if (!response.ok || !body?.data) {
    throw new ApiError(response.status, body?.error?.code ?? 'login_failed',
      body?.error?.message ?? 'Those details were not accepted.');
  }
  try { sessionStorage.setItem(CONSOLE_KEY, body.data.accessToken); } catch { /* fine */ }
  return body.data;
}

async function consoleCall<T>(path: string, init?: RequestInit): Promise<T> {
  const token = consoleToken();
  const response = await fetch(`${API_URL}/platform/v1${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
  });
  const body = (await parse(response)) as
    { data?: T; error?: { code: string; message: string } } | undefined;
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `The request failed (${response.status}).`);
  }
  return body?.data as T;
}

export function consoleGet<T>(path: string): Promise<T> {
  return consoleCall<T>(path);
}

export function consolePost<T>(path: string, payload?: unknown): Promise<T> {
  return consoleCall<T>(path, {
    method: 'POST',
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

/**
 * Takes over the school session with a token minted by the console.
 *
 * Writing it into the same slot the school app reads is the whole mechanism:
 * every existing screen then works unchanged, rendering exactly what that
 * person sees, and the banner comes from /v1/me rather than from anything this
 * function remembers.
 */
export function assumeSchoolSession(accessToken: string): void {
  try {
    sessionStorage.setItem(ACCESS_KEY, accessToken);
    // No refresh token: an entry session cannot be renewed. When the window
    // closes the console opens a new one, which writes a new row.
    sessionStorage.removeItem(REFRESH_KEY);
  } catch { /* the in-memory fetch below still carries the header */ }
}
