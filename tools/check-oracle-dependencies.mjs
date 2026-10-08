import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Include untagged/new apps and transitive manifest dependencies, not only imports. */
export function assertRuntimeDependencies(root) {
  const packages = new Map();
  function scan(directory) {
    if (!existsSync(directory)) return;
    if (existsSync(path.join(directory, 'package.json'))) {
      const pkg = JSON.parse(
        readFileSync(path.join(directory, 'package.json'), 'utf8'),
      );
      const project = existsSync(path.join(directory, 'project.json'))
        ? JSON.parse(readFileSync(path.join(directory, 'project.json'), 'utf8'))
        : {};
      packages.set(pkg.name, {
        oracle: (project.tags ?? []).includes('trust:oracle'),
        dependencies: {
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.optionalDependencies,
          ...pkg.peerDependencies,
        },
      });
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !['node_modules', 'dist', '.git', '.nx', '.next'].includes(entry.name)
      )
        scan(path.join(directory, entry.name));
    }
  }
  scan(path.join(root, 'libs'));
  scan(path.join(root, 'apps'));
  function visit(name, trail = []) {
    if (trail.includes(name)) return;
    const pkg = packages.get(name);
    if (!pkg) {
      if (
        name === '@flow/simulator-oracle' ||
        name.startsWith('@flow/simulator-oracle/')
      )
        throw new Error(
          `Runtime dependency reaches oracle: ${[...trail, name].join(' -> ')}`,
        );
      return;
    }
    if (pkg.oracle)
      throw new Error(
        `Runtime dependency reaches oracle: ${[...trail, name].join(' -> ')}`,
      );
    for (const dependency of Object.keys(pkg.dependencies))
      visit(dependency, [...trail, name]);
  }
  for (const [name, pkg] of packages) if (!pkg.oracle) visit(name);
  return packages.size;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  console.log(
    `Oracle dependency boundary PASS (${assertRuntimeDependencies(process.cwd())} packages)`,
  );
}
