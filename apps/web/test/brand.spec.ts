/**
 * Resolving a school from the address bar (M19.3).
 *
 * The two things worth testing here are both about trust. Which host we ask
 * about — because getting that wrong in development silently asks about the
 * wrong school, and getting it wrong in production asks about none. And what a
 * colour is allowed to be — because these values are written into a CSS custom
 * property in the browser, on a page served under a school's own domain, and a
 * colour is a perfectly good place to hide something that is not one.
 */
import { describe, it, expect } from 'vitest';
import { brandHost, safeColour, brandVariables, contrast, type Brand } from '../src/lib/brand.ts';

describe('which host identifies the school', () => {
  it('uses the address bar in production', () => {
    expect(brandHost('stjosephs.paathshala.app', undefined))
      .toBe('stjosephs.paathshala.app');
    // A configured value must NOT win over a real host: a deployment that
    // shipped with a stale override would serve every school the same brand.
    expect(brandHost('stjosephs.paathshala.app', 'somewhere-else.example'))
      .toBe('stjosephs.paathshala.app');
  });

  it('falls back to the configured host only on localhost', () => {
    // Everything runs on localhost in development and it identifies nothing.
    expect(brandHost('localhost:3000', 'demo.paathshala.app'))
      .toBe('demo.paathshala.app');
    expect(brandHost('127.0.0.1:3000', 'demo.paathshala.app'))
      .toBe('demo.paathshala.app');
  });

  it('asks about localhost rather than nothing when no override is set', () => {
    // Which resolves to no school, and the sign-in screen says so — better
    // than silently asking about a school somebody else configured.
    expect(brandHost('localhost:3000', undefined)).toBe('localhost:3000');
  });
});

describe('a colour cannot carry a payload', () => {
  it('accepts the shapes a designer uses', () => {
    for (const good of ['#14B8A6', '#fff', '#0F172A', '#ABC']) {
      expect(safeColour(good)).toBe(good);
    }
  });

  it('refuses anything else, including things that start like a colour', () => {
    // The API validates this and a column check refuses it too. This is the
    // third check, at the point of use, because that is where the consequence
    // lands: script execution on a page served under the school's domain.
    for (const bad of [
      '#fff; background: url(javascript:alert(1))',
      '#fff}body{display:none',
      'red', 'rgb(1,2,3)', '#12345', 'var(--x)', 'expression(alert(1))',
      '', null, undefined,
    ]) {
      expect(safeColour(bad)).toBeNull();
    }
  });

  it('drops an unsafe colour rather than the whole brand', () => {
    // A school with one bad value should still get its name and mark; the
    // colour is what is discarded.
    const brand = {
      tenantId: 't', name: 'School', logoUrl: null, logoDarkUrl: null,
      primaryColour: '#fff; background: url(x)', inkColour: '#0F172A',
      supportEmail: null, supportPhone: null, poweredBy: 'paathshalaOS',
    } as Brand;
    expect(brandVariables(brand)).toEqual({ '--ink-1': '#0F172A' });
  });

  it('sets nothing at all when there is no brand', () => {
    expect(brandVariables(null)).toEqual({});
  });
});

describe('the palette derived from a school’s one colour', () => {
  const withColour = (hex: string) => brandVariables({
    tenantId: 't', name: 'School', logoUrl: null, logoDarkUrl: null,
    primaryColour: hex, inkColour: null,
    supportEmail: null, supportPhone: null, poweredBy: 'paathshalaOS',
  } as Brand);

  it('sets every brand token the stylesheet reads', () => {
    // The first version set `--brand` alone. Buttons, the active navigation
    // item and every pill are drawn with the other five, so a school picked a
    // colour and almost nothing changed. Naming them here is what stops that
    // regressing when a token is added to the stylesheet.
    expect(Object.keys(withColour('#B45309')).sort()).toEqual([
      '--brand', '--brand-ink', '--brand-soft', '--brand-solid',
      '--brand-track', '--brand-wash',
    ]);
  });

  it('keeps the school’s colour exactly, as the mark', () => {
    expect(withColour('#B45309')['--brand']).toBe('#B45309');
    // Three-digit hex is valid CSS and must survive the round trip.
    expect(withColour('#f90')['--brand']).toBe('#f90');
  });

  it('guarantees white text is readable on the solid colour', () => {
    // The whole reason the palette is derived rather than copied. A school
    // that picks lemon yellow must not be handed unreadable buttons.
    for (const hex of ['#FFFF00', '#00FF00', '#7DD3FC', '#B45309', '#0F172A', '#fff']) {
      const solid = withColour(hex)['--brand-solid']!;
      const rgb = {
        r: parseInt(solid.slice(1, 3), 16),
        g: parseInt(solid.slice(3, 5), 16),
        b: parseInt(solid.slice(5, 7), 16),
      };
      expect(contrast(rgb, { r: 255, g: 255, b: 255 })).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('leaves a colour that is already dark enough alone', () => {
    // A school that picked a deep navy gets their navy back, not a black
    // approximation of it. Darkening what does not need darkening is how a
    // palette quietly converges on the same grey for everybody.
    expect(withColour('#0F172A')['--brand-solid']).toBe('#0f172a');
  });

  it('makes the washes light enough to put text on', () => {
    for (const hex of ['#FFFF00', '#0F172A', '#B45309']) {
      const wash = withColour(hex)['--brand-wash']!;
      const rgb = {
        r: parseInt(wash.slice(1, 3), 16),
        g: parseInt(wash.slice(3, 5), 16),
        b: parseInt(wash.slice(5, 7), 16),
      };
      // Dark ink on the wash, which is what a pill actually is.
      expect(contrast(rgb, { r: 15, g: 23, b: 42 })).toBeGreaterThanOrEqual(4.5);
    }
  });
});
