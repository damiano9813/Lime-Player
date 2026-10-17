/** Tailwind compilato in ui/vendor/app.css (npm run build:css), invece del CDN. */
module.exports = {
  content: ['./ui/index.html', './ui/js/**/*.js'],
  theme: { extend: {} },
  plugins: [],
};
