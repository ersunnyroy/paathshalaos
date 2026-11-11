'use client';

import { useEffect, useMemo, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, Icon } from '@/components/ui';

interface Operation {
  operationId: string; summary: string; description: string;
  'x-scopes': string[];
  parameters?: Array<{ name: string; in: string; required: boolean; description?: string }>;
  responses: Record<string, { description: string }>;
}
interface Spec {
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, Operation>>;
  'x-webhook-events': Array<{ type: string; when: string }>;
  'x-webhook-signature': {
    header: string; format: string; algorithm: string;
    tolerance_seconds: number; notes: string[];
  };
}

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

/**
 * Markdown, rendered to the two things the spec's prose actually uses: bold and
 * inline code. A full markdown dependency for `**` and backticks would be more
 * kilobytes than the rest of this page.
 */
function Prose({ text }: { text: string }) {
  // Bold first, then code INSIDE each bold run. The spec's prose contains
  // `**Every write needs an \`Idempotency-Key\`.**` — bold wrapping code — and a
  // single flat split rendered the backticks as literal characters, which on a
  // page whose whole job is to be precise about syntax reads as carelessness.
  const code = (s: string, key: string) =>
    s.split(/(`[^`]+`)/g).map((bit, j) =>
      bit.startsWith('`')
        ? <code key={`${key}-${j}`}>{bit.slice(1, -1)}</code>
        : <span key={`${key}-${j}`}>{bit}</span>);

  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith('**')
          ? <strong key={i}>{code(part.slice(2, -2), `b${i}`)}</strong>
          : <span key={i}>{code(part, `p${i}`)}</span>)}
    </>
  );
}

export default function DevelopersPage() {
  const [spec, setSpec] = useState<Spec | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Fetched from the API rather than bundled, so this page cannot show a
    // contract the running server has moved on from.
    fetch(`${API}/api/v1/openapi.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setSpec)
      .catch((e: Error) => setError(e.message));
  }, []);

  const operations = useMemo(() => {
    if (!spec) return [];
    return Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.entries(ops).map(([method, op]) => ({ path, method, op })));
  }, [spec]);

  return (
    <Shell>
      <PageHead
        title="Developers"
        lede="The integration contract, served by the running API — so this page cannot describe a version of it that no longer exists."
      />

      {error ? (
        <div className="note bad">
          Could not load the spec from {API} — {error}
        </div>
      ) : null}

      {spec ? (
        <>
          <Panel
            title={`${spec.info.title} v${spec.info.version}`}
            hint="Read this part before writing any code"
            actions={<a className="btn" href={`${API}/api/v1/openapi.json`}>openapi.json</a>}
          >
            <div className="prose">
              {spec.info.description.split('\n\n').map((para, i) => (
                <p key={i}><Prose text={para} /></p>
              ))}
            </div>
          </Panel>

          <Panel title="Authentication" hint="One header, two parts">
            <div className="prose">
              <p>
                Send your key as a bearer token. It is{' '}
                <code>&lt;prefix&gt;.&lt;secret&gt;</code> — the prefix identifies the
                key and is safe to put in a log; the half after the dot is shown once,
                when the key is issued, and cannot be retrieved afterwards.
              </p>
              <pre>{`curl -H "Authorization: Bearer pk_live_abc123….<secret>" \\
     '${API}/api/v1/students?limit=50'`}</pre>
              <p>
                Every response carries <code>x-ratelimit-limit</code>,{' '}
                <code>-remaining</code> and <code>-reset</code>. The limit is per
                key rather than per client, so revoking one misbehaving
                integration&rsquo;s key does not throttle its siblings.
              </p>
            </div>
          </Panel>

          <Panel title="Endpoints" hint="Each one names the scope your key needs">
            <div className="ops">
              {operations.map(({ path, method, op }) => (
                <article key={`${method}${path}`} className="op">
                  <header>
                    <span className={`verb ${method}`}>{method.toUpperCase()}</span>
                    <code className="opath">{path}</code>
                    {op['x-scopes'].map((s) => <Pill key={s}>{s}</Pill>)}
                  </header>
                  <p className="sub"><Prose text={op.description} /></p>
                  {op.parameters?.length ? (
                    <dl className="params">
                      {op.parameters.map((p) => (
                        <div key={p.name}>
                          <dt>
                            <code>{p.name}</code>
                            <span className="sub"> {p.in}</span>
                            {p.required ? <Pill tone="warning">required</Pill> : null}
                          </dt>
                          <dd className="sub">{p.description ?? ''}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </article>
              ))}
            </div>
          </Panel>

          <Panel
            title="Verifying a webhook"
            hint="The three mistakes every hand-written verifier makes"
          >
            <div className="prose">
              <p>
                Each delivery carries <code>{spec['x-webhook-signature'].header}</code>{' '}
                in the form <code>{spec['x-webhook-signature'].format}</code>.
                The signature is {spec['x-webhook-signature'].algorithm}.
              </p>
              <ul>
                {spec['x-webhook-signature'].notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
              <pre>{`import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(header, rawBody, secret) {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=').map((s) => s.trim())));
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (age > ${spec['x-webhook-signature'].tolerance_seconds}) return false;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(\`\${parts.t}.\${rawBody}\`).digest('hex'));

  // Every v1 in the header — there are two during a secret rotation.
  return header.split(',')
    .filter((p) => p.trim().startsWith('v1='))
    .map((p) => Buffer.from(p.trim().slice(3)))
    .some((given) =>
      given.length === expected.length && timingSafeEqual(given, expected));
}`}</pre>
              <p>
                De-duplicate on <code>x-paathshala-delivery</code>. Retries re-send
                byte-identical bodies under the same id — including a replay of a
                delivery that had given up — so storing the id is enough.
              </p>
            </div>
          </Panel>

          <Panel title="Events" hint="What we will send you">
            <div className="scroll">
              <table>
                <thead><tr><th>Event</th><th>When</th></tr></thead>
                <tbody>
                  {spec['x-webhook-events'].map((e) => (
                    <tr key={e.type}>
                      <td><code>{e.type}</code></td>
                      <td className="sub">{e.when}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="caption">
              <Icon.check />
              This list is short on purpose. An event is a promise to keep sending
              it, so we add one when somebody needs it rather than in advance.
            </div>
          </Panel>
        </>
      ) : (
        <div className="skel" style={{ height: 320 }} />
      )}
    </Shell>
  );
}
