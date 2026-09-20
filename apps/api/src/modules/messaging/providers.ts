/**
 * Where a message actually goes.
 *
 * There is no SMS or WhatsApp gateway in this system. M26 is the milestone
 * that buys one and it is blocked on a commercial relationship, not on code.
 * Until then the honest provider is this one: it refuses every channel that
 * needs a gateway, and M9's fallback chain lands the message on `in_app`,
 * which is a real delivery — the family sees it in the parent app.
 *
 * The alternative, a provider that pretends to send an SMS and returns a
 * fabricated message id, would make `delivery_receipt` a fiction and the
 * messages screen a screen of lies. A school would find out when a parent did
 * not turn up to a meeting.
 *
 * `name` is recorded on every attempt, so when a gateway does arrive the rows
 * sent this way are identifiable rather than indistinguishable from real ones.
 */
import type { SendProvider } from './dispatch.service.ts';

export const inAppOnlyProvider: SendProvider = {
  name: 'in-app-only',
  async send(input) {
    if (input.channel !== 'in_app') {
      // Thrown, not returned: the dispatcher's fallback chain treats a throw
      // as "this channel did not work, try the next one", which is exactly
      // what is true here.
      throw new Error(`${input.channel}_has_no_gateway`);
    }
    return { providerMessageId: `inapp-${crypto.randomUUID()}` };
  },
};
