'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiGet, clearSession, currentToken, onSignedOut, loadBrand } from '@/lib/api';
import { brandVariables, type Brand } from '@/lib/brand';
import { Icon, Mark } from '@/components/ui';

interface Me {
  tenantId: string;
  actorId: string;
  roles: string[];
  /** Present only when this token was minted by the platform console (M15.3). */
  impersonation?: { id: string; writeEnabled: boolean };
}

/**
 * Navigation, grouped.
 *
 * The groups are not decoration: "Daily" is what a class teacher opens every
 * morning and "Money" is what they never open at all. Putting them in one flat
 * list makes every role scan the same wall of items looking for their two.
 */
const GROUPS: Array<{ title: string; items: Array<{ href: string; label: string; icon: (p: { className?: string }) => ReactNode }> }> = [
  {
    title: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', icon: Icon.dashboard }],
  },
  {
    title: 'Daily',
    items: [
      { href: '/students', label: 'Learners', icon: Icon.learners },
      { href: '/attendance', label: 'Attendance', icon: Icon.attendance },
      { href: '/transport', label: 'Transport', icon: Icon.bus },
    ],
  },
  {
    title: 'Academics',
    items: [
      { href: '/learning', label: 'Classwork', icon: Icon.book },
      { href: '/results', label: 'Results', icon: Icon.award },
    ],
  },
  {
    title: 'Money',
    items: [{ href: '/fees', label: 'Fees', icon: Icon.fees }],
  },
  {
    title: 'Operations',
    items: [
      { href: '/messages', label: 'Messages', icon: Icon.send },
      { href: '/imports', label: 'Imports', icon: Icon.upload },
    ],
  },
  {
    title: 'Setup',
    items: [
      { href: '/setup', label: 'Getting started', icon: Icon.check },
      { href: '/support', label: 'Support', icon: Icon.help },
      { href: '/integrations', label: 'Integrations', icon: Icon.plug },
      { href: '/developers', label: 'Developers', icon: Icon.code },
      { href: '/trust', label: 'Trust', icon: Icon.shield },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items);
const THEME_KEY = 'paathshala.theme';

export function Shell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  const [brand, setBrand] = useState<Brand | null>(null);

  useEffect(() => {
    // Also here, not only on the sign-in screen: somebody who arrives with a
    // live session never passes through sign-in, and the school's name and
    // colours have to be right for them too.
    loadBrand()
      .then((resolved) => {
        setBrand(resolved);
        for (const [name, value] of Object.entries(brandVariables(resolved))) {
          document.documentElement.style.setProperty(name, value);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // Null means "follow the OS". Only an explicit choice is stored, so someone
    // who has not chosen still gets dark mode when their machine switches.
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') setTheme(stored);
    } catch { /* private browsing; the OS setting still applies */ }
  }, []);

  useEffect(() => {
    // Registered before the first request, so a session that ends mid-screen
    // lands on sign-in rather than on a page of failed fetches. The shared
    // client only calls this when the session is genuinely over — a refresh
    // that fails on the network leaves the user signed in, because a tunnel is
    // not a security event and a teacher mid-register should not lose it.
    onSignedOut(() => {
      clearSession();
      router.replace('/');
    });
  }, [router]);

  useEffect(() => {
    if (!currentToken()) {
      router.replace('/');
      return;
    }
    apiGet<Me>('/v1/me').then(setMe).catch(() => {
      // An expired token means sign in again, rather than a screen of empty
      // tables that reads as a school with nobody in it.
      clearSession();
      router.replace('/');
    });
  }, [router]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset['theme'] = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* fine */ }
  }

  const role = me?.roles[0]?.replace(/_/g, ' ').toLowerCase() ?? '';
  const here = ALL.find((i) => i.href === pathname);

  return (
    <div className="app" data-entry={me?.impersonation ? '1' : undefined}>
      <nav className="nav" aria-label="Main">
        <button className="workspace" type="button"
                title={brand?.name ?? 'Your school'}>
          {brand?.logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={brand.logoUrl} alt="" style={{ height: 24, width: 24, objectFit: 'contain' }} />
            : <Mark size={24} />}
          <span className="meta">
            <span className="nm">{brand?.name ?? '…'}</span>
            <span className="role">{role || ' '}</span>
          </span>
          <Icon.chevron className="chev" />
        </button>

        {/* Scrolls independently of the workspace pill above and the footer
            below, so a long nav cannot push a link off the screen. */}
        <div className="links">
          {GROUPS.map((group) => (
            <div className="nav-group" key={group.title}>
              <h3>{group.title}</h3>
              {group.items.map(({ href, label, icon: Glyph }) => (
                <Link key={href} href={href}
                      aria-current={pathname === href ? 'page' : undefined}>
                  <Glyph />
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </div>

        <div className="foot">
          <button className="ghost" onClick={toggleTheme}
                  aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {theme === 'dark' ? <Icon.sun /> : <Icon.moon />}
            <span>Theme</span>
          </button>
          <button className="ghost" aria-label="Sign out"
                  onClick={() => { clearSession(); router.push('/'); }}>
            <Icon.out />
            <span>Sign out</span>
          </button>
        </div>
      </nav>

      {me?.impersonation ? <EntryBanner writeEnabled={me.impersonation.writeEnabled} /> : null}

      <div className="topbar">
        <Icon.home />
        <Icon.slash />
        <span className="here">{here?.label ?? 'Dashboard'}</span>
        <span className="spacer" />
      </div>

      <main className="page">{children}</main>
    </div>
  );
}

/**
 * The strip that says whose screen this is.
 *
 * It cannot be dismissed, and it is the loudest thing on the page on purpose.
 * The failure it prevents is mundane and expensive: a support agent with six
 * tabs open types a fee waiver into a real school believing it is a demo. Every
 * other control in M15 is about accountability after the fact; this one is the
 * only part that stops the mistake happening.
 *
 * Red for write, amber for read-only, because those are genuinely different
 * situations and a single colour would train people to stop reading it.
 */
function EntryBanner({ writeEnabled }: { writeEnabled: boolean }) {
  return (
    <div className={`entry-banner${writeEnabled ? ' writable' : ''}`} role="alert">
      <Icon.shield />
      <strong>
        {writeEnabled
          ? 'You are inside this school and can change its records.'
          : 'You are inside this school, viewing it as one of its people.'}
      </strong>
      <span>
        Everything you do carries your name and theirs, and the school can see
        this session and end it.
      </span>
    </div>
  );
}

export function PageHead({ title, lede, children }: {
  title: string; lede?: string; children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p>{lede}</p> : null}
      </div>
      {children ? <div className="tools">{children}</div> : null}
    </div>
  );
}
