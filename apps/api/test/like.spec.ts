/**
 * A search box is not a pattern language.
 *
 * `likeLiteral` existed in `console.service.ts` and only there. The console
 * escaped its search term; the learner search and the help-centre search built
 * their patterns inline with `'%' || $1 || '%'` and did not. One question,
 * three answers, two of them wrong — and a test for the console's version had
 * existed since M15 saying nothing about the other two.
 *
 * Found by writing the assertion for the learner list, not by reading the code
 * (M36): `GET /v1/students?q=%25` returned the whole school.
 *
 * Not a data leak — row-level security still decides which rows are legible,
 * so nobody saw a child they could not otherwise see. A filter the caller can
 * switch off is a duller problem than that and still a real one: the screen
 * stops meaning what it says.
 *
 * Tested here as a function rather than only through the three endpoints,
 * because the endpoints all pass whether or not the escaping happens for every
 * ordinary term — which is most of them.
 */
import { describe, it, expect } from 'vitest';
import { likeLiteral } from '../src/common/like.ts';

describe('a search term is a literal', () => {
  it('wraps an ordinary term', () => {
    expect(likeLiteral('Meher')).toBe('%Meher%');
  });

  it('escapes the wildcard that matches everything', () => {
    // The one that mattered. Unescaped, this pattern is '%%%' — three
    // wildcards, matching every row the policy admits.
    expect(likeLiteral('%')).toBe('%\\%%');
  });

  it('escapes the single-character wildcard', () => {
    // Subtler and just as wrong: "a_c" should not match "abc".
    expect(likeLiteral('a_c')).toBe('%a\\_c%');
  });

  it('escapes the escape character first', () => {
    // A term ending in a backslash would otherwise escape the closing '%' and
    // turn the pattern into an unterminated one — or, worse, a valid one that
    // means something else.
    expect(likeLiteral('C:\\')).toBe('%C:\\\\%');
    expect(likeLiteral('50\\%')).toBe('%50\\\\\\%%');
  });

  it('leaves a term that needs nothing alone', () => {
    for (const plain of ['ADM-001', "O'Brien", 'क्षमा', '100 per cent']) {
      expect(likeLiteral(plain)).toBe(`%${plain}%`);
    }
  });

  it('does not treat an empty term as a wildcard by itself', () => {
    // '%%' matches everything, which is why every caller checks for an empty
    // term BEFORE building a pattern rather than relying on this function to.
    // Asserted so the next reader knows the emptiness check is load-bearing
    // and is not a tidy-up.
    expect(likeLiteral('')).toBe('%%');
  });
});
