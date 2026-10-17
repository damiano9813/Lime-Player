/** Tailwind compilato in ui/vendor/app.css (npm run build:css), invece del CDN.
 *  I colori puntano alle variabili del design system "Xtream Player" definite in tailwind.css. */
const v = (name) => `var(--${name})`;

module.exports = {
  content: ['./ui/index.html', './ui/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        s0: v('surface-0'),
        s1: v('surface-100'),
        s2: v('surface-200'),
        s3: v('surface-300'),
        s4: v('surface-400'),
        line: v('line'),
        'line-strong': v('line-strong'),
        ink: v('ink'),
        'ink-muted': v('ink-muted'),
        'ink-subtle': v('ink-subtle'),
        accent: v('accent'),
        'accent-hover': v('accent-hover'),
        'accent-soft': v('accent-soft'),
        'accent-ink': v('accent-ink'),
        'on-accent': v('on-accent'),
        live: v('live'),
        danger: v('danger'),
        'danger-soft': v('danger-soft'),
        success: v('success'),
        'success-soft': v('success-soft'),
        info: v('info'),
        scrim: v('scrim'),
        glass: v('glass'),
        'glass-line': v('glass-line'),
        'glass-hover': v('glass-hover'),
      },
      fontFamily: {
        sans: ['"Manrope Variable"', 'Manrope', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      boxShadow: {
        pop: v('shadow-pop'),
        glow: v('shadow-glow'),
      },
    },
  },
  plugins: [],
};
