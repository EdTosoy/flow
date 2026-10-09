import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAccess } from '../apps/ops/demo-access';

test('hosted demo access is fail-closed and protects financial routes and metrics', () => {
  const env = {
    FLOW_DEPLOYMENT_MODE: 'demo',
    FLOW_DEMO_USERNAME: 'demo',
    FLOW_DEMO_PASSWORD: 'a'.repeat(48),
  };
  const basic = (value: string) =>
    'Basic ' + Buffer.from(value).toString('base64');
  for (const path of [
    '/',
    '/controls',
    '/metrics',
    '/health/ready/extra',
    '/overview',
    '/_next/data/x',
  ]) {
    assert.equal(demoAccess(path, null, env), 401);
    assert.equal(demoAccess(path, basic('demo:wrong'), env), 401);
    assert.equal(
      demoAccess(path, basic('demo:' + env.FLOW_DEMO_PASSWORD), env),
      200,
    );
    assert.equal(demoAccess(path, null, { FLOW_DEPLOYMENT_MODE: 'demo' }), 503);
  }
  assert.equal(
    demoAccess('/', basic('demo:' + env.FLOW_DEMO_PASSWORD), {
      ...env,
      FLOW_DEPLOYMENT_MODE: 'unknown',
    }),
    503,
  );
  assert.equal(demoAccess('/', 'Basic ' + 'a'.repeat(2000), env), 401);
  assert.equal(demoAccess('/health/live', null, env), 200);
  assert.equal(demoAccess('/health/ready', null, env), 200);
  assert.equal(demoAccess('/', null, {}), 200); // Existing explicitly local workflow.
});
