"use strict";

/* eslint-env node */
/* eslint sort-keys: "error" */

module.exports = {
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
