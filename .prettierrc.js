module.exports = {
  // Prettier 3 no longer auto-loads plugins from node_modules: the
  // Tailwind class-sorting plugin must be listed explicitly.
  plugins: ['prettier-plugin-tailwindcss'],
  arrowParens: 'always',
  singleQuote: true,
  jsxSingleQuote: true,
  tabWidth: 2,
  semi: true,
};
