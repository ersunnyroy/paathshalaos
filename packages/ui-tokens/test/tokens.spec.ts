/**
 * The tokens package has one job: be the only copy.
 *
 * So the tests are about the copies. The stylesheet the web app actually
 * imports must be exactly what this package generates, both dark blocks must
 * carry every token the light block does (a token missing from dark silently
 * keeps its light value on a dark surface), and the mobile names must resolve
 * to real colours.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { light, dark, native, tokensCss } from '../src/index.ts';

const cssPath = fileURLToPath(new URL('../../../apps/web/src/app/tokens.css', import.meta.url));

describe('the web stylesheet', () => {
  it('is exactly what the package generates', () => {
    if (process.env['UPDATE_TOKENS'] === '1') writeFileSync(cssPath, tokensCss());
    expect(readFileSync(cssPath, 'utf8')).toBe(tokensCss());
  });

  it('declares the dark palette under the OS preference and under the toggle', () => {
    const css = tokensCss();
    const brandDark = `--brand: ${dark['--brand']};`;
    expect(css.split(brandDark).length - 1).toBe(2);
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
  });
});

describe('the palettes', () => {
  it('give every colour token a dark value', () => {
    const colourTokens = Object.entries(light)
      .filter(([, value]) => /^#|rgb\(/.test(value))
      .map(([name]) => name);
    expect(colourTokens.length).toBeGreaterThan(20);
    for (const name of colourTokens) expect(dark, name).toHaveProperty(name);
  });

  it('never introduce a dark-only token', () => {
    for (const name of Object.keys(dark)) expect(light, name).toHaveProperty(name);
  });
});

describe('the mobile names', () => {
  it('are all six-digit hex colours taken from the light palette', () => {
    const values = new Set<string>(Object.values(light));
    for (const [name, value] of Object.entries(native)) {
      expect(value, name).toMatch(/^#[0-9A-F]{6}$/);
      expect(values.has(value), name).toBe(true);
    }
  });
});
