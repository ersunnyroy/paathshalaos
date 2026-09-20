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

/** Turns a brand into the CSS custom properties the stylesheet already reads. */
export function brandVariables(brand: Brand | null): Record<string, string> {
  const vars: Record<string, string> = {};
  const primary = safeColour(brand?.primaryColour);
  const ink = safeColour(brand?.inkColour);
  if (primary) vars['--brand'] = primary;
  if (ink) vars['--ink-1'] = ink;
  return vars;
}
