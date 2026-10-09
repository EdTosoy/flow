/** Offline synthetic demo CLI; public input only. */
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { SystemInput } from '@flow/simulator';
import { seedDemo, type DemoPools } from './ops-demo-seed';
export { seedDemo, type DemoPools } from './ops-demo-seed';
async function main() {
  const paths = process.argv.slice(2);
  let deliveryReplays = 0;
  if (paths[0] === '--delivery-replays') {
    paths.shift();
    const value = paths.shift();
    if (!value || !/^([0-9]|1[0-9]|20)$/.test(value))
      throw new Error('Invalid delivery replay bound');
    deliveryReplays = Number(value);
  }
  if (!paths.length)
    throw new Error('Use pnpm ops:demo <public input.json> [...]');
  const keys: Record<keyof DemoPools, string> = {
    admin: 'ADMIN',
    ingestion: 'INGESTION',
    processor: 'PROCESSOR',
    bank: 'BANK',
    reconciliation: 'RECONCILIATION',
    exceptions: 'EXCEPTION',
    controls: 'CONTROL',
    worker: 'WORKER',
    integrity: 'INTEGRITY',
  };
  const entries = Object.entries(keys).map(([key, suffix]) => {
    const value = process.env['DATABASE_' + suffix + '_URL'];
    if (!value) throw new Error('Missing scoped demo connection');
    return [key, new Pool({ connectionString: value })] as const;
  });
  const pools = Object.fromEntries(entries) as unknown as DemoPools;
  try {
    const inputs: SystemInput[] = [];
    for (const path of paths) {
      const bytes = await readFile(path);
      if (bytes.length > 16000000)
        throw new Error('Public demo input exceeds bound');
      inputs.push(JSON.parse(bytes.toString()) as SystemInput);
    }
    console.log(
      JSON.stringify(
        await seedDemo(pools, inputs, 'phase12-public-demo', deliveryReplays),
      ),
    );
  } finally {
    await Promise.all(entries.map(([, p]) => p.end()));
  }
}
if (require.main === module)
  main().catch(() => {
    console.error(JSON.stringify({ event: 'operations_demo_failed' }));
    process.exitCode = 1;
  });
