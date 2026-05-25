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
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
