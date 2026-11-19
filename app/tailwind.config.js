/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/frontend/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        mint: {
          DEFAULT: '#E8F5E9',
          bold: '#A5D6A7',
        },
        lavender: {
          DEFAULT: '#EDE7F6',
          bold: '#B39DDB',
        },
        peach: {
          DEFAULT: '#FFF3E0',
          bold: '#FFAB91',
        },
        sky: {
          DEFAULT: '#E3F2FD',
          bold: '#90CAF9',
        },
        blush: {
          DEFAULT: '#FCE4EC',
          bold: '#F48FB1',
        },
        cream: '#FFFDF7',
        charcoal: '#2D2D2D',
        sage: '#C5E1A5',
        coral: '#FFCCBC',
      },
      fontFamily: {
        sans: ['Space Grotesk', 'sans-serif'],
        display: ['Archivo Black', 'sans-serif'],
        mono: ['DM Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
