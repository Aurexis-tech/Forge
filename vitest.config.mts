// Vitest configuration for the Aurexis Forge verification layer.
//
// Tests are HERMETIC: no real network, no real DB, no real Anthropic /
// E2B / GitHub / Vercel. The setup file in tests/setup.ts unconditionally
// blanks every external-secrets env var so a forgotten mock can't reach
// a live provider.

import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [
    // Honours the `@/*` alias from tsconfig.json so test files import
    // production modules using the same paths the app does.
    tsconfigPaths(),
  ],
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // Bail out fast on the first hang — these tests must NEVER block on
    // a real network call. A test exceeding 10s is almost certainly
    // misconfigured (e.g. a missing mock making a real fetch).
    testTimeout: 10_000,
    hookTimeout: 10_000,
    setupFiles: ['tests/setup.ts'],
  },
});
