'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { login, currentToken, tenantId, ApiError } from '@/lib/api';
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
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(ACCOUNTS[0]!.email);
  const [password, setPassword] = useState('demo-password-1234');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          <Lockup height={34} />
          <div className="sub" style={{ marginTop: 8 }}>Demo Vidyalaya</div>
        </div>

        <form onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} autoComplete="username"
                 onChange={(e) => setEmail(e.target.value)} />

          <label htmlFor="password">Password</label>
          <input id="password" type="password" value={password} autoComplete="current-password"
                 onChange={(e) => setPassword(e.target.value)} />

          {error ? <div className="note bad" style={{ marginTop: 14 }}>{error}</div> : null}
          {!tenantId() ? (
            <div className="note bad" style={{ marginTop: 14 }}>
              <span>
                <code>NEXT_PUBLIC_TENANT_ID</code> is empty. Run <code>pnpm db:seed</code> and
                copy the tenant id into <code>apps/web/.env.local</code>.
              </span>
            </div>
          ) : null}

          <button className="primary" type="submit" disabled={busy}
                  style={{ width: '100%', marginTop: 16, justifyContent: 'center' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>

      <div className="auth-side">
        <p className="sub" style={{ margin: '0 0 8px' }}>
          Three accounts, one password. The screens differ because the database
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
    </div>
  );
}
