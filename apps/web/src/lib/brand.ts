/**
 * Whose school this is, decided at runtime by the address in the browser.
 *
 * This replaces `NEXT_PUBLIC_TENANT_ID`, which was baked in at build time and
 * therefore meant one build per school — the opposite of white-labelling. Now
 * the host identifies the school, the API turns it into a brand, and the same
 * deployment serves everybody.
 *
 * Fetched before the sign-in form renders, because the brand IS the sign-in
 * screen: a school's parents should see their school's name and mark, not ours.
 */
export interface Brand {
  tenantId: string;
  name: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  primaryColour: string | null;
  inkColour: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  poweredBy: 'paathshalaOS';
}

/**
 * Anchored, and applied again here.
 *
 * The API validates this and so does a column check, and it is validated a
 * third time on the way into a stylesheet — because this value is written into
 * a CSS custom property in the browser, and the cost of being wrong is script
 * execution on a page served under a school's own domain. Three cheap checks
 * against one expensive failure.
 */
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function safeColour(value: string | null | undefined): string | null {
  return value != null && HEX.test(value) ? value : null;
}

/**
 * The host to ask about.
 *
 * In the browser it is simply where we are. In development everything runs on
 * localhost, which identifies nothing, so a configured host stands in — that is
 * the only place a value from configuration is trusted over the address bar.
 */
export function brandHost(
  locationHost: string,
  configured: string | undefined,
): string {
  const bare = locationHost.split(':')[0] ?? '';
  const isLocal = bare === 'localhost' || bare === '127.0.0.1' || bare === '';
  return isLocal && configured ? configured : locationHost;
}

/* ------------------------------------------------------------------ colour */

/**
 * The school gives us one colour. The stylesheet needs six.
 *
 * `--brand` is the mark, `--brand-solid` carries white text, `--brand-ink` is
 * the colour as text on a light surface, and the three washes are backgrounds.
 * The first version of white-labelling set `--brand` alone, which meant a
 * school picked a colour and almost nothing on screen changed — the buttons,
 * the active navigation item and every pill are drawn with the other five, so
 * they stayed our teal. White-labelling that repaints the logo and nothing else
 * is not white-labelling.
 *
 * Setting all six to the school's hex is the obvious fix and is worse. The
 * stylesheet says why in its own comment: our teal measures 2.49:1 against
 * white, so white text on it is unreadable, and one hex used for all three
 * roles is how a brand palette ends up with buttons nobody can read. A school
 * that picks a bright yellow must not be handed unreadable buttons because they
 * picked it.
 *
 * So the family is derived. The school's colour is kept exactly as the mark,
 * and the roles that carry text are darkened or lightened until they meet a
 * contrast ratio — the school chooses the hue, we guarantee the legibility.
 */

interface Rgb { r: number; g: number; b: number }

function parseHex(hex: string): Rgb {
  const h = hex.slice(1);
  const full = h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance. sRGB is gamma-encoded, so the channels linearise first. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours. 1 is identical, 21 is black on white. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

function mix(colour: Rgb, towards: Rgb, amount: number): Rgb {
  return {
    r: colour.r + (towards.r - colour.r) * amount,
    g: colour.g + (towards.g - colour.g) * amount,
    b: colour.b + (towards.b - colour.b) * amount,
  };
}

/**
 * Walks towards black until white text on this colour is readable.
 *
 * 4.5:1 is the WCAG AA threshold for body text. Stepping in small increments
 * and stopping at the first colour that clears it keeps as much of the school's
 * hue as legibility allows — a school that picks a deep navy gets their navy
 * back unchanged, and one that picks lemon gets a darker lemon rather than a
 * different colour altogether.
 */
function darkenUntilReadable(colour: Rgb, ratio = 4.5): Rgb {
  const black: Rgb = { r: 0, g: 0, b: 0 };
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(colour, black, step * 0.05);
    if (contrast(candidate, WHITE) >= ratio) return candidate;
  }
  return black;
}

/**
 * Every brand custom property the stylesheet reads, derived from the school's
 * one colour. Returns an empty object when the school has set none, so the
 * product's own palette stands.
 */
export function brandVariables(brand: Brand | null): Record<string, string> {
  const vars: Record<string, string> = {};
  const primary = safeColour(brand?.primaryColour);
  const ink = safeColour(brand?.inkColour);

  if (primary) {
    const base = parseHex(primary);
    // Text on a light surface needs more contrast than a button does, because
    // it has no weight behind it — hence 4.5 for both, but measured against
    // white in each case, and `--brand` itself is left exactly as chosen.
    const readable = darkenUntilReadable(base);
    vars['--brand'] = primary;
    vars['--brand-solid'] = toHex(readable);
    vars['--brand-ink'] = toHex(readable);
    vars['--brand-wash'] = toHex(mix(base, WHITE, 0.82));
    vars['--brand-track'] = toHex(mix(base, WHITE, 0.82));
    vars['--brand-soft'] = toHex(mix(base, WHITE, 0.94));
  }
  if (ink) vars['--ink-1'] = ink;
  return vars;
}
