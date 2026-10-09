import { build } from 'esbuild';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('container/build/tools', { recursive: true });
for (const [name, entry] of Object.entries({
  ingress: 'apps/integrations/src/main.ts',
  worker: 'tools/stripe-worker.ts',
  provision: 'tools/cloud-provision.ts',
  backfill: 'tools/stripe-backfill.ts',
  verify: 'tools/stripe-verify-sandbox.ts',
  proof: 'tools/cloud-stripe-proof.ts',
  generalWorker: 'tools/worker.ts',
})) {
  const result = await build({
    absWorkingDir: realpathSync('.'),
    entryPoints: [entry],
    outfile: `container/build/tools/${name}.cjs`,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    bundle: true,
    packages: 'bundle',
    external: ['pg-native'],
    metafile: true,
    sourcemap: false,
    tsconfig: 'tsconfig.base.json',
  });
  if (
    Object.keys(result.metafile.inputs).some(
      (p) =>
        p.includes('simulator-oracle') ||
        p.startsWith('tests/') ||
        p.includes('/test/'),
    )
  )
    throw new Error('Forbidden container dependency');
  await writeFile(
    `container/build/${name}-inputs.json`,
    JSON.stringify(Object.keys(result.metafile.inputs).sort()),
  );
}
