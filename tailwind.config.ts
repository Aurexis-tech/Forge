import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        forge: {
          void: '#05060a',
          deep: '#0a0d14',
          panel: 'rgba(14, 18, 28, 0.55)',
          amber: '#ff9a4d',
          'amber-soft': '#ffb578',
          cyan: '#4fd4f0',
          'cyan-soft': '#7be4f5',
          text: '#e7ecf3',
          dim: '#8a93a6',
          faint: '#5b6475',
        },
        // The heat spectrum — coolest ember → brightest molten spark.
        // Reserved for meaning (forging, gates, live, pipeline cooling);
        // never decoration. Backed by the CSS variables in globals.css.
        heat: {
          coal: 'var(--heat-coal)',
          ember: 'var(--heat-ember)',
          glow: 'var(--heat-glow)',
          molten: 'var(--heat-molten)',
          spark: 'var(--heat-spark)',
        },
        cool: {
          cyan: 'var(--cool-cyan)',
          deep: 'var(--cool-deep)',
        },
      },
      fontFamily: {
        // Brand fonts only (loaded via next/font in app/layout.tsx). No
        // Inter/Roboto/Arial. Display = Fraunces (headings), body =
        // Spectral (prose), mono = IBM Plex Mono (labels/eyebrows).
        sans: ['var(--font-body)', 'Spectral', 'Georgia', 'serif'],
        body: ['var(--font-body)', 'Spectral', 'Georgia', 'Cambria', 'serif'],
        mono: [
          'var(--font-mono)',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
        display: [
          'var(--font-display)',
          'Spectral',
          'Georgia',
          'Cambria',
          'Times New Roman',
          'serif',
        ],
      },
      boxShadow: {
        glass:
          '0 1px 0 rgba(255,255,255,0.06) inset, 0 0 0 1px rgba(255,255,255,0.04), 0 30px 80px -20px rgba(0,0,0,0.6)',
        amber: '0 0 40px -6px rgba(255,154,77,0.45)',
        cyan: '0 0 40px -6px rgba(79,212,240,0.45)',
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};

export default config;
