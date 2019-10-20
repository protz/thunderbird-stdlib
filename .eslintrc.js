"use strict";

/* eslint-env node */
/* eslint sort-keys: "error" */

module.exports = {
  env: {
    browser: true,
    es6: true,
  },
  // "globals": {
  // },
  extends: ["plugin:mozilla/recommended"],
  overrides: [
    {
      // This marks exported symbols as used for our modules.
      files: ["*.js"],
      rules: {
        "mozilla/mark-exported-symbols-as-used": "error",
      },
    },
  ],
  plugins: ["mozilla"],
  rules: {
    // XXX These are all rules that mozilla/recommended set, but we currently
    // don't pass. We should enable these over time.
    complexity: ["error", 34],
    "consistent-return": "off",
    "mozilla/avoid-removeChild": "off",
    "mozilla/no-useless-removeEventListener": "off",
    "mozilla/use-ownerGlobal": "off",
    "no-undef": "error",
    // We want to check the global scope everywhere.
    "no-unused-vars": [
      "error",
      {
        args: "none",
        vars: "all",
      },
    ],
  },
};
