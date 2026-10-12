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
      keyframes: {
        'toast-in': { from: { opacity: 0, transform: 'translateY(8px)' }, to: { opacity: 1, transform: 'none' } },
      },
      animation: { 'toast-in': 'toast-in .18s ease-out' },
    },
  },
  plugins: [],
};
