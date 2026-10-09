import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBootstrapPlan,
  assertDeploymentEnvironment,
  assertDeploymentIdentity,
  type BootstrapPlan,
  assertDemoPlan,
} from '../tools/deployment-guards';

test('refreshed write-only SSM values may be empty sentinels but never contain plaintext', () => {
  const plan = {
    resource_changes: [
      {
        mode: 'managed',
        type: 'aws_ssm_parameter',
        address: 'aws_ssm_parameter.runtime["stripe_key"]',
        change: {
          actions: ['update'],
          after: {
            name: '/flow/demo/stripe_key',
            type: 'SecureString',
            value: '',
            value_wo_version: 2,
          },
        },
      },
    ],
  };
  assertDemoPlan(plan);
  plan.resource_changes[0]!.change.after.value = 'unsafe-plaintext';
  assert.throws(() => assertDemoPlan(plan));
});

test('installing provisioned configuration allows only revisions of the same approved ECS task family', () => {
  const plan = {
    resource_changes: [
      {
        mode: 'managed',
        type: 'aws_ecs_task_definition',
        address: 'aws_ecs_task_definition.app["worker"]',
        change: {
          actions: ['delete', 'create'],
          before: { family: 'flow-demo-worker' },
          after: { family: 'flow-demo-worker' },
        },
      },
    ],
  };
  assertDemoPlan(plan);
  plan.resource_changes[0]!.change.after.family = 'unrelated-worker';
  assert.throws(() => assertDemoPlan(plan));
  plan.resource_changes[0]!.type = 'aws_db_instance';
  assert.throws(() => assertDemoPlan(plan));
});

test('demo refuses bootstrap resources, public database/task ingress, plaintext secrets and mutable images', () => {
  const one = (
    type: string,
    after: Record<string, unknown>,
    address = type + '.demo',
  ): BootstrapPlan => ({
    resource_changes: [
      {
        mode: 'managed',
        type,
        address,
        change: { actions: ['create'], after },
      },
    ],
  });
  const database = {
    identifier: 'flow-demo',
    publicly_accessible: false,
    multi_az: false,
    storage_encrypted: true,
    instance_class: 'db.t4g.micro',
    backup_retention_period: 0,
    deletion_protection: false,
    skip_final_snapshot: true,
    password: null,
  };
  assertDemoPlan(one('aws_db_instance', database));
  for (const change of [
    { publicly_accessible: true },
    { multi_az: true },
    { storage_encrypted: false },
    { password: 'must-not-enter-state' },
  ])
    assert.throws(() =>
      assertDemoPlan(one('aws_db_instance', { ...database, ...change })),
    );
  for (const type of [
    'aws_route53_zone',
    'aws_s3_bucket',
    'aws_nat_gateway',
    'aws_sqs_queue',
  ])
    assert.throws(() => assertDemoPlan(one(type, {})));
  assert.throws(() =>
    assertDemoPlan(
      one(
        'aws_vpc_security_group_ingress_rule',
        { cidr_ipv4: '0.0.0.0/0' },
        'aws_vpc_security_group_ingress_rule.database',
      ),
    ),
  );
  assert.throws(() =>
    assertDemoPlan(
      one('aws_ssm_parameter', {
        name: '/flow/demo/key',
        type: 'String',
        value: 'unsafe',
      }),
    ),
  );
  const container = {
    image: 'repo@sha256:' + 'a'.repeat(64),
    environment: [{ name: 'STRIPE_MODE', value: 'sandbox' }],
  };
  assertDemoPlan(
    one('aws_ecs_task_definition', {
      cpu: '256',
      memory: '512',
      container_definitions: JSON.stringify([container]),
    }),
  );
  assert.throws(() =>
    assertDemoPlan(
      one('aws_ecs_task_definition', {
        cpu: '256',
        memory: '512',
        container_definitions: JSON.stringify([
          { ...container, image: 'repo:latest' },
        ]),
      }),
    ),
  );
  assert.throws(() =>
    assertDemoPlan(
      one('aws_ecs_task_definition', {
        cpu: '256',
        memory: '512',
        container_definitions: JSON.stringify([
          {
            ...container,
            environment: [
              ...container.environment,
              { name: 'DATABASE_ADMIN_URL', value: 'secret' },
            ],
          },
        ]),
      }),
    ),
  );
});

