import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  generateSimulation,
  type SimulationConfig,
} from '@flow/simulator-oracle';
import { stableJson } from '@flow/simulator';

async function physicalPath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(
      await physicalPath(path.dirname(absolute)),
      path.basename(absolute),
    );
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const action = args.shift();
  if (action !== 'generate' && action !== 'replay')
    throw new Error(
      'Use generate --seed N --payments N [--config file] [--out new-dir] [--oracle-out separate-new-dir], or replay --replay private/oracle.json',
    );
  const flags = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!;
    const value = args.shift();
    if (
      ![
        '--seed',
        '--payments',
        '--config',
        '--out',
        '--oracle-out',
        '--replay',
      ].includes(key) ||
      value === undefined ||
      value.startsWith('--') ||
      flags.has(key)
    )
      throw new Error('Invalid/duplicate simulator option');
    flags.set(key, value);
  }
  let config: SimulationConfig;
  let expectedHash: string | undefined;
  if (action === 'replay') {
    if (
      !flags.has('--replay') ||
      flags.has('--config') ||
      flags.has('--seed') ||
      flags.has('--payments')
    )
      throw new Error('Replay requires only --replay plus output options');
    const artifact = JSON.parse(await readFile(flags.get('--replay')!, 'utf8'));
    config = artifact.oracle.replay;
    expectedHash = artifact.manifest.inputSha256;
  } else {
    if (flags.has('--replay'))
      throw new Error('Use replay for a private replay artifact');
    config = flags.has('--config')
      ? JSON.parse(await readFile(flags.get('--config')!, 'utf8'))
      : {};
    config = {
      ...config,
      ...(flags.has('--seed') ? { seed: Number(flags.get('--seed')) } : {}),
      ...(flags.has('--payments')
        ? { paymentCount: Number(flags.get('--payments')) }
        : {}),
    };
  }
  const simulation = generateSimulation(config);
  if (
    expectedHash !== undefined &&
    expectedHash !== simulation.manifest.inputSha256
  )
    throw new Error(
      'Replay checksum mismatch: simulator compatibility changed',
    );
  const out = flags.has('--out')
    ? await physicalPath(flags.get('--out')!)
    : undefined;
  const privateOut = flags.has('--oracle-out')
    ? await physicalPath(flags.get('--oracle-out')!)
    : undefined;
  if (privateOut !== undefined && out === undefined)
    throw new Error('--oracle-out requires --out');
  if (
    out &&
    privateOut &&
    (out === privateOut ||
      out.startsWith(`${privateOut}${path.sep}`) ||
      privateOut.startsWith(`${out}${path.sep}`))
  )
    throw new Error('Public and private output directories must be disjoint');
  // Exclusive directory creation: never overwrite an existing scenario or user files.
  if (out) {
    await mkdir(out, { mode: 0o700 });
    if (privateOut) await mkdir(privateOut, { mode: 0o700 });
    await writeFile(
      path.join(out, 'input.json'),
      stableJson(simulation.input) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await writeFile(
      path.join(out, 'manifest.json'),
      stableJson(simulation.manifest) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    if (privateOut)
      await writeFile(
        path.join(privateOut, 'oracle.json'),
        stableJson({
          manifest: simulation.manifest,
          oracle: simulation.oracle,
        }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
  }
  console.log(
    stableJson({
      scenarioId: simulation.manifest.scenarioId,
      seed: simulation.manifest.seed,
      version: simulation.manifest.simulatorVersion,
      inputSha256: simulation.manifest.inputSha256,
      recordCounts: simulation.manifest.recordCounts,
    }),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Simulation failed');
  process.exitCode = 1;
});
