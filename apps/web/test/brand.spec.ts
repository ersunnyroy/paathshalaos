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
import { brandHost, safeColour, brandVariables, type Brand } from '../src/lib/brand.ts';

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
