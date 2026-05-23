/** Tailwind config for building static CSS (public pages).
 *  Replaces the cdn.tailwindcss.com runtime compiler.
 *  Rebuild after adding new Tailwind classes in public/*.html or *.js:
 *    npx tailwindcss@3 -c tailwind.config.js -i tw.input.css -o public/tw.css --minify
 *  Mirrors the inline config that was used with the CDN (darkMode class + brand colors).
 */
module.exports = {
  darkMode: 'class',
  content: ['./public/**/*.html', './public/**/*.js'],
  theme: {
    extend: {
      colors: {
        darkbg: '#1c1c1c',
        darkcard: '#2a2a2a',
        softwhite: '#f8fbfd',
        softpanel: '#F0EFEB',
      },
    },
  },
};
