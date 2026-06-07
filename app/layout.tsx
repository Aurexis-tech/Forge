// Root layout. Bare-bones — just the html/body shell + globals.
//
// The chrome (persistent 3D world, in-app nav header) lives in
// app/(app)/layout.tsx so it ONLY wraps signed-in routes. The public
// landing at "/" and the auth flows at /sign-in, /auth/* render outside
// the chrome.

import type { Metadata, Viewport } from 'next';
import {
  Fraunces,
  Spectral,
  IBM_Plex_Mono,
  Inter,
  JetBrains_Mono,
} from 'next/font/google';
import './globals.css';
import { ConstellationBackground } from '@/components/lq/ConstellationBackground';

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

// THE AI-FUTURISTIC TYPE HIERARCHY (DORMANT — added alongside the forge
// fonts above). Inter = the new UI/display+body face, JetBrains Mono =
// the new code/label face. Exposed as --font-ui / --font-code and wired
// onto <html> so they're AVAILABLE, but nothing references them yet (the
// body + forge primitives stay on Fraunces/Spectral/IBM Plex Mono until
// pages migrate). Loaded now so the migration prompts have them ready.
const ui = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  style: ['normal'],
  variable: '--font-ui',
  display: 'swap',
});

const code = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  style: ['normal'],
  variable: '--font-code',
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
      className={`${display.variable} ${body.variable} ${mono.variable} ${ui.variable} ${code.variable}`}
    >
      <body className="min-h-screen overflow-x-hidden bg-forge-void font-body text-forge-text">
        {/* Global backdrop — the persistent constellation behind every page. */}
        <ConstellationBackground />
        {/* All page content sits above the zIndex-0 backdrop. */}
        <div className="relative z-[1]">{children}</div>
      </body>
    </html>
  );
}
