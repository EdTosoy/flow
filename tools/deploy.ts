import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  readFile,
  writeFile,
  chmod,
  access,
  readdir,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { Resolver } from 'node:dns/promises';
import {
  deployment,
  assertDeploymentIdentity,
  assertDeploymentEnvironment,
  assertBootstrapPlan,
  type BootstrapPlan,
} from './deployment-guards';

const root = resolve(__dirname, '..');
const directory = resolve(root, 'infra/bootstrap');
const local = resolve(root, '.deployment');
const variables = resolve(local, 'bootstrap.tfvars.json');
const planPath = resolve(local, 'bootstrap.tfplan');
const receiptPath = resolve(local, 'bootstrap-plan.json');
const generatedBackend = resolve(directory, 'backend.generated.tf');

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function privateWrite(path: string, body: string): Promise<void> {
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
}
function environment(): NodeJS.ProcessEnv {
  assertDeploymentEnvironment(process.env);
  return {
    ...process.env,
    AWS_PROFILE: deployment.profile,
    AWS_REGION: deployment.region,
    AWS_DEFAULT_REGION: deployment.region,
    AWS_PAGER: '',
    AWS_CLI_AUTO_PROMPT: 'off',
    TF_IN_AUTOMATION: '1',
  };
}
async function execute(
  command: string,
  args: string[],
  logged = false,
): Promise<string> {
  const child = spawn(command, args, {
    cwd: directory,
    env: environment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  const out = Buffer.concat(chunks).toString();
  const err = Buffer.concat(errors).toString();
  if (logged && command === 'terraform' && /^[a-z-]+$/.test(args[0] ?? ''))
    await privateWrite(resolve(local, `terraform-${args[0]}.log`), out + err);
  if (logged || code !== 0)
    await privateWrite(resolve(local, 'last-command.log'), out + err);
  if (code !== 0)
    throw new Error(
      'Deployment command failed; inspect ignored .deployment/last-command.log locally',
    );
  return out;
}
async function aws(args: string[]): Promise<Record<string, unknown>> {
  const text = await execute('aws', [
    ...args,
    '--profile',
    deployment.profile,
    '--region',
    deployment.region,
    '--output',
    'json',
    '--no-cli-pager',
    '--cli-connect-timeout',
    '5',
    '--cli-read-timeout',
    '15',
  ]);
  return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
}
async function identity(): Promise<void> {
  const caller = await aws(['sts', 'get-caller-identity']);
  assertDeploymentIdentity(String(caller['Account']), String(caller['Arn']));
  const version = JSON.parse(
    await execute('terraform', ['version', '-json']),
  ) as { terraform_version: string };
  if (!/^1\.15\./.test(version.terraform_version))
    throw new Error('Terraform 1.15 required');
  console.log(
    JSON.stringify({
      profile: deployment.profile,
      account: caller['Account'],
      region: deployment.region,
      terraform: version.terraform_version,
    }),
  );
}
async function config(dns: boolean): Promise<void> {
  const previous = (await exists(variables))
    ? (JSON.parse(await readFile(variables, 'utf8')) as {
        budget_email?: string;
      })
    : {};
  const email = process.env['FLOW_BUDGET_EMAIL'] ?? previous.budget_email;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error(
      'Supply the user-approved FLOW_BUDGET_EMAIL; never infer a contact',
    );
  await privateWrite(
    variables,
    JSON.stringify({ budget_email: email, create_dns_zone: dns }) + '\n',
  );
}
async function fingerprint(): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith('.tf') || n === '.terraform.lock.hcl')
    .sort()) {
    hash.update(name).update(await readFile(resolve(directory, name)));
  }
  hash.update(await readFile(variables));
  return hash.digest('hex');
}
async function plan(dns: boolean): Promise<void> {
  if (dns && !(await exists(generatedBackend)))
    throw new Error(
      'Migrate the seed state to S3 before creating the DNS zone',
    );
  if (
    !(await exists(generatedBackend)) &&
    !(await exists(resolve(directory, 'terraform.tfstate')))
  ) {
    const buckets = await aws(['s3api', 'list-buckets']);
    const list = buckets['Buckets'] as { Name: string }[] | undefined;
    if (list?.some((b) => b.Name === deployment.bucket))
      throw new Error(
        'Existing state bucket detected; use bootstrap-connect to recover its existing remote state',
      );
  }
  await config(dns);
  await execute('terraform', ['init', '-input=false'], true);
  await execute('terraform', ['fmt', '-check', '-recursive'], true);
  await execute('terraform', ['validate', '-no-color'], true);
  await execute('terraform', ['test', '-no-color'], true);
  await execute(
    'terraform',
    [
      'plan',
      '-input=false',
      '-no-color',
      '-lock-timeout=30s',
      `-var-file=${variables}`,
      `-out=${planPath}`,
    ],
    true,
  );
  await chmod(planPath, 0o600);
  const parsed = JSON.parse(
    await execute('terraform', ['show', '-json', planPath]),
  ) as BootstrapPlan;
  assertBootstrapPlan(parsed, dns);
  const checksum = createHash('sha256')
    .update(await readFile(planPath))
    .digest('hex');
  await privateWrite(
    receiptPath,
    JSON.stringify({ checksum, fingerprint: await fingerprint(), dns }) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        stage: dns ? 'dns-bootstrap' : 'seed-bootstrap',
        changes: parsed.resource_changes
          ?.filter((r) => r.change.actions[0] !== 'no-op')
          .map((r) => ({ address: r.address, actions: r.change.actions })),
      },
      null,
      2,
    ),
  );
  console.log(
    'Saved plan checked. Inspect before bootstrap-apply --reviewed. Persistent only; no runtime compute/database or certificate.',
  );
}
async function backend(migrate: boolean): Promise<void> {
  if (await exists(generatedBackend))
    throw new Error(
      'Generated backend already exists; inspect current backend rather than remigrating',
    );
  if (migrate && !(await exists(resolve(directory, 'terraform.tfstate'))))
    throw new Error('No seed state to migrate');
  if (!migrate)
    await aws([
      's3api',
      'head-object',
      '--bucket',
      deployment.bucket,
      '--key',
      'bootstrap/terraform.tfstate',
    ]);
  if (migrate) {
    const objects = await aws([
      's3api',
      'list-objects-v2',
      '--bucket',
      deployment.bucket,
      '--prefix',
      'bootstrap/terraform.tfstate',
      '--max-keys',
      '10',
    ]);
    if (
      (objects['Contents'] as { Key: string }[] | undefined)?.some(
        (o) => o.Key === 'bootstrap/terraform.tfstate',
      )
    )
      throw new Error(
        'Existing remote state refused; never overwrite it with seed state',
      );
    await chmod(resolve(directory, 'terraform.tfstate'), 0o600);
    await privateWrite(
      resolve(local, 'seed-state.backup'),
      await readFile(resolve(directory, 'terraform.tfstate'), 'utf8'),
    );
  }
  await privateWrite(
    generatedBackend,
    `terraform {\n  backend "s3" {\n    bucket = "${deployment.bucket}"\n    key = "bootstrap/terraform.tfstate"\n    region = "${deployment.region}"\n    profile = "${deployment.profile}"\n    allowed_account_ids = ["${deployment.account}"]\n    encrypt = true\n    use_lockfile = true\n  }\n}\n`,
  );
  await execute('terraform', ['fmt', generatedBackend], true);
  await execute(
    'terraform',
    [
      'init',
      '-input=false',
      ...(migrate ? ['-migrate-state', '-force-copy'] : ['-reconfigure']),
    ],
    true,
  );
  await aws([
    's3api',
    'head-object',
    '--bucket',
    deployment.bucket,
    '--key',
    'bootstrap/terraform.tfstate',
  ]);
  console.log(
    'Bootstrap remote state connected: encrypted/versioned S3, native S3 locking; separate demo state key required.',
  );
}
async function apply(): Promise<void> {
  if (process.argv[3] !== '--reviewed')
    throw new Error('Inspect the saved plan before passing --reviewed');
  const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as {
    checksum: string;
    fingerprint: string;
    dns: boolean;
  };
  if (
    saved.checksum !==
      createHash('sha256')
        .update(await readFile(planPath))
        .digest('hex') ||
    saved.fingerprint !== (await fingerprint())
  )
    throw new Error('Plan/configuration changed; create and review a new plan');
  assertBootstrapPlan(
    JSON.parse(
      await execute('terraform', ['show', '-json', planPath]),
    ) as BootstrapPlan,
    saved.dns,
  );
  // Recheck immediately before the mutation, independently of planning identity.
  await identity();
  await execute(
    'terraform',
    ['apply', '-input=false', '-no-color', planPath],
    true,
  );
  const outputs = JSON.parse(
    await execute('terraform', ['output', '-json']),
  ) as Record<string, { value: unknown }>;
  console.log(JSON.stringify(outputs, null, 2));
  if (saved.dns) {
    console.log(
      'MANDATORY DNS CHECKPOINT: STOP. User must add the four output nameservers as Cloudflare NS records named flow. No delegation-dependent operation has run.',
    );
    return;
  }
  console.log(
    'Seed applied. Next: bootstrap-migrate-state, then bootstrap-dns-plan and reviewed apply.',
  );
}
async function dns(): Promise<void> {
  if (process.argv[3] !== '--confirmed')
    throw new Error(
      'User confirmation of manual Cloudflare delegation is required',
    );
  const value = JSON.parse(
    await execute('terraform', ['output', '-json', 'name_servers']),
  ) as string[];
  if (value.length !== 4)
    throw new Error('Expected four nameservers from the created public zone');
  const expected = value.map((n) => n.toLowerCase().replace(/\.$/, '')).sort();
  for (const server of ['1.1.1.1', '8.8.8.8']) {
    const resolver = new Resolver({ timeout: 3000, tries: 2 });
    resolver.setServers([server]);
    const actual = (await resolver.resolveNs(deployment.domain))
      .map((n) => n.toLowerCase().replace(/\.$/, ''))
      .sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error(
        'Public delegation missing or different; do not request/validate certificates yet',
      );
  }
  console.log(
    'Public delegation verified through two independent recursive resolvers.',
  );
}
async function main(): Promise<void> {
  await mkdir(local, { recursive: true, mode: 0o700 });
  await chmod(local, 0o700);
  await identity();
  switch (process.argv[2]) {
    case 'bootstrap-plan':
      await plan(false);
      break;
    case 'bootstrap-dns-plan':
      await plan(true);
      break;
    case 'bootstrap-apply':
      await apply();
      break;
    case 'bootstrap-migrate-state':
      await backend(true);
      break;
    case 'bootstrap-connect':
      await backend(false);
      break;
    case 'dns-verify':
      await dns();
      break;
    default:
      throw new Error(
        'Use bootstrap-plan, bootstrap-apply --reviewed, bootstrap-migrate-state, bootstrap-connect, bootstrap-dns-plan or dns-verify --confirmed',
      );
  }
}
void main().catch((error: unknown) => {
  // Never print SDK/CLI errors: they can include URLs, payloads or credential details.
  console.error(
    error instanceof Error &&
      error.message.startsWith('Deployment command failed')
      ? error.message
      : 'Deployment safety check failed; inspect configuration and the ignored local command log.',
  );
  process.exitCode = 1;
});
