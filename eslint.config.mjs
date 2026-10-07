import tseslint from 'typescript-eslint';
import nx from '@nx/eslint-plugin';
import prettier from 'eslint-config-prettier';
import oracleBoundary from './tools/oracle-boundary.mjs';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', '.nx/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['libs/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: 'layer:control-domain',
              onlyDependOnLibsWithTags: ['layer:money'],
            },
            {
              sourceTag: 'layer:control-postgres',
              onlyDependOnLibsWithTags: ['layer:control-domain'],
            },
            {
              sourceTag: 'layer:exception-domain',
              onlyDependOnLibsWithTags: ['layer:money'],
            },
            {
              sourceTag: 'layer:exception-postgres',
              onlyDependOnLibsWithTags: ['layer:exception-domain'],
            },
            {
              sourceTag: 'layer:reconciliation-domain',
              onlyDependOnLibsWithTags: [
                'layer:money',
                'layer:ingestion-domain',
              ],
            },
            {
              sourceTag: 'layer:reconciliation-postgres',
              onlyDependOnLibsWithTags: ['layer:reconciliation-domain'],
            },
            {
              sourceTag: 'layer:bank-domain',
              onlyDependOnLibsWithTags: [
                'layer:money',
                'layer:ingestion-domain',
              ],
            },
            {
              sourceTag: 'layer:bank-postgres',
              onlyDependOnLibsWithTags: ['layer:bank-domain'],
            },
            {
              sourceTag: 'layer:processor-domain',
              onlyDependOnLibsWithTags: [
                'layer:money',
                'layer:ingestion-domain',
              ],
            },
            {
              sourceTag: 'layer:processor-postgres',
              onlyDependOnLibsWithTags: ['layer:processor-domain'],
            },
            {
              sourceTag: 'layer:ingestion-domain',
              onlyDependOnLibsWithTags: ['layer:money'],
            },
            {
              sourceTag: 'layer:ingestion-postgres',
              onlyDependOnLibsWithTags: ['layer:ingestion-domain'],
            },
            {
              sourceTag: 'trust:runtime',
              notDependOnLibsWithTags: ['trust:oracle'],
            },
            {
              sourceTag: 'layer:simulator',
              onlyDependOnLibsWithTags: ['layer:money', 'layer:ledger-domain'],
            },
            {
              sourceTag: 'layer:simulator-oracle',
              onlyDependOnLibsWithTags: ['layer:money', 'layer:simulator'],
            },
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
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: { 'flow-boundaries': oracleBoundary },
    rules: { 'flow-boundaries/no-oracle-import': 'error' },
  },
  prettier,
);
