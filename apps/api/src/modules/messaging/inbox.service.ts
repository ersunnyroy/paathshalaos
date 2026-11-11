/**
 * What the school has sent ME (M43.1).
 *
 * The messaging module is written from the office's side: templates, sends,
 * outcomes. This is the other end of the same rows — one person's own
 * messages, whoever they are. A teacher has an inbox as much as a parent does.
 *
 * Every query names `app_current_person_id()` itself. Row-level security would
 * already hide other people's rows from a guardian, but it opens the whole
 * table to staff, so without the filter a teacher's "inbox" would be every
 * message the school has ever sent.
 */
import { withTenant, type TenantScope } from '../../db/tenant.ts';

/**
 * Sent, as far as the recipient is concerned. `read` is a provider's read
 * receipt and is the strongest evidence of arrival there is; `failed` and
 * `suppressed` never reached anybody and are the office's record, not an inbox.
 */
const ARRIVED = `('sent', 'delivered', 'read')`;

export interface InboxItem {
  id: string; channel: string | null; body: string | null;
  /** The learner the message is about, when it is about one. */
  about: string | null;
  sent_at: string; read_at: string | null;
}

export interface InboxCursor { sentAt: string; id: string }

export const inboxService = {
  /**
   * Newest first, keyset on (created_at, id). `before` is the last row of the
   * previous page; the id breaks ties, because a send to a family of three
   * writes three rows in the same microsecond.
   */
  async mine(scope: TenantScope, input: {
    limit: number; before?: InboxCursor | undefined;
  }): Promise<InboxItem[]> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<InboxItem>(
        `SELECT mr.id, mr.channel, mr.rendered_body AS body,
                sp.given_name AS about,
                -- Microseconds kept, as text: a JS Date would round the cursor
                -- to milliseconds and the next page would repeat a row.
                to_char(mr.created_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sent_at,
                mr.read_at
           FROM message_recipient mr
           LEFT JOIN person sp ON sp.id = mr.subject_person_id
          WHERE mr.person_id = app_current_person_id()
            AND mr.status IN ${ARRIVED}
            AND ($2::timestamptz IS NULL
                 OR (mr.created_at, mr.id) < ($2::timestamptz, $3::uuid))
          ORDER BY mr.created_at DESC, mr.id DESC
          LIMIT $1`,
        [input.limit, input.before?.sentAt ?? null, input.before?.id ?? null]);
      return rows;
    });
  },

  /** How many the caller has not read. What the bell shows. */
  async unread(scope: TenantScope): Promise<number> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM message_recipient mr
          WHERE mr.person_id = app_current_person_id()
            AND mr.status IN ${ARRIVED}
            AND mr.read_at IS NULL`);
      return rows[0]?.n ?? 0;
    });
  },

  /**
   * Marks one of the caller's messages read, or all of them when no id is
   * given. Returns how many changed: 0 for somebody else's message, one that
   * was already read, or one that does not exist — the caller is not told
   * which, because the difference is whether another person's message exists.
   */
  async markRead(scope: TenantScope, id: string | null): Promise<number> {
    return withTenant(scope, async (db) => {
      const { rows } = await db.query<{ n: number }>(
        'SELECT mark_my_messages_read($1::uuid) AS n', [id]);
      return rows[0]?.n ?? 0;
    });
  },
};
