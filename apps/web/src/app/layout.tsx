import type { ReactNode } from 'react';
import './globals.css';

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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
