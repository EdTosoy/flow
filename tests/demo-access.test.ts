import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { demoAccess } from '../apps/ops/demo-access';

test('CSP permits React debugging eval only in development and preserves production policy', async () => {
  const config = (
    await import(pathToFileURL(resolve('apps/ops/next.config.mjs')).href)
  ).default as {
    headers(): Promise<
      Array<{ source: string; headers: Array<{ key: string; value: string }> }>
    >;
  };
  const productionPolicy =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  const originalMode = process.env['NODE_ENV'];
  try {
    for (const mode of ['production', 'test', undefined, 'development']) {
      if (mode === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = mode;
      const rules = await config.headers();
      const rule = rules[0];
      assert.ok(rule);
      assert.equal(rule.source, '/:path*');
      const policy = rule.headers.find(
        (header) => header.key === 'Content-Security-Policy',
      )?.value;
      assert.equal(
        policy,
        mode === 'development'
          ? productionPolicy.replace(
              "script-src 'self' 'unsafe-inline'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            )
          : productionPolicy,
      );
    }
  } finally {
    if (originalMode === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalMode;
  }
});

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
