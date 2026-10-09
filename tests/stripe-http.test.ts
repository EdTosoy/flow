import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { request } from 'node:http';
import {
  ingressServer,
  type IngressStore,
} from '../apps/integrations/src/index';
import { stripeFixture } from '../libs/stripe-integration/test/fixture';
const sdk = createRequire(resolve('libs/stripe-integration/package.json'))(
  'stripe',
);
const secret = 'whsec_' + randomBytes(24).toString('hex');
const signature = (
  payload: string,
  timestamp = Math.floor(Date.now() / 1000),
) => sdk.webhooks.generateTestHeaderString({ payload, secret, timestamp });
async function fixture(
  store: IngressStore,
  bodyLimit = 1048576,
  log?: (entry: Readonly<Record<string, string | number>>) => void,
) {
  const data = stripeFixture();
  const server = ingressServer(store, {
    accountId: data.accountId,
    secrets: [secret],
    bodyLimit,
    ...(log ? { log } : {}),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const send = (
    method: string,
    path: string,
    body = '',
    header?: string,
  ): Promise<{ status: number; body: string; id: string | undefined }> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path,
          method,
          headers: {
            ...(header ? { 'stripe-signature': header } : {}),
            'content-type': 'application/json',
          },
        },
        (res) => {
          let output = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            output += chunk;
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              body: output,
              id: res.headers['x-request-id'] as string | undefined,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  return {
    data,
    send,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
test('HTTP rejects security failures without trusted ingestion, and keeps logs redacted', async () => {
  let accepted = 0;
  const logs: unknown[] = [];
  const f = await fixture(
    {
      ready: async () => true,
      accept: async () => {
        accepted++;
        return { id: 'receipt', replayed: false };
      },
    },
    1048576,
    (e) => logs.push(e),
  );
  try {
    const raw = JSON.stringify(f.data.event());
    for (const [payload, header] of [
      [raw, undefined],
      [raw, 'invalid'],
      [raw + ' ', signature(raw)],
      [raw, signature(raw, Math.floor(Date.now() / 1000) - 301)],
      ['{', signature(raw)],
    ])
      assert.equal(
        (await f.send('POST', '/webhooks/stripe', payload, header)).status,
        400,
      );
    for (const extra of [
      { livemode: true },
      { account: 'acct_other' },
      { context: 'acct_other' },
    ]) {
      const body = JSON.stringify(
        f.data.event('charge.succeeded', f.data.chargeId, extra),
      );
      assert.equal(
        (await f.send('POST', '/webhooks/stripe', body, signature(body)))
          .status,
        400,
      );
    }
    const unsupported = JSON.stringify(f.data.event('customer.created'));
    assert.equal(
      (
        await f.send(
          'POST',
          '/webhooks/stripe',
          unsupported,
          signature(unsupported),
        )
      ).status,
      400,
    );
    assert.equal(accepted, 0);
    assert.equal((await f.send('GET', '/webhooks/stripe')).status, 405);
    assert.equal((await f.send('GET', '/health/live')).status, 200);
    assert.equal((await f.send('GET', '/health/ready')).status, 200);
    const metrics = await f.send('GET', '/metrics');
    assert.match(metrics.body, /stripe_webhook_rejected_total 9/);
    assert.doesNotMatch(metrics.body, /evt_|ch_|acct_/);
    const encoded = JSON.stringify(logs);
    assert.ok(!encoded.includes(secret));
    assert.ok(!encoded.includes(raw));
    assert.ok(!encoded.includes(signature(raw)));
    assert.ok(logs.length >= 9);
  } finally {
    await f.close();
  }
});
test('HTTP 200 waits for durable commit and response loss retry is idempotent', async () => {
  let release!: () => void;
  const committed = new Set<string>();
  const accepted = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const f = await fixture({
    ready: async () => true,
    accept: async (e) => {
      calls++;
      await accepted;
      const replayed = committed.has(e.id);
      committed.add(e.id);
      return { id: 'receipt', replayed };
    },
  });
  try {
    const raw = JSON.stringify(f.data.event());
    let replied = false;
    const pending = f
      .send('POST', '/webhooks/stripe', raw, signature(raw))
      .then((result) => {
        replied = true;
        return result;
      });
    while (calls === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal(replied, false);
    release();
    const first = await pending;
    assert.equal(first.status, 200);
    assert.ok(first.id);
    assert.match(
      (await f.send('POST', '/webhooks/stripe', raw, signature(raw))).body,
      /duplicate/,
    );
    assert.equal(committed.size, 1);
  } finally {
    await f.close();
  }
});
test('durable failure is 503, readiness is 503, liveness remains 200', async () => {
  const f = await fixture({
    ready: async () => {
      throw new Error('private database detail');
    },
    accept: async () => {
      throw new Error('private database detail');
    },
  });
  try {
    const raw = JSON.stringify(f.data.event());
    const result = await f.send(
      'POST',
      '/webhooks/stripe',
      raw,
      signature(raw),
    );
    assert.equal(result.status, 503);
    assert.doesNotMatch(result.body, /private/);
    assert.equal((await f.send('GET', '/health/ready')).status, 503);
    assert.equal((await f.send('GET', '/health/live')).status, 200);
  } finally {
    await f.close();
  }
});
test('chunked oversize is bounded and rejected before verification', async () => {
  let calls = 0;
  const f = await fixture(
    {
      ready: async () => true,
      accept: async () => {
        calls++;
        return { id: 'x', replayed: false };
      },
    },
    128,
  );
  try {
    const raw = JSON.stringify(f.data.event());
    assert.equal(
      (await f.send('POST', '/webhooks/stripe', raw, signature(raw))).status,
      413,
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});
