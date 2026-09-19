'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, SkeletonRows, Empty, Avatar, Icon } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface Ticket {
  id: string; reference: string; subject: string; category: string;
  priority: string; status: string;
  first_response_due_at: string; first_responded_at: string | null;
  resolved_at: string | null; created_at: string;
}
interface ThreadItem {
  id: string; kind: 'message' | 'event';
  body: string; is_internal: boolean;
  author_person_id: string | null; author_name: string | null; at: string;
}
interface Breaches {
  awaiting_first_response: number; response_breached: number;
  resolution_breached: number; open: number;
}
interface Article { id: string; slug: string; title: string; body: string; audience: string }

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | undefined> = {
  open: 'warning', waiting_on_requester: undefined,
  resolved: 'good', closed: 'good',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Markdown, flattened for a one-line preview.
 *
 * Articles are written in markdown and a list row is not the place to render
 * it — but showing the raw `**Attendance**` is worse than either, because it
 * reads as a bug in the product rather than as formatting. So the emphasis
 * marks come off and the text stays.
 */
const plain = (md: string) =>
  md.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** Late, and by how much — the only thing a support queue is really sorted by. */
function overdueBy(ticket: Ticket): string | null {
  if (ticket.first_responded_at) return null;
  const late = Date.now() - Date.parse(ticket.first_response_due_at);
  if (late <= 0) return null;
  const hours = Math.floor(late / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)}d late` : `${Math.max(1, hours)}h late`;
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [breaches, setBreaches] = useState<Breaches | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadItem[] | null>(null);
  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const [query, setQuery] = useState('');
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      apiGet<Ticket[]>('/v1/tickets'),
      apiGet<Breaches>('/v1/tickets/breaches'),
    ])
      .then(([t, b]) => { setTickets(t); setBreaches(b); })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    // Debounced, because a trigram search on every keystroke is a query per
    // character and the answer for "fe" is never the one anybody wanted.
    const id = setTimeout(() => {
      apiGet<Article[]>(`/v1/help?q=${encodeURIComponent(query)}`)
        .then(setArticles)
        .catch(() => setArticles([]));
    }, 220);
    return () => clearTimeout(id);
  }, [query]);

  async function openTicket(id: string) {
    setOpen(id);
    setThread(null);
    try {
      setThread(await apiGet<ThreadItem[]>(`/v1/tickets/${id}/thread`));
    } catch (e) { setError((e as Error).message); }
  }

  async function send() {
    if (!open || draft.trim().length === 0) return;
    setBusy(true);
    try {
      await apiPost(`/v1/tickets/${open}/reply`, { body: draft, internal });
      setDraft('');
      setThread(await apiGet<ThreadItem[]>(`/v1/tickets/${open}/thread`));
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function resolve() {
    if (!open) return;
    try {
      await apiPost(`/v1/tickets/${open}/status`, { status: 'resolved' });
      load();
    } catch (e) { setError((e as Error).message); }
  }

  const current = tickets?.find((t) => t.id === open) ?? null;

  return (
    <Shell>
      <PageHead
        title="Support"
        lede="The queue, sorted by what is late — and the help articles people find before they write to you."
      />

      {error ? <div className="note bad">{error}</div> : null}

      <div className="tiles">
        {([
          ['Open', breaches?.open, undefined],
          ['Awaiting first reply', breaches?.awaiting_first_response, undefined],
          ['Past response time', breaches?.response_breached, 'critical'],
          ['Past resolution time', breaches?.resolution_breached, 'warning'],
        ] as const).map(([label, value, tone]) => (
          <div className="tile" key={label}>
            <div className="top"><span className="k">{label}</span></div>
            <div className="v" style={
              value && value > 0 && tone ? { color: `var(--${tone}-ink)` } : undefined
            }>
              {value === undefined ? '—' : value}
            </div>
          </div>
        ))}
      </div>

      <Panel
        title="Tickets"
        hint="Anything past its first-response time comes first, whatever its date"
        actions={current ? (
          <button type="button" onClick={() => { setOpen(null); setThread(null); }}>
            Back to the queue
          </button>
        ) : null}
      >
        {current ? (
          <div className="thread">
            <div className="thread-head">
              <div style={{ minWidth: 0 }}>
                <strong>{current.subject}</strong>
                <span className="sub" style={{ display: 'block' }}>
                  {current.reference} · {current.category.replace(/_/g, ' ')} ·{' '}
                  raised {when(current.created_at)}
                </span>
              </div>
              <div className="row">
                <Pill tone={STATUS_TONE[current.status]}>
                  {current.status.replace(/_/g, ' ')}
                </Pill>
                {current.status !== 'resolved' && current.status !== 'closed' ? (
                  <button type="button" onClick={resolve}>Mark resolved</button>
                ) : null}
              </div>
            </div>

            {thread ? (
              <ol className="msgs">
                {thread.map((item) => (
                  item.kind === 'event' ? (
                    <li key={item.id} className="ev">
                      {item.body.replace(/_/g, ' ')} · {when(item.at)}
                    </li>
                  ) : (
                    <li key={item.id} className={item.is_internal ? 'msg note' : 'msg'}>
                      {/* The person's name, so the initials mean something. A
                          uuid rendered as initials is noise wearing the shape
                          of information. */}
                      <Avatar name={item.author_name || 'Unknown'} />
                      <div>
                        {item.is_internal ? (
                          <span className="sub">
                            Internal note — the person who raised this cannot see it
                          </span>
                        ) : null}
                        <p>{item.body}</p>
                        <span className="sub">
                          {item.author_name ? `${item.author_name} · ` : ''}
                          {when(item.at)}
                        </span>
                      </div>
                    </li>
                  )
                ))}
              </ol>
            ) : <div className="skel" style={{ height: 120, margin: 15 }} />}

            <div className="composer">
              <textarea
                value={draft} rows={3}
                placeholder="Write a reply…"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <label className="sub" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <input type="checkbox" checked={internal}
                         onChange={(e) => setInternal(e.target.checked)} />
                  Internal note
                </label>
                <button className="primary" type="button" disabled={busy} onClick={send}>
                  {busy ? 'Sending…' : internal ? 'Add note' : 'Reply'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th className="opt">Reference</th>
                    <th>Status</th>
                    <th className="n">First reply</th>
                  </tr>
                </thead>
                {tickets ? (
                  <tbody>
                    {tickets.map((t) => {
                      const late = overdueBy(t);
                      return (
                        <tr key={t.id} onClick={() => openTicket(t.id)}
                            style={{ cursor: 'pointer' }}>
                          <td>{t.subject}</td>
                          <td className="opt"><code>{t.reference}</code></td>
                          <td>
                            <Pill tone={STATUS_TONE[t.status]}>
                              {t.status.replace(/_/g, ' ')}
                            </Pill>
                          </td>
                          <td className="n">
                            {t.first_responded_at
                              ? <span className="muted">{when(t.first_responded_at)}</span>
                              : late
                                ? <Pill tone="critical">{late}</Pill>
                                : <Pill tone="warning">due {when(t.first_response_due_at)}</Pill>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                ) : <SkeletonRows rows={3} cols={4} />}
              </table>
            </div>
            {tickets?.length === 0 ? (
              <Empty title="Nothing waiting">
                Tickets raised from the parent app and by your own staff appear here.
              </Empty>
            ) : null}
          </>
        )}
      </Panel>

      <Panel title="Help articles" hint="What people read instead of writing to you">
        <div style={{ padding: '12px 15px 0' }}>
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search help…" aria-label="Search help"
            style={{ width: '100%' }}
          />
        </div>
        <div className="scroll">
          <table>
            {articles ? (
              <tbody>
                {articles.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.title}</strong>
                      <span className="sub" style={{ display: 'block' }}>
                        {plain(a.body).slice(0, 120)}
                        {plain(a.body).length > 120 ? '…' : ''}
                      </span>
                    </td>
                    <td className="n w">
                      <Pill>{a.audience}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={2} cols={2} />}
          </table>
        </div>
        {articles?.length === 0 ? (
          <Empty title="Nothing matched">
            Try a shorter word — the search matches misspellings, so one or two
            words usually work better than a sentence.
          </Empty>
        ) : null}
        <div className="caption">
          <Icon.check />
          Parents only ever see articles written for them, whatever they search for.
        </div>
      </Panel>
    </Shell>
  );
}
