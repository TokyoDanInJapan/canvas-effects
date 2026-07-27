import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'demo-dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  // The type-checked tier, not the syntactic one: rules like no-floating-promises
  // and no-unsafe-* only exist with type information, and on a codebase this size
  // the extra cost of running the checker under the linter is nothing.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // This config file is the one plain-JS file being linted; the typed rules
  // have no type information for it and would only produce noise.
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked }
);
