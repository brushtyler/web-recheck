import tseslint from 'typescript-eslint';

const FS_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'];

export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'artifacts/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'bin/**/*.ts'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: "ImportExpression[source.type!='Literal']", message: 'Dynamic import driven by data is forbidden (SEC-4).' },
        { selector: "CallExpression[callee.name='require']", message: 'require() is forbidden (SEC-4).' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'playwright', message: 'Playwright may only be imported under src/executor/playwright/ (NFR-10).' },
            { name: 'playwright-core', message: 'Playwright may only be imported under src/executor/playwright/ (NFR-10).' },
            ...FS_MODULES.map((name) => ({ name, message: 'File-system access is only allowed under src/io/ (SEC-1, SEC-5).' })),
          ],
        },
      ],
    },
  },
  {
    files: ['src/io/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/executor/playwright/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: FS_MODULES.map((name) => ({ name, message: 'File-system access is only allowed under src/io/.' })) }],
    },
  },
);