test('destroy requires a separate reviewed demo-only deletion plan', () => {
  const plan: BootstrapPlan = {
    resource_changes: [
      {
        mode: 'managed',
        type: 'aws_db_instance',
        address: 'aws_db_instance.demo',
        change: { actions: ['delete'], after: null },
      },
    ],
  };
  assert.throws(() => assertDemoPlan(plan));
  assertDemoPlan(plan, true);
  const resources = plan.resource_changes!;
  resources[0]!.type = 'aws_route53_zone';
  assert.throws(() => assertDemoPlan(plan, true));
});

test('deployment refuses wrong account, root and credential/argument overrides', () => {
  assertDeploymentIdentity(
    '163596511125',
    'arn:aws:iam::163596511125:user/Iamadmin',
  );
  for (const [account, arn] of [
    ['872353350564', 'arn:aws:iam::872353350564:user/kuyas'],
    ['163596511125', 'arn:aws:iam::163596511125:root'],
  ])
    assert.throws(() => assertDeploymentIdentity(account!, arn!));
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_ENDPOINT_URL',
    'TF_CLI_ARGS_apply',
    'TF_LOG',
    'TF_VAR_budget_email',
  ])
    assert.throws(() => assertDeploymentEnvironment({ [key]: 'fixture' }));
  assertDeploymentEnvironment({ AWS_PROFILE: 'default' }); // The command explicitly selects the approved profile.
});

test('bootstrap rejects runtime infrastructure, deletion and parent-zone takeover', () => {
  const plan = (
    type: string,
    actions: string[],
    after: Record<string, unknown>,
  ): BootstrapPlan => ({
    resource_changes: [
      {
        address: `${type}.fixture`,
        mode: 'managed',
        type,
        change: { actions, after },
      },
    ],
  });
  assertBootstrapPlan(
    plan('aws_route53_zone', ['create'], { name: 'flow.edtosoy.com' }),
    true,
  );
  assert.throws(() =>
    assertBootstrapPlan(
      plan('aws_route53_zone', ['create'], { name: 'flow.edtosoy.com' }),
      false,
    ),
  );
  assert.throws(() =>
    assertBootstrapPlan(
      plan('aws_route53_zone', ['create'], { name: 'edtosoy.com' }),
      true,
    ),
  );
  assert.throws(() =>
    assertBootstrapPlan(plan('aws_db_instance', ['create'], {}), false),
  );
  assert.throws(() =>
    assertBootstrapPlan(
      plan('aws_ecr_repository', ['delete', 'create'], {}),
      false,
    ),
  );
  assert.throws(() =>
    assertBootstrapPlan(
      plan('aws_ecr_repository', ['create'], {
        name: 'flow-demo/stripe',
        image_tag_mutability: 'MUTABLE',
        force_delete: false,
      }),
      false,
    ),
  );
  assert.throws(() =>
    assertBootstrapPlan(
      plan('aws_budgets_budget', ['create'], {
        limit_amount: '100',
        limit_unit: 'USD',
        time_unit: 'MONTHLY',
      }),
      false,
    ),
  );
});

test('budget guard accepts exact provider-normalized ten dollars without admitting a different limit', () => {
  const plan = (amount: string): BootstrapPlan => ({
    resource_changes: [
      {
        address: 'aws_budgets_budget.demo',
        mode: 'managed',
        type: 'aws_budgets_budget',
        change: {
          actions: ['no-op'],
          after: {
            limit_amount: amount,
            limit_unit: 'USD',
            time_unit: 'MONTHLY',
          },
        },
      },
    ],
  });
  for (const amount of ['10', '10.0', '10.000'])
    assertBootstrapPlan(plan(amount), true);
  for (const amount of ['100', '10.01', '9.99', '1e1', '010', 'NaN'])
    assert.throws(() => assertBootstrapPlan(plan(amount), true));
});
