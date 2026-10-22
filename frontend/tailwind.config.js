/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta de la marca Purissima
        //   700 = #165099  azul oscuro del logo
        //   400 = #37b6ff  azul claro del logo
        agua: {
          50: '#f1f8ff',
          100: '#e2f0ff',
          200: '#c0e4ff',
          300: '#8fd1ff',
          400: '#37b6ff',
          500: '#1d9bea',
          600: '#1a7bc4',
          700: '#165099',
          800: '#123f78',
          900: '#0d2f59',
        },
      },
    },
  },
  plugins: [],
};
