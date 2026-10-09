/** Bounded deployment evidence inspection with only the source-bound Stripe worker login. */
import { Pool } from 'pg';
import { stripeConfig } from './stripe-config';

async function main(): Promise<void> {
  const charge = process.argv[2];
  if (!charge || !/^ch_[A-Za-z0-9]+$/.test(charge))
    throw new Error('Explicit captured sandbox charge required');
  const config = stripeConfig('worker');
  const pool = new Pool({
    connectionString: config.url,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  try {
    const events = await pool.query<{
      event_id: string;
      origin: string;
      batch_id: string;
      api_version: string;
    }>(
      "SELECT event_id,origin,batch_id,document->>'api_version' AS api_version FROM stripe.event WHERE source_account_id=$1 AND document->>'type'='charge.succeeded' AND document->'data'->'object'->>'id'=$2 LIMIT 10",
      [config.binding.sourceAccountId, charge],
    );
    if (events.rows.length !== 1 || events.rows[0]!.origin !== 'webhook')
      throw new Error('Real webhook-first durable evidence not proven');
    const event = events.rows[0]!;
    const raw = await pool.query<{ checksum: string }>(
      "SELECT checksum FROM ingestion.raw_record WHERE batch_id=$1 AND object_kind='stripe-event' LIMIT 2",
      [event.batch_id],
    );
    const result = await pool.query<{
      state: string;
      receipt: { eventId: string; derivations: { id: string; kind: string }[] };
      work_id: string;
    }>(
      "SELECT w.state,c.receipt,c.work_id FROM stripe.completion c JOIN worker.work_item w ON w.id=c.work_id WHERE c.receipt->>'eventId'=$1 LIMIT 2",
      [event.event_id],
    );
    const completed = result.rows[0];
    if (
      raw.rows.length !== 1 ||
      result.rows.length !== 1 ||
      completed?.state !== 'SUCCEEDED' ||
      completed.receipt.derivations.length < 1
    )
      throw new Error('Durable economic completion not proven');
    const snapshots = await pool.query<{ key: string; api_version: string }>(
      'SELECT key,api_version FROM stripe.snapshot WHERE work_id=$1 ORDER BY key LIMIT 50',
      [completed.work_id],
    );
    if (
      !snapshots.rows.some((s) => s.key === 'charge:' + charge) ||
      !snapshots.rows.some((s) => s.key.startsWith('balance_transaction:'))
    )
      throw new Error('Real Charge/Balance Transaction API enrichment missing');
    console.log(
      JSON.stringify({
        operation: 'hosted-stripe-proof',
        outcome: 'PASS',
        charge,
        eventId: event.event_id,
        eventApiVersion: event.api_version,
        origin: event.origin,
        rawCount: raw.rows.length,
        rawChecksum: raw.rows[0]!.checksum,
        completionCount: result.rows.length,
        derivations: completed.receipt.derivations,
        snapshots: snapshots.rows,
        completeness: 'UNKNOWN',
        bank: 'synthetic only',
      }),
    );
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  console.error(
    JSON.stringify({ operation: 'hosted-stripe-proof', outcome: 'FAILED' }),
  );
  process.exitCode = 1;
});
