/** Explicit ephemeral deployment commands; private output and secret values never go to stdout. */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  access,
  readdir,
  rm,
  rename,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import {
  deployment,
  assertDeploymentIdentity,
  assertDeploymentEnvironment,
  assertDemoPlan,
  type BootstrapPlan,
} from './deployment-guards';
import {
  sandboxKey,
  stripeReader,
  object,
  EVENT_TYPES,
  STRIPE_API_VERSION,
} from '@flow/stripe-integration';
const root = resolve(__dirname, '..'),
  directory = resolve(root, 'infra/demo'),
  local = resolve(root, '.deployment');
const configFile = resolve(local, 'demo.tfvars.json'),
  secretFile = resolve(local, 'demo-secrets.json'),
  planFile = resolve(local, 'demo.tfplan'),
  receiptFile = resolve(local, 'demo-plan.json');
interface Config {
  images: Record<string, string>;
  stripe_account_id: string;
  stripe_source_id: string;
  ops_book_id: string;
  start_services: boolean;
  secrets_version: number;
}
interface Secrets {
  values: Record<string, string>;
  bookId: string;
  webhookEndpointId?: string;
}
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function save(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
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
  options: {
    cwd?: string;
    input?: string;
    secrets?: Record<string, string>;
    sensitiveOutput?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string> {
  const env = { ...environment(), ...options.env };
  if (options.secrets) env['TF_VAR_secrets'] = JSON.stringify(options.secrets);
  const child = spawn(command, args, {
    cwd: options.cwd ?? directory,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [],
    err: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => out.push(b));
  child.stderr.on('data', (b: Buffer) => err.push(b));
  child.stdin.end(options.input);
  const code = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  const text = Buffer.concat(out).toString(),
    errors = Buffer.concat(err).toString();
  // Logs remain private even though ephemeral values should be redacted by Terraform.
  await save(resolve(local, 'demo-last-command.json'), {
    command,
    args: args.filter((a) => !a.startsWith('{')),
    stdout: options.sensitiveOutput ? '[redacted]' : text,
    stderr: errors,
    code,
  });
  if (code !== 0)
    throw new Error(
      'Deployment command failed; inspect .deployment/demo-last-command.json locally',
    );
  return text;
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
  ]);
  return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
}
async function identity(): Promise<void> {
  const caller = await aws(['sts', 'get-caller-identity']);
  assertDeploymentIdentity(String(caller['Account']), String(caller['Arn']));
  const v = JSON.parse(await execute('terraform', ['version', '-json'])) as {
    terraform_version: string;
  };
  if (!/^1\.15\./.test(v.terraform_version))
    throw new Error('Terraform 1.15 required');
  console.log(
    JSON.stringify({
      profile: deployment.profile,
      account: deployment.account,
      region: deployment.region,
      terraform: v.terraform_version,
    }),
  );
}
async function load(): Promise<{ config: Config; secret: Secrets }> {
  return {
    config: JSON.parse(await readFile(configFile, 'utf8')) as Config,
    secret: JSON.parse(await readFile(secretFile, 'utf8')) as Secrets,
  };
}
async function prepare(): Promise<void> {
  if (await exists(secretFile)) {
    console.log('Existing private demo configuration retained.');
    return;
  }
  const env = parseEnv(await readFile(resolve(root, '.env'), 'utf8'));
  const key = sandboxKey(env['STRIPE_SECRET_KEY']),
    account = env['STRIPE_ACCOUNT_ID'];
  if (
    !account ||
    object(await stripeReader(key).read('account', account))['id'] !== account
  )
    throw new Error('Sandbox account mismatch');
  const strong = () => randomBytes(36).toString('base64url'),
    bookId = randomUUID();
  const kinds = [
    'operations',
    'ingress',
    'stripeWorker',
    'ingestion',
    'processor',
    'bank',
    'reconciliation',
    'exceptions',
    'controls',
    'worker',
    'integrity',
  ];
  const passwords = Object.fromEntries(kinds.map((k) => [k, strong()]));
  const values: Record<string, string> = {
    admin_password: strong(),
    provisioning: JSON.stringify({ bookId, accountId: account, passwords }),
    stripe_key: key,
    webhook_secrets: 'pending-hosted-destination',
    demo_username: 'demo',
    demo_password: strong(),
    operations_password: passwords['operations']!,
    ingress_password: passwords['ingress']!,
    stripeworker_password: passwords['stripeWorker']!,
  };
  await save(secretFile, { values, bookId });
  await save(configFile, {
    images: {},
    stripe_account_id: account,
    stripe_source_id: '',
    ops_book_id: '',
    start_services: false,
    secrets_version: 1,
  });
  console.log(
    'Private generated demo credentials prepared; sandbox account verified. No secret printed.',
  );
}
async function images(): Promise<void> {
  const { config } = await load();
  const files = (
    await execute(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root },
    )
  )
    .trim()
    .split('\n')
    .filter(
      (p) =>
        /^(apps|libs|tools|container)\//.test(p) ||
        [
          'package.json',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          'tsconfig.base.json',
          '.dockerignore',
        ].includes(p),
    )
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    if (file.includes('/simulator-oracle/') || file.endsWith('.tsbuildinfo'))
      continue;
    hash.update(file).update(await readFile(resolve(root, file)));
  }
  const tag = 'source-' + hash.digest('hex').slice(0, 24);
  const registry = `${deployment.account}.dkr.ecr.${deployment.region}.amazonaws.com`,
    dockerConfig = resolve(local, 'docker');
  await mkdir(dockerConfig, { mode: 0o700 });
  const token = await execute(
    'aws',
    [
      'ecr',
      'get-login-password',
      '--profile',
      deployment.profile,
      '--region',
      deployment.region,
    ],
    { sensitiveOutput: true },
  );
  try {
    await execute(
      'docker',
      ['login', '--username', 'AWS', '--password-stdin', registry],
      { input: token, env: { DOCKER_CONFIG: dockerConfig } },
    );
    for (const name of ['ops', 'stripe', 'admin']) {
      const target = `${registry}/flow-demo/${name}:${tag}`;
      await execute(
        'docker',
        [
          'build',
          '--build-arg',
          `FLOW_IMAGE_REVISION=${tag}`,
          '--platform',
          'linux/amd64',
          '--target',
          name,
          '-f',
          'container/Dockerfile',
          '-t',
          target,
          '.',
        ],
        { cwd: root },
      );
      const details = JSON.parse(
        await execute('docker', ['image', 'inspect', target]),
      ) as { Config: { User: string; Env: string[] } }[];
      if (details[0]?.Config.User !== 'node')
        throw new Error('Non-root image required');
      await execute('docker', ['push', target], {
        env: { DOCKER_CONFIG: dockerConfig },
      });
      const image = await aws([
        'ecr',
        'describe-images',
        '--repository-name',
        `flow-demo/${name}`,
        '--image-ids',
        `imageTag=${tag}`,
      ]);
      const digest = (image['imageDetails'] as { imageDigest: string }[])[0]!
        .imageDigest;
      if (!/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error('Missing image digest');
      config.images[name] = `${registry}/flow-demo/${name}@${digest}`;
      console.log(JSON.stringify({ image: name, tag, digest }));
    }
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
  await save(configFile, config);
}
async function fingerprint(): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await readdir(directory))
    .filter((n) => n.endsWith('.tf') || n === '.terraform.lock.hcl')
    .sort())
    hash.update(name).update(await readFile(resolve(directory, name)));
  hash.update(await readFile(configFile));
  hash.update(await readFile(secretFile));
  return hash.digest('hex');
}
async function plan(destroy = false): Promise<void> {
  const { secret } = await load();
  await execute('terraform', ['init', '-input=false']);
  await execute('terraform', ['fmt', '-check', '-recursive']);
  await execute('terraform', ['validate', '-no-color']);
  await execute('terraform', ['test', '-no-color']);
  await execute(
    'terraform',
    [
      'plan',
      '-input=false',
      '-no-color',
      `-var-file=${configFile}`,
      `-out=${planFile}`,
      ...(destroy ? ['-destroy'] : []),
    ],
    { secrets: secret.values },
  );
  await chmod(planFile, 0o600);
  const parsed = JSON.parse(
    await execute('terraform', ['show', '-json', planFile]),
  ) as BootstrapPlan;
  assertDemoPlan(parsed, destroy);
  await save(receiptFile, {
    destroy,
    fingerprint: await fingerprint(),
    checksum: createHash('sha256')
      .update(await readFile(planFile))
      .digest('hex'),
  });
  console.log(
    JSON.stringify(
      {
        destroy,
        resources: parsed.resource_changes
          ?.filter(
            (r) =>
              r.mode === 'managed' &&
              r.change.actions.some((a) => a !== 'no-op'),
          )
          .map((r) => ({ address: r.address, actions: r.change.actions })),
      },
      null,
      2,
    ),
  );
  console.log(
    'Cost drivers: active ALB/public IPv4, db.t4g.micro + 20 GiB, three 0.25-vCPU tasks (services initially disabled), short-retention logs. No NAT. Inspect the private saved plan before apply.',
  );
}
async function apply(): Promise<void> {
  if (process.argv[3] !== '--reviewed')
    throw new Error('Review plan before apply');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as {
    destroy: boolean;
    fingerprint: string;
    checksum: string;
  };
  if (
    receipt.fingerprint !== (await fingerprint()) ||
    receipt.checksum !==
      createHash('sha256')
        .update(await readFile(planFile))
        .digest('hex')
  )
    throw new Error('Changed plan/configuration');
  assertDemoPlan(
    JSON.parse(
      await execute('terraform', ['show', '-json', planFile]),
    ) as BootstrapPlan,
    receipt.destroy,
  );
  await identity();
  const { secret } = await load();
  await execute('terraform', ['apply', '-input=false', '-no-color', planFile], {
    secrets: secret.values,
  });
  console.log(
    receipt.destroy
      ? 'Demo destroy applied; AWS removal checks still required.'
      : 'Reviewed demo plan applied; application proof still required.',
  );
}
async function outputs(): Promise<Record<string, { value: unknown }>> {
  return JSON.parse(await execute('terraform', ['output', '-json'])) as Record<
    string,
    { value: unknown }
  >;
}
async function task(command?: string[]): Promise<Record<string, unknown>> {
  const o = await outputs(),
    definitions = o['task_definitions']!.value as Record<string, string>,
    groups = o['task_security_groups']!.value as Record<string, string>;
  const workload = command ? 'verify' : 'admin';
  const input = {
    cluster: o['cluster']!.value,
    taskDefinition: definitions[workload],
    launchType: 'FARGATE',
    platformVersion: '1.4.0',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: o['public_subnets']!.value,
        securityGroups: [groups[workload]],
        assignPublicIp: 'ENABLED',
      },
    },
    ...(command
      ? { overrides: { containerOverrides: [{ name: workload, command }] } }
      : {}),
  };
  await save(resolve(local, 'run-task.json'), input);
  const launched = await aws([
    'ecs',
    'run-task',
    '--cli-input-json',
    `file://${resolve(local, 'run-task.json')}`,
  ]);
  const tasks = launched['tasks'] as { taskArn: string }[] | undefined;
  if (!tasks?.length) throw new Error('Admin task did not launch');
  const arn = tasks[0]!.taskArn;
  console.log(JSON.stringify({ operation: 'one-shot', taskArn: arn }));
  const deadline = Date.now() + 10 * 60 * 1000;
  while (true) {
    const state = await aws([
      'ecs',
      'describe-tasks',
      '--cluster',
      String(o['cluster']!.value),
      '--tasks',
      arn,
    ]);
    const t = (
      state['tasks'] as {
        lastStatus: string;
        containers: { exitCode?: number }[];
      }[]
    )[0]!;
    if (t.lastStatus === 'STOPPED') {
      if (t.containers[0]?.exitCode !== 0)
        throw new Error(
          'One-shot task failed; inspect protected CloudWatch logs',
        );
      break;
    }
    if (Date.now() >= deadline) {
      await aws([
        'ecs',
        'stop-task',
        '--cluster',
        String(o['cluster']!.value),
        '--task',
        arn,
        '--reason',
        'Flow one-shot command time limit',
      ]);
      throw new Error('One-shot task exceeded its bounded execution window');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  const id = arn.split('/').at(-1)!,
    logs = await aws([
      'logs',
      'get-log-events',
      '--log-group-name',
      `/flow/demo/${workload}`,
      '--log-stream-name',
      `flow/${workload}/${id}`,
    ]);
  const events = logs['events'] as { message: string }[];
  for (const e of events) {
    try {
      const v = JSON.parse(e.message) as Record<string, unknown>;
      if (v['operation'] === 'cloud-provision' && v['outcome'] === 'PASS') {
        return v;
      }
      if (v['externalSandbox'] === 'PASS') {
        await save(resolve(local, 'sandbox-verification.json'), v);
        console.log(JSON.stringify(v));
      }
      if (v['operation'] === 'hosted-stripe-proof' && v['outcome'] === 'PASS')
        return v;
      if (v['received'] !== undefined) {
        const historyPath = resolve(local, 'backfill-history.json');
        const history = (await exists(historyPath))
          ? (JSON.parse(await readFile(historyPath, 'utf8')) as unknown[])
          : [];
        await save(historyPath, [...history.slice(-19), v]);
        console.log(JSON.stringify(v));
      }
    } catch {
      /* CLI progress is not proof. */
    }
  }
  if (command) return { taskArn: arn, outcome: 'PASS' };
  throw new Error('Provisioning proof missing');
}
async function provision(): Promise<void> {
  const result = await task();
  const { config } = await load();
  config.stripe_source_id = String(result['sourceAccountId']);
  config.ops_book_id = String(result['syntheticBookId']);
  await save(configFile, config);
  console.log(JSON.stringify(result));
}
interface SandboxSdk {
  accounts: { retrieve(id: string): Promise<{ id: string }> };
  webhookEndpoints: {
    create(
      p: unknown,
      o?: unknown,
    ): Promise<{ id: string; secret?: string; livemode: boolean; url: string }>;
    retrieve(
      id: string,
    ): Promise<{ id: string; livemode: boolean; url: string }>;
    del(id: string): Promise<{ id: string; deleted: boolean }>;
  };
  paymentIntents: {
    create(
      p: unknown,
      o: unknown,
    ): Promise<{
      id: string;
      livemode: boolean;
      status: string;
      latest_charge: string;
    }>;
  };
}
function sdk(secret: Secrets): SandboxSdk {
  const Stripe = createRequire(
    resolve(root, 'libs/stripe-integration/package.json'),
  )('stripe') as new (key: string, options: unknown) => SandboxSdk;
  return new Stripe(sandboxKey(secret.values['stripe_key']), {
    apiVersion: STRIPE_API_VERSION,
    timeout: 10000,
    maxNetworkRetries: 1,
  });
}
async function destination(): Promise<void> {
  const { config, secret } = await load(),
    client = sdk(secret);
  if (
    (await client.accounts.retrieve(config.stripe_account_id)).id !==
    config.stripe_account_id
  )
    throw new Error('Stripe account mismatch');
  const url = `https://${deployment.domain}/webhooks/stripe`;
  if (secret.webhookEndpointId) {
    const existing = await client.webhookEndpoints.retrieve(
      secret.webhookEndpointId,
    );
    if (existing.livemode || existing.url !== url)
      throw new Error('Unexpected destination');
    console.log('Existing dedicated hosted sandbox destination retained.');
    return;
  }
  const endpoint = await client.webhookEndpoints.create(
    {
      url,
      enabled_events: [...EVENT_TYPES],
      api_version: STRIPE_API_VERSION,
      description: 'Flow ephemeral AWS sandbox demo',
    },
    { idempotencyKey: 'flow-phase15-destination-' + secret.bookId },
  );
  if (
    endpoint.livemode ||
    endpoint.url !== url ||
    !endpoint.secret?.startsWith('whsec_')
  )
    throw new Error('Hosted sandbox signing secret unavailable');
  secret.webhookEndpointId = endpoint.id;
  secret.values['webhook_secrets'] = endpoint.secret;
  config.secrets_version++;
  await save(secretFile, secret);
  await save(configFile, config);
  console.log(
    JSON.stringify({
      hostedSandboxDestination: endpoint.id,
      signingSecret: 'populated privately; distinct from CLI',
      services: 'not started',
    }),
  );
}
async function enable(): Promise<void> {
  const { config, secret } = await load();
  if (
    !secret.webhookEndpointId ||
    !config.stripe_source_id ||
    !config.ops_book_id
  )
    throw new Error('Provision source and hosted destination first');
  config.start_services = true;
  await save(configFile, config);
  console.log(
    'Service start selected; create and inspect a new plan before applying.',
  );
}
async function retireDestination(): Promise<void> {
  const { config, secret } = await load();
  if (!secret.webhookEndpointId) {
    console.log('No dedicated hosted sandbox destination to retire.');
    return;
  }
  const client = sdk(secret);
  if (
    (await client.accounts.retrieve(config.stripe_account_id)).id !==
    config.stripe_account_id
  )
    throw new Error('Stripe account mismatch');
  const endpoint = await client.webhookEndpoints.retrieve(
    secret.webhookEndpointId,
  );
  if (
    endpoint.livemode ||
    endpoint.url !== `https://${deployment.domain}/webhooks/stripe`
  )
    throw new Error('Unexpected destination; refusing deletion');
  const deleted = await client.webhookEndpoints.del(endpoint.id);
  if (!deleted.deleted || deleted.id !== endpoint.id)
    throw new Error('Destination retirement not confirmed');
  await save(resolve(local, 'destination-retired.json'), {
    endpointId: endpoint.id,
    sandbox: true,
    deleted: true,
  });
  delete secret.webhookEndpointId;
  await save(secretFile, secret);
  console.log(
    'Only the dedicated hosted sandbox webhook destination was retired; financial objects retained.',
  );
}
async function reset(): Promise<void> {
  if (
    !(await exists(resolve(local, 'destroy-proof.json'))) ||
    (await execute('terraform', ['state', 'list'])).trim()
  )
    throw new Error(
      'Verify complete runtime destruction before preparing another demo cycle',
    );
  const { config, secret } = await load();
  if (secret.webhookEndpointId)
    throw new Error('Retire the hosted sandbox destination first');
  const archive = resolve(local, 'history', secret.bookId);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  for (const name of [
    'deployment-proof.json',
    'destroy-proof.json',
    'sandbox-payment.json',
    'hosted-proof-before.json',
    'hosted-proof-after.json',
    'destination-retired.json',
    'sandbox-verification.json',
    'backfill-history.json',
    'browser-proof.json',
    'hosted-dashboard.png',
    'iam-proof.json',
  ]) {
    const path = resolve(local, name);
    if (await exists(path)) await rename(path, resolve(archive, name));
  }
  secret.bookId = randomUUID();
  const provisioning = JSON.parse(secret.values['provisioning']!) as {
    bookId: string;
  };
  provisioning.bookId = secret.bookId;
  secret.values['provisioning'] = JSON.stringify(provisioning);
  secret.values['webhook_secrets'] = 'pending-hosted-destination';
  config.start_services = false;
  config.stripe_source_id = '';
  config.ops_book_id = '';
  config.secrets_version++;
  await save(secretFile, secret);
  await save(configFile, config);
  console.log(
    'Verified empty runtime reset for a fresh disabled-service demo cycle; private evidence archived.',
  );
}
async function payment(): Promise<void> {
  const { config, secret } = await load(),
    client = sdk(secret);
  if (
    (await client.accounts.retrieve(config.stripe_account_id)).id !==
    config.stripe_account_id
  )
    throw new Error('Account mismatch');
  const payment = await client.paymentIntents.create(
    {
      amount: 1500,
      currency: 'usd',
      payment_method: 'pm_card_visa',
      allowed_payment_method_types: ['card'],
      confirm: true,
      description: 'Flow Phase 15 controlled sandbox evidence',
    },
    { idempotencyKey: 'flow-phase15-captured-sandbox-v2-' + secret.bookId },
  );
  if (
    payment.livemode ||
    payment.status !== 'succeeded' ||
    !payment.latest_charge
  )
    throw new Error('Sandbox capture failed');
  await save(resolve(local, 'sandbox-payment.json'), {
    paymentIntent: payment.id,
    charge: payment.latest_charge,
    at: new Date().toISOString(),
  });
  console.log(
    JSON.stringify({
      sandboxPaymentIntent: payment.id,
      charge: payment.latest_charge,
      status: payment.status,
    }),
  );
}
async function main(): Promise<void> {
  await mkdir(local, { recursive: true, mode: 0o700 });
  await chmod(local, 0o700);
  await identity();
  switch (process.argv[2]) {
    case 'prepare':
      await prepare();
      break;
    case 'images':
      await images();
      break;
    case 'plan':
      await plan();
      break;
    case 'destroy-plan':
      await plan(true);
      break;
    case 'apply':
      await apply();
      break;
    case 'provision':
      await provision();
      break;
    case 'destination':
      await destination();
      break;
    case 'enable':
      await enable();
      break;
    case 'retire-destination':
      await retireDestination();
      break;
    case 'reset':
      await reset();
      break;
    case 'sandbox-payment':
      await payment();
      break;
    case 'backfill': {
      const now = Math.floor(Date.now() / 1000);
      await task([
        'node',
        'tools/backfill.cjs',
        String(now - 3600),
        String(now),
        '10',
      ]);
      break;
    }
    case 'verify-sandbox':
      await task(['node', 'tools/verify.cjs']);
      break;
    case 'proof': {
      const payment = JSON.parse(
        await readFile(resolve(local, 'sandbox-payment.json'), 'utf8'),
      ) as { charge: string };
      const result = await task(['node', 'tools/proof.cjs', payment.charge]);
      const path = resolve(local, 'hosted-proof-before.json');
      if (await exists(path)) {
        const before = JSON.parse(await readFile(path, 'utf8')) as Record<
          string,
          unknown
        >;
        for (const key of [
          'eventId',
          'rawChecksum',
          'rawCount',
          'completionCount',
          'derivations',
        ])
          if (JSON.stringify(before[key]) !== JSON.stringify(result[key]))
            throw new Error('Webhook/backfill logical evidence changed');
        await save(resolve(local, 'hosted-proof-after.json'), result);
        console.log(
          'Hosted webhook/backfill deduplication PASS: unchanged raw digest, event, completion and economic derivation identities.',
        );
      } else await save(path, result);
      console.log(JSON.stringify(result));
      break;
    }
    case 'outputs':
      console.log(JSON.stringify(await outputs(), null, 2));
      break;
    default:
      throw new Error(
        'Use prepare, images, plan, apply --reviewed, provision, destination, enable, sandbox-payment, backfill, verify-sandbox, proof, retire-destination, destroy-plan, reset or outputs',
      );
  }
}
void main().catch(async (error: unknown) => {
  const detail = error as {
    name?: string;
    message?: string;
    type?: string;
    code?: string;
    statusCode?: number;
  };
  await save(resolve(local, 'demo-error.json'), {
    name: detail.name,
    message: detail.message,
    type: detail.type,
    code: detail.code,
    status: detail.statusCode,
  });
  console.error(
    'Demo command failed safely; inspect ignored .deployment/demo-last-command.json or protected task logs. No completion is claimed.',
  );
  process.exitCode = 1;
});
