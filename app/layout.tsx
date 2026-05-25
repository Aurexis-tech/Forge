// Root layout. Bare-bones — just the html/body shell + globals.
//
// The chrome (persistent 3D world, in-app nav header) lives in
// app/(app)/layout.tsx so it ONLY wraps signed-in routes. The public
// landing at "/" and the auth flows at /sign-in, /auth/* render outside
// the chrome.

import type { Metadata, Viewport } from 'next';
import './globals.css';

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
    <html lang="en">
      <body className="min-h-screen overflow-x-hidden bg-forge-void text-forge-text">
        {children}
      </body>
    </html>
  );
}
