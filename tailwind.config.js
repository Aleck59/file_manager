/** @type {import('tailwindcss').Config} */
export default {
  content: ['./public/**/*.{html,js}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eefbf6', 100: '#d5f5e8', 200: '#aeead5', 300: '#78d9bc', 400: '#41c19f',
          500: '#1ea685', 600: '#11866c', 700: '#0f6b59', 800: '#105548', 900: '#0f463c', 950: '#062823',
        },
      },
      // Рамки и разделители на ступень контрастнее основной палитры slate:
      // светлые тона в светлой теме и тёмные в тёмной иначе сливаются с фоном.
      borderColor: {
        slate: {
          50: '#f1f5f9', 100: '#e2e8f0', 200: '#cbd5e1', 300: '#b6c2d1', 400: '#94a3b8',
          500: '#64748b', 600: '#475569', 700: '#475569', 800: '#334155', 900: '#1e293b', 950: '#0f172a',
        },
      },
      keyframes: {
        'toast-in': { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
      },
      animation: { 'toast-in': 'toast-in .18s ease-out' },
    },
  },
  plugins: [],
};
