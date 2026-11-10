'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { login, currentToken, loadBrand, ApiError } from '@/lib/api';
import { brandVariables, type Brand } from '@/lib/brand';
import { Lockup } from '@/components/ui';

/**
 * The demo accounts, on the screen.
 *
 * Not a shortcut past the login: each one signs in through the real endpoint
 * with a real password. They are here because the point of the demo is that the
 * SAME screens return different rows per role, and that is only obvious if
 * switching between them takes one click.
 */
const ACCOUNTS = [
  { email: 'principal@demo.school', role: 'Principal', sees: 'Everything' },
  { email: 'accounts@demo.school', role: 'Accountant', sees: 'Including money' },
  { email: 'teacher@demo.school', role: 'Teacher', sees: 'No fees at all' },
  { email: 'parent@demo.school', role: 'Parent', sees: 'Their own children' },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(ACCOUNTS[0]!.email);
  const [password, setPassword] = useState('demo-password-1234');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState<Brand | null | undefined>(undefined);

  useEffect(() => {
    // Before the form, not alongside it: this screen belongs to the school,
    // and showing ours first and theirs a moment later is worse than waiting.
    loadBrand()
      .then((resolved) => {
        setBrand(resolved);
        // Applied to the document rather than to this element, so the colours
        // hold for every screen after sign-in too. Each value is re-validated
        // as hex on the way in — see safeColour.
        for (const [name, value] of Object.entries(brandVariables(resolved))) {
          document.documentElement.style.setProperty(name, value);
        }
      })
      .catch(() => setBrand(null));
  }, []);

  useEffect(() => {
    if (currentToken()) router.replace('/dashboard');
  }, [router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        {/* The supplied lockup carries the name and the strapline already, so
            the card sets it once and adds only the tenant beneath it. */}
        <div style={{ marginBottom: 20 }}>
          {/* The school's own mark when they have uploaded one, ours when they
              have not. A white-labelled product that shows the vendor's logo on
              the sign-in page is not white-labelled. */}
          {brand?.logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={brand.logoUrl} alt={brand.name} style={{ height: 34 }} />
            : <Lockup height={34} />}
          <div className="sub" style={{ marginTop: 8 }}>
            {brand === undefined ? ' ' : brand?.name ?? 'Unregistered address'}
          </div>
        </div>

        <form onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} autoComplete="username"
                 onChange={(e) => setEmail(e.target.value)} />

          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} autoComplete="current-password"
                 onChange={(e) => setPassword(e.target.value)} />

          {error ? <div className="note bad" style={{ marginTop: 14 }}>{error}</div> : null}
          {brand === null ? (
            <div className="note bad" style={{ marginTop: 14 }}>
              <span>
                No school is registered at this address. If you are developing,
                set <code>NEXT_PUBLIC_BRAND_HOST</code> to a school&rsquo;s
                hostname in <code>apps/web/.env.local</code>.
              </span>
            </div>
          ) : null}

          <button className="primary" type="submit" disabled={busy || !brand}
                  style={{ width: '100%', marginTop: 16, justifyContent: 'center' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {brand?.supportEmail || brand?.supportPhone ? (
          <div className="sub" style={{ marginTop: 16, fontSize: 12 }}>
            Trouble signing in? {brand.supportEmail ?? ''}
            {brand.supportEmail && brand.supportPhone ? ' · ' : ''}
            {brand.supportPhone ?? ''}
          </div>
        ) : null}

        {/* Not a setting. A school can put its own name on this; it cannot
            claim to have built it. */}
        <div className="powered-by">Powered by paathshalaOS</div>
      </div>

      {/* The demo accounts belong to the seeded demo, not to a school whose
          parents are signing in. Shown only in development. */}
      {process.env.NODE_ENV === 'development' ? (
      <div className="auth-side">
        <p className="sub" style={{ margin: '0 0 8px' }}>
          Four accounts, one password. The screens differ because the database
          returns different rows — nothing is hidden in the interface.
        </p>
        <div className="accounts">
          {ACCOUNTS.map((a) => (
            <button key={a.email} type="button"
                    className={email === a.email ? 'account on' : 'account'}
                    onClick={() => setEmail(a.email)}>
              <span>
                <strong>{a.role}</strong>
                <span className="sub" style={{ display: 'block' }}>{a.email}</span>
              </span>
              <span className="sub">{a.sees}</span>
            </button>
          ))}
        </div>
      </div>
      ) : null}
    </div>
  );
}
