'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, SkeletonRows, Empty, Icon } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface Endpoint {
  id: string; url: string; description: string | null;
  event_types: string[]; status: string;
  secret_rotated_at: string | null; created_at: string;
}
interface Delivery {
  id: string; webhook_endpoint_id: string; event_type: string;
  status: string; attempt_count: number; next_attempt_at: string;
  last_error: string | null; succeeded_at: string | null; created_at: string;
}
interface ApiKey {
  id: string; prefix: string; last_four: string; label: string | null;
  created_at: string; expires_at: string | null; revoked_at: string | null;
  last_used_at: string | null;
}

const TONE: Record<string, 'good' | 'warning' | 'critical' | undefined> = {
  succeeded: 'good', active: 'good',
  pending: 'warning', paused: 'warning',
  dead: 'critical', failed: 'critical', disabled: 'critical',
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function IntegrationsPage() {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * A secret shown once, held in component state and never stored. Putting it
   * in localStorage so it survives a refresh is the obvious convenience and
   * exactly the wrong one — it would outlive the moment it is needed, on a
   * shared office machine.
   */
  const [revealed, setRevealed] = useState<{ what: string; value: string } | null>(null);

  const load = useCallback(() => {
    // apiGet already unwraps the envelope's `data`, so these are the arrays
    // themselves. Typing them as `{ data: T[] }` here set every list to
    // undefined and left the page skeletonised for ever — with three 200s in
    // the network panel and nothing in the console.
    Promise.all([
      apiGet<Endpoint[]>('/v1/integrations/webhooks'),
      apiGet<Delivery[]>('/v1/integrations/webhooks/deliveries'),
      apiGet<ApiKey[]>('/v1/integrations/keys'),
    ])
      .then(([e, d, k]) => { setEndpoints(e); setDeliveries(d); setKeys(k); })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  async function replay(id: string) {
    try {
      await apiPost(`/v1/integrations/webhooks/deliveries/${id}/replay`, {});
      load();
    } catch (e) { setError((e as Error).message); }
  }

  async function rotate(id: string) {
    try {
      const res = await apiPost<{ secret: string }>(
        `/v1/integrations/webhooks/${id}/rotate`, {});
      setRevealed({ what: 'New signing secret', value: res.secret });
      load();
    } catch (e) { setError((e as Error).message); }
  }

  const byEndpoint = (id: string) => endpoints?.find((e) => e.id === id)?.url ?? '—';

  return (
    <Shell>
      <PageHead
        title="Integrations"
        lede="API keys, webhook endpoints, and every delivery we attempted — with what your server said back."
      />

      {error ? <div className="note bad">{error}</div> : null}

      {revealed ? (
        <div className="note" style={{ marginBottom: 12 }}>
          <span>
            <strong>{revealed.what}</strong> — shown once, and not stored anywhere in
            this browser. Copy it now.
            <code style={{ display: 'block', marginTop: 6, wordBreak: 'break-all' }}>
              {revealed.value}
            </code>
          </span>
        </div>
      ) : null}

      <Panel
        title="Webhook endpoints"
        hint="Where we send events. https only, and never an address inside your network."
      >
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th className="opt">Events</th>
                <th>Status</th>
                <th className="n opt">Secret rotated</th>
                <th className="n w" />
              </tr>
            </thead>
            {endpoints ? (
              <tbody>
                {endpoints.map((e) => (
                  <tr key={e.id}>
                    <td style={{ wordBreak: 'break-all' }}>{e.url}</td>
                    <td className="opt">{e.event_types.join(', ')}</td>
                    <td><Pill tone={TONE[e.status]}>{e.status}</Pill></td>
                    <td className="n opt">{when(e.secret_rotated_at)}</td>
                    <td className="n w">
                      <button type="button" onClick={() => rotate(e.id)}>Rotate</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={2} cols={5} />}
          </table>
        </div>
        {endpoints?.length === 0 ? (
          <Empty title="No endpoints yet">
            Add one to start receiving events. You will be shown a signing secret
            once — your server uses it to check that a delivery really came from us.
          </Empty>
        ) : null}
      </Panel>

      <Panel
        title="Deliveries"
        hint="Every attempt is on the record, including the ones that failed"
      >
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th className="opt">Endpoint</th>
                <th>Status</th>
                <th className="n">Attempts</th>
                <th className="opt">Last error</th>
                <th className="n w" />
              </tr>
            </thead>
            {deliveries ? (
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td>{d.event_type}</td>
                    <td className="opt" style={{ wordBreak: 'break-all' }}>
                      {byEndpoint(d.webhook_endpoint_id)}
                    </td>
                    <td><Pill tone={TONE[d.status]}>{d.status}</Pill></td>
                    <td className="n">{d.attempt_count}</td>
                    <td className="opt muted">{d.last_error ?? '—'}</td>
                    <td className="n w">
                      {d.status === 'dead' ? (
                        <button type="button" onClick={() => replay(d.id)}>Replay</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={4} cols={6} />}
          </table>
        </div>
        {deliveries?.length === 0 ? (
          <Empty title="Nothing sent yet">
            Deliveries appear here as soon as an endpoint is subscribed to an
            event that happens.
          </Empty>
        ) : null}
        <div className="caption">
          <Icon.check />
          A replay re-sends the original bytes under the original delivery id, so
          a receiver that de-duplicates will not count the event twice.
        </div>
      </Panel>

      <Panel title="API keys" hint="The secret is shown once, at creation, and never again">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th className="opt">Label</th>
                <th className="n opt">Created</th>
                <th className="n opt">Last used</th>
                <th>Status</th>
              </tr>
            </thead>
            {keys ? (
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    {/* The prefix and last four, which is enough to say WHICH key
                        in a conversation and not enough to use it. */}
                    <td><code>{k.prefix}…{k.last_four}</code></td>
                    <td className="opt">{k.label ?? '—'}</td>
                    <td className="n opt">{when(k.created_at)}</td>
                    <td className="n opt">{when(k.last_used_at)}</td>
                    <td>
                      {k.revoked_at
                        ? <Pill tone="critical">revoked</Pill>
                        : <Pill tone="good">active</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={2} cols={5} />}
          </table>
        </div>
        {keys?.length === 0 ? (
          <Empty title="No keys issued">
            An API key lets another system read from this school. Only an
            organisation owner can create one.
          </Empty>
        ) : null}
      </Panel>
    </Shell>
  );
}
