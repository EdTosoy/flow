import tseslint from 'typescript-eslint';
import nx from '@nx/eslint-plugin';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', '.nx/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['libs/**/*.ts'],
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: 'layer:money',
              onlyDependOnLibsWithTags: ['layer:money'],
            },
            {
              sourceTag: 'layer:ledger-domain',
              onlyDependOnLibsWithTags: ['layer:money'],
            },
            {
              sourceTag: 'layer:ledger-data',
              onlyDependOnLibsWithTags: ['layer:money', 'layer:ledger-domain'],
            },
          ],
        },
      ],
    },
  },
  prettier,
);
