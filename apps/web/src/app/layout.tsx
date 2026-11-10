import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

export const metadata = {
  title: 'paathshalaOS',
  description: 'Institute management, India-first.',
  icons: {
    // All cut from the supplied artwork. The drawn SVG mark that used to sit
    // first here was different geometry, and a tab icon that is not the logo is
    // worse than a slightly softer one.
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-icon.png',
  },
  manifest: '/manifest.webmanifest',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // Both, so the browser chrome matches the surface in either theme rather than
  // leaving a white bar above a dark page.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F1F5F9' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1120' },
  ],
};

/**
 * The theme is applied before first paint.
 *
 * Reading localStorage in an effect means one frame of the wrong theme — a white
 * flash on every navigation for anyone who chose dark. This runs inline, ahead
 * of the stylesheet, and is wrapped so a blocked storage API cannot stop the
 * page rendering at all.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem('paathshala.theme');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t}}catch(e){}`;

/**
 * The offline shell.
 *
 * Only the shell: the worker caches no API response, deliberately, because a
 * roll that looks current and is three weeks old is worse than one that will
 * not load. Attendance marks travel through the IndexedDB queue instead.
 */
const SW_SCRIPT = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* Registered after load so it never competes with the first paint,
            and guarded because a browser without service workers must still
            get a working app — offline is an improvement here, not a
            requirement. */}
        <script dangerouslySetInnerHTML={{ __html: SW_SCRIPT }} />
      </head>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
