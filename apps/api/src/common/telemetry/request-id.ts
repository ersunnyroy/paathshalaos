/**
 * The id that ties a request to everything it caused (M23.1).
 *
 * Accepted from the caller, because the point of a correlation id is that the
 * web app, the API and the database can all be searched for the same string —
 * but accepted on terms, because a value that arrives in a header is a value
 * somebody chose.
 *
 * Three things go wrong if it is taken as given:
 *
 *   - It is echoed into a response header. Node refuses control characters
 *     there, so a header containing a newline turns a request into a 500 from
 *     inside the framework, with no route and no useful message.
 *   - It is written into every log line. An unbounded value is a caller who can
 *     decide how large the log bill is, and a value containing quotes and
 *     braces is a caller who can write a line that a log search will parse as
 *     structure — the JSON equivalent of log forging.
 *   - It is the key support searches by. A caller who sends the SAME id on
 *     every request makes one person's trail indistinguishable from another's;
 *     that one is not preventable here, which is why the generated id is the
 *     default and the accepted one is a convenience.
 *
 * So the rule is narrow and boring: a bounded run of characters that are safe
 * in a header, a log line and a URL. Anything else is replaced rather than
 * rejected — a malformed correlation id is not worth failing a school's
 * request over, and silently getting a fresh one is what the caller would want.
 */

/** Long enough for a UUID with a prefix, short enough not to be a payload. */
const MAX_LENGTH = 128;

/** Letters, digits, and the three separators every id format in use needs. */
const SAFE = /^[A-Za-z0-9._:-]+$/;

export function normaliseRequestId(
  supplied: unknown,
  generate: () => string,
): string {
  if (typeof supplied !== 'string') return generate();
  const trimmed = supplied.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return generate();
  if (!SAFE.test(trimmed)) return generate();
  return trimmed;
}
