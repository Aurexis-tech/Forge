// Root layout. Bare-bones — just the html/body shell + globals.
//
// The chrome (persistent 3D world, in-app nav header) lives in
// app/(app)/layout.tsx so it ONLY wraps signed-in routes. The public
// landing at "/" and the auth flows at /sign-in, /auth/* render outside
// the chrome.

import type { Metadata, Viewport } from 'next';
import { Fraunces, Spectral, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// THE BRAND TYPE HIERARCHY (forge design language):
//   display = Fraunces      — headings, the moment-of-arrival serif
//   body    = Spectral      — prose, a calm reading serif
//   mono    = IBM Plex Mono — eyebrows / labels / pipeline / code
// Brand fonts only (no Inter/Roboto/Arial). Exposed as CSS variables;
// globals.css + tailwind point body/heading/mono at them so every page
// (landing + app) inherits the hierarchy without per-component edits.
const display = Fraunces({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal'],
  variable: '--font-display',
  display: 'swap',
});

const body = Spectral({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-body',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Aurexis Forge — describe what you want, the Forge builds it',
  description:
    'Forge agents, systems, software, and infrastructure from plain language. Bring your own key; the Forge runs on your fuel; nothing ships until you approve.',
};

export const viewport: Viewport = {
  themeColor: '#05060a',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body className="min-h-screen overflow-x-hidden bg-forge-void font-body text-forge-text">
        {children}
      </body>
    </html>
  );
}
