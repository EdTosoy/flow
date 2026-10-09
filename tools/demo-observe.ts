/** Read-only deployed infrastructure/application evidence. Never prints credentials or raw payloads. */
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolve4 } from 'node:dns/promises';
import { connect } from 'node:tls';
import {
  deployment,
  assertDeploymentIdentity,
  assertDeploymentEnvironment,
} from './deployment-guards';
const root = resolve(__dirname, '..'),
  local = resolve(root, '.deployment');
function run(command: string, args: string[]): string {
  assertDeploymentEnvironment(process.env);
  const r = spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      AWS_PROFILE: deployment.profile,
      AWS_REGION: deployment.region,
      AWS_PAGER: '',
    },
    encoding: 'utf8',
    maxBuffer: 16000000,
  });
  if (r.status !== 0) throw new Error('Read-only command failed');
  return r.stdout;
}
function aws(args: string[]): Record<string, unknown> {
  return JSON.parse(
    run('aws', [
      ...args,
      '--profile',
      deployment.profile,
      '--region',
      deployment.region,
      '--output',
      'json',
      '--no-cli-pager',
    ]),
  ) as Record<string, unknown>;
}
function requireProof(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}
async function privateSave(name: string, value: unknown): Promise<void> {
  const p = resolve(local, name);
  await writeFile(p, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(p, 0o600);
}
async function main(): Promise<void> {
  const caller = aws(['sts', 'get-caller-identity']);
  assertDeploymentIdentity(String(caller['Account']), String(caller['Arn']));
  const databases = aws(['rds', 'describe-db-instances'])[
    'DBInstances'
  ] as Record<string, unknown>[];
  const balancers = aws(['elbv2', 'describe-load-balancers'])[
    'LoadBalancers'
  ] as Record<string, unknown>[];
  const db = databases.find((d) => d['DBInstanceIdentifier'] === 'flow-demo'),
    alb = balancers.find((b) => b['LoadBalancerName'] === 'flow-demo');
  if (process.argv[2] === 'destroy-verify') {
    requireProof(!db && !alb, 'Billable database/load balancer still exists');
    const clusters = aws(['ecs', 'list-clusters'])['clusterArns'] as string[];
    requireProof(
      !clusters.some((c) => c.endsWith('/flow-demo')),
      'Demo ECS cluster remains',
    );
    const vpcs = aws([
      'ec2',
      'describe-vpcs',
      '--filters',
      'Name=tag:Project,Values=flow',
      'Name=tag:Environment,Values=demo',
    ])['Vpcs'] as unknown[];
    requireProof(vpcs.length === 0, 'Runtime VPC remains');
    const parameters = aws([
      'ssm',
      'describe-parameters',
      '--parameter-filters',
      'Key=Name,Option=BeginsWith,Values=/flow/demo/',
    ])['Parameters'] as unknown[];
    requireProof(parameters.length === 0, 'Runtime SSM parameters remain');
    const zone = aws([
      'route53',
      'get-hosted-zone',
      '--id',
      'Z01534402E4PPZIHFEDCR',
    ]);
    requireProof(
      (zone['HostedZone'] as { Name: string }).Name === 'flow.edtosoy.com.',
      'Bootstrap zone missing',
    );
    const bucket = aws([
      's3api',
      'get-bucket-versioning',
      '--bucket',
      deployment.bucket,
    ]);
    requireProof(
      bucket['Status'] === 'Enabled',
      'Bootstrap versioning missing',
    );
    const repositories = aws([
      'ecr',
      'describe-repositories',
      '--repository-names',
      'flow-demo/ops',
      'flow-demo/stripe',
      'flow-demo/admin',
    ])['repositories'] as unknown[];
    requireProof(repositories.length === 3, 'Bootstrap ECR missing');
    const budget = aws([
      'budgets',
      'describe-budget',
      '--account-id',
      deployment.account,
      '--budget-name',
      'flow-demo-account-monthly',
    ]);
    requireProof(budget['Budget'], 'Budget missing');
    const state = JSON.parse(
      run('terraform', ['-chdir=infra/demo', 'state', 'pull']),
    ) as { resources: unknown[] };
    requireProof(
      state.resources.every((r) => (r as { mode: string }).mode === 'data'),
      'Managed demo state not empty',
    );
    const proof = {
      operation: 'destroy-verification',
      outcome: 'PASS',
      databaseRemoved: true,
      albRemoved: true,
      ecsClusterRemoved: true,
      vpcRemoved: true,
      runtimeSecretsRemoved: true,
      bootstrapZoneRetained: true,
      stateVersioningRetained: true,
      ecrRetained: 3,
      budgetRetained: true,
      managedDemoStateEmpty: true,
    };
    await privateSave('destroy-proof.json', proof);
    console.log(JSON.stringify(proof));
    return;
  }
  requireProof(db && alb, 'Demo is not deployed');
  requireProof(
    db['DBInstanceStatus'] === 'available' &&
      db['PubliclyAccessible'] === false &&
      db['MultiAZ'] === false &&
      db['StorageEncrypted'] === true &&
      db['DBInstanceClass'] === 'db.t4g.micro',
    'Unsafe or unavailable RDS',
  );
  const o = JSON.parse(
    run('terraform', ['-chdir=infra/demo', 'output', '-json']),
  ) as Record<string, { value: unknown }>;
  const cluster = String(o['cluster']!.value),
    services = o['services']!.value as Record<string, string>;
  const serviceList = aws([
    'ecs',
    'describe-services',
    '--cluster',
    cluster,
    '--services',
    ...Object.values(services),
  ])['services'] as {
    serviceName: string;
    desiredCount: number;
    runningCount: number;
    pendingCount: number;
  }[];
  requireProof(
    serviceList.length === 3 &&
      serviceList.every(
        (s) =>
          s.desiredCount === 1 && s.runningCount === 1 && s.pendingCount === 0,
      ),
    'ECS services not ready',
  );
  const targets = o['target_groups']!.value as Record<string, string>;
  for (const arn of Object.values(targets)) {
    const health = aws([
      'elbv2',
      'describe-target-health',
      '--target-group-arn',
      arn,
    ])['TargetHealthDescriptions'] as { TargetHealth: { State: string } }[];
    requireProof(
      health.length === 1 &&
        health.every((h) => h.TargetHealth.State === 'healthy'),
      'ALB readiness not healthy',
    );
  }
  const vpc = String(alb['VpcId']);
  requireProof(
    (
      aws([
        'ec2',
        'describe-nat-gateways',
        '--filter',
        `Name=vpc-id,Values=${vpc}`,
      ])['NatGateways'] as unknown[]
    ).length === 0,
    'Unexpected NAT gateway',
  );
  const dbGroups = (
    db['VpcSecurityGroups'] as { VpcSecurityGroupId: string }[]
  ).map((g) => g.VpcSecurityGroupId);
  const taskGroups = Object.values(
    o['task_security_groups']!.value as Record<string, string>,
  );
  const groups = aws([
    'ec2',
    'describe-security-groups',
    '--group-ids',
    ...dbGroups,
    ...taskGroups,
  ])['SecurityGroups'] as {
    GroupId: string;
    IpPermissions: {
      FromPort: number;
      ToPort: number;
      IpRanges: unknown[];
      Ipv6Ranges: unknown[];
      UserIdGroupPairs: { GroupId: string }[];
    }[];
  }[];
  requireProof(
    groups.every((g) =>
      g.IpPermissions.every(
        (p) => p.IpRanges.length === 0 && p.Ipv6Ranges.length === 0,
      ),
    ),
    'Public task/database ingress',
  );
  const databaseGroup = groups.find((g) => dbGroups.includes(g.GroupId));
  requireProof(
    databaseGroup?.IpPermissions.every(
      (p) =>
        p.FromPort === 5432 &&
        p.ToPort === 5432 &&
        p.UserIdGroupPairs.every((v) => taskGroups.includes(v.GroupId)),
    ),
    'Database security boundary mismatch',
  );
  const endpoint = (db['Endpoint'] as { Address: string }).Address;
  requireProof(
    (await resolve4(endpoint)).every((ip) => ip.startsWith('10.42.')),
    'Database endpoint not private',
  );
  const cert = aws([
    'acm',
    'describe-certificate',
    '--certificate-arn',
    String(o['certificate_arn']!.value),
  ])['Certificate'] as { Status: string; DomainName: string };
  requireProof(
    cert.Status === 'ISSUED' && cert.DomainName === deployment.domain,
    'ACM not issued',
  );
  const tls = await new Promise<{
    authorized: boolean;
    protocol: string | null;
  }>((done, reject) => {
    const socket = connect(
      {
        host: deployment.domain,
        port: 443,
        servername: deployment.domain,
        rejectUnauthorized: true,
      },
      () => {
        done({ authorized: socket.authorized, protocol: socket.getProtocol() });
        socket.end();
      },
    );
    socket.once('error', reject);
    socket.setTimeout(10000, () => socket.destroy(new Error('TLS timeout')));
  });
  requireProof(tls.authorized, 'Invalid HTTPS certificate');
  const config = JSON.parse(
    await readFile(resolve(local, 'demo.tfvars.json'), 'utf8'),
  ) as { ops_book_id: string };
  const secret = JSON.parse(
    await readFile(resolve(local, 'demo-secrets.json'), 'utf8'),
  ) as { values: Record<string, string> };
  const get = (path: string, headers?: Record<string, string>) =>
    fetch(`https://${deployment.domain}${path}`, {
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(45000),
      redirect: 'manual',
    });
  for (const path of ['/', '/controls', '/metrics'])
    requireProof(
      (await get(path)).status === 401,
      'Unauthenticated financial access',
    );
  requireProof(
    (await get('/health/live')).status === 200 &&
      (await get('/health/ready')).status === 200,
    'Technical health failed',
  );
  const auth = {
    Authorization:
      'Basic ' +
      Buffer.from(
        secret.values['demo_username'] + ':' + secret.values['demo_password'],
      ).toString('base64'),
  };
  const page = await get('/?book=' + config.ops_book_id, auth),
    html = await page.text();
  requireProof(
    page.status === 200 &&
      !html.includes('Read unavailable') &&
      html.includes('Overview'),
    'Protected dashboard unavailable',
  );
  requireProof(
    (await get('/metrics', auth)).status === 200,
    'Protected metrics unavailable',
  );
  const unsigned = await fetch(`https://${deployment.domain}/webhooks/stripe`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  requireProof(unsigned.status === 400, 'Unsigned webhook admitted');
  const state = run('terraform', ['-chdir=infra/demo', 'state', 'pull']);
  const passwords = JSON.parse(secret.values['provisioning']!) as {
    passwords: Record<string, string>;
  };
  const sensitive = [
    ...Object.values(secret.values),
    ...Object.values(passwords.passwords),
  ].filter((s) => s.length >= 32);
  requireProof(
    !sensitive.some((s) => state.includes(s)),
    'Secret in Terraform state',
  );
  const meta = aws([
    's3api',
    'head-object',
    '--bucket',
    deployment.bucket,
    '--key',
    'demo/terraform.tfstate',
  ]);
  requireProof(
    meta['ServerSideEncryption'] === 'AES256' && meta['VersionId'],
    'State not encrypted/versioned',
  );
  const proof = {
    operation: 'deployment-verification',
    outcome: 'PASS',
    account: deployment.account,
    region: deployment.region,
    services: serviceList.map((s) => ({
      name: s.serviceName,
      running: s.runningCount,
    })),
    albTargetsHealthy: true,
    privateEncryptedSingleAZDatabase: true,
    natGateways: 0,
    narrowNetworkIngress: true,
    https: tls,
    unauthenticatedDashboard: 401,
    protectedDashboard: 200,
    technicalHealth: 200,
    protectedMetrics: 200,
    unsignedWebhook: 400,
    knownSecretValuesAbsentFromState: true,
    versionedEncryptedState: true,
  };
  await privateSave('deployment-proof.json', proof);
  console.log(JSON.stringify(proof));
}
void main().catch(async (error: unknown) => {
  await privateSave('observe-error.json', {
    reason:
      error instanceof Error
        ? error.message
        : 'Unexpected verification failure',
  });
  console.error(
    'Read-only deployed verification failed; no success is claimed.',
  );
  process.exitCode = 1;
});
