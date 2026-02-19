/** @type {import('tailwindcss').Config} */

import type { Config } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 12px 40px rgba(0,0,0,0.35)",
      },
      fontFamily: {
        // Define a new utility: use as `font-display` in HTML
        display: ['"GothamLight"', 'sans-serif'], 
        // Override the default sans stack: use as `font-sans` in HTML
        sans: ['"Roboto"', ...defaultTheme.fontFamily.sans], 
      },
    },
  },
  plugins: [],
};

