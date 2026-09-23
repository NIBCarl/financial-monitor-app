// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // scripts/verify-money-logic.cjs is a plain CommonJS Node script run by `npm run verify:money`.
    // eslint-config-expo evaluates .cjs with module scope, so Node's own globals must be declared
    // here — otherwise the file reports false `no-undef` errors for __dirname/require/process.
    files: ["scripts/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        global: "readonly",
        Buffer: "readonly",
      },
    },
  },
]);
