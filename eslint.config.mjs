import tseslint from "typescript-eslint";

/**
 * The dependency rule from the constitution, as lint.
 *
 * `app → services → db` and `domain → nothing` are only real if something checks
 * them. Patterns match both the `@/*` alias and relative specifiers, so the rule
 * cannot be evaded by switching import style.
 */
const dataLayer = {
  patterns: [
    {
      group: [
        "@/db",
        "@/db/*",
        "**/db/client",
        "**/db/client.ts",
        "drizzle-orm",
        "drizzle-orm/*",
        "pg",
      ],
      message:
        "UI and route handlers must not import the data layer. Go through services/ (constitution IV).",
    },
  ],
};

const isolatedDomain = {
  patterns: [
    {
      group: ["@/*", "../*"],
      message:
        "domain/ imports nothing — pure entities and rules, no I/O (constitution III).",
    },
  ],
};

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
  },
  {
    files: ["src/app/**/*.ts", "src/app/**/*.tsx"],
    rules: { "no-restricted-imports": ["error", dataLayer] },
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: { "no-restricted-imports": ["error", isolatedDomain] },
  },
];
