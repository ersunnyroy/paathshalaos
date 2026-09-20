/**
 * Turning a person's search box into a LIKE pattern.
 *
 * Postgres `LIKE`/`ILIKE` treats `%` and `_` as wildcards, so a term pasted
 * straight into a pattern lets the caller change what the query means. A parent
 * searching help for "100%" finds nothing that mentions it and everything that
 * does not; a staff member typing `%` into the learner search gets the whole
 * school back in one request.
 *
 * That second one is not an injection — the row-level security policy still
 * decides which rows are legible, so nobody sees a child they could not
 * otherwise see. It is a filter the caller can switch off, which is a different
 * and duller problem: the screen stops meaning what it says, and the list a
 * teacher screenshots is not the list they asked for.
 *
 * `\` is Postgres's default escape character for LIKE, so no `ESCAPE` clause is
 * needed — but the backslash itself has to be escaped first or a term ending in
 * one escapes the closing `%`.
 *
 * This lived in `console.service.ts` and nowhere else. The console escaped, the
 * learner search did not, and the help-centre search did not: one question with
 * three answers, two of them wrong. A test for the console's version had
 * existed since M15 and said nothing about the other two, which is the
 * argument for the function having one home (M36).
 */
export function likeLiteral(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
