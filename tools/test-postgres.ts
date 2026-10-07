import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from './migrations';
import { PostgresProcessor } from '@flow/processor-postgres';
import { PostgresIngestion } from '@flow/ingestion-postgres';

const exec = promisify(execFile);
const image =
  'postgres:18@sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf';

/** Owns only its randomly named disposable container; never resets an existing database. */
async function main(): Promise<void> {
  const name = `flow-phase1-${randomUUID()}`;
  let started = false;
  let admin: Pool | undefined;
  try {
    await exec(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        name,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_USER=flow_test_admin',
        '--env',
        'POSTGRES_DB=flow_test',
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        image,
        '-c',
        'max_connections=160',
        '-c',
        'fsync=on',
        '-c',
        'synchronous_commit=on',
      ],
      { timeout: 120000 },
    );
    started = true;
    const portResult = await exec('docker', ['port', name, '5432/tcp']);
    const port = portResult.stdout.trim().split(':').at(-1)!;
    const url = `postgresql://flow_test_admin@127.0.0.1:${port}/flow_test`;
    admin = new Pool({ connectionString: url });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        await admin.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL failed to become ready');
    await migrate(admin, '001_financial_core.sql');
    const upgradeBook = randomUUID();
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [upgradeBook, `upgrade-${upgradeBook}`],
    );
    const accounts: string[] = [];
    for (const [code, classification, normalSide] of [
      ['asset', 'asset', 'debit'],
      ['equity', 'equity', 'credit'],
    ]) {
      const result = await admin.query<{ result: { id: string } }>(
        'SELECT ledger.create_account($1::jsonb) AS result',
        [
          JSON.stringify({
            bookId: upgradeBook,
            code,
            classification,
            normalSide,
            currency: 'PHP',
            commandKey: randomUUID(),
            actorId: 'migration-fixture',
            reason: 'Synthetic upgrade verification',
          }),
        ],
      );
      accounts.push(result.rows[0]!.result.id);
    }
    await admin.query('SELECT ledger.post_journal($1::jsonb)', [
      JSON.stringify({
        bookId: upgradeBook,
        commandKey: randomUUID(),
        actorId: 'migration-fixture',
        reason: 'Synthetic upgrade verification',
        effectNamespace: 'migration-fixture',
        businessEffectKey: 'capture',
        currency: 'PHP',
        effectiveAt: '2026-01-01T00:00:00.000Z',
        policyVersion: 'synthetic-v1',
        entries: [
          {
            accountId: accounts[0],
            side: 'debit',
            amountMinor: '9007199254740993',
          },
          {
            accountId: accounts[1],
            side: 'credit',
            amountMinor: '9007199254740993',
          },
        ],
      }),
    ]);
    const snapshot = async (): Promise<string> => {
      const rows = await Promise.all(
        [
          'ledger.ledger_account',
          'ledger.ledger_transaction',
          'ledger.ledger_entry',
          'ledger.command_receipt',
          'audit.audit_event',
          'outbox.outbox_event',
        ].map(
          async (table) =>
            (
              await admin!.query(
                `SELECT coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(t)) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t WHERE book_id=$1`,
                [upgradeBook],
              )
            ).rows[0].rows,
        ),
      );
      return JSON.stringify(rows);
    };
    const beforeUpgrade = await snapshot();
    await migrate(admin, '002_ingestion.sql');
    const ingestionBook = randomUUID();
    await admin.query(
      "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
      [ingestionBook, 'upgrade-ingestion-' + ingestionBook],
    );
    const fixtureIngestion = new PostgresIngestion(admin);
    const fixtureAccount = await fixtureIngestion.registerSource({
      bookId: ingestionBook,
      environment: 'synthetic',
      provider: 'migration-fixture',
      externalAccountId: 'processor',
    });
    const fixtureBatch = await fixtureIngestion.ingest({
      sourceAccountId: fixtureAccount,
      batchKey: 'before-phase4',
      actorId: 'migration-fixture',
      provenance: { adapterVersion: 'fixture-v1' },
      records: [
        {
          locator: '0',
          objectKind: 'synthetic-movement',
          externalId: 'capture',
          sourceRevision: 'opaque-1',
          sequence: null,
          sourceObservedAt: null,
          bytes: Buffer.from(
            JSON.stringify({
              id: 'capture',
              kind: 'capture',
              amount: { amountMinor: '9007199254740993', currency: 'PHP' },
              paymentReference: 'payment',
              parentCaptureId: null,
              occurredAt: '2026-01-01T00:00:00.000Z',
            }),
          ),
        },
      ],
    });
    await fixtureIngestion.normalizeBatch(fixtureBatch.id);
    const ingestionSnapshot = async (): Promise<string> =>
      JSON.stringify(
        await Promise.all(
          [
            'source',
            'source_account',
            'batch',
            'source_fact',
            'revision',
            'raw_record',
            'interpretation',
            'processing',
            'normalization_request',
          ].map(
            async (table) =>
              (
                await admin!.query(
                  `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ingestion.${table} t`,
                )
              ).rows[0].rows,
          ),
        ).then(async (rows) => [
          ...rows,
          ...(await Promise.all(
            ['audit.audit_event', 'outbox.outbox_event'].map(
              async (table) =>
                (
                  await admin!.query(
                    `SELECT coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(t)) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t WHERE book_id=$1`,
                    [ingestionBook],
                  )
                ).rows[0].rows,
            ),
          )),
        ]),
      );
    const beforeIngestionUpgrade = await ingestionSnapshot();
    await migrate(admin, '003_processor.sql');
    if ((await ingestionSnapshot()) !== beforeIngestionUpgrade)
      throw new Error('Phase 4 migration changed Phase 3 evidence');
    console.log(
      'Populated Phase 3 upgrade preserves exact receipts/revisions/interpretations/dispositions/audit/outbox PASS',
    );
    if ((await snapshot()) !== beforeUpgrade)
      throw new Error('Migration changed Phase 1 history');
    console.log(
      'Phase 1 populated upgrade preserves exact journal/entry/receipt/audit/outbox history PASS',
    );
    const fixtureProcessor = new PostgresProcessor(admin);
    const fixtureDerivations = await fixtureProcessor.deriveBatch(
      fixtureBatch.id,
      'synthetic-movement-v1',
    );
    await fixtureProcessor.evaluate(
      'payment',
      fixtureDerivations[0]!.paymentId!,
      'before-phase5',
    );
    const reportFixture = await fixtureIngestion.ingest({
      sourceAccountId: fixtureAccount,
      batchKey: 'processor-report-before-phase5',
      actorId: 'migration-fixture',
      provenance: { adapterVersion: 'fixture-v1' },
      records: [
        {
          locator: '0',
          objectKind: 'synthetic-settlement',
          externalId: 'report',
          sourceRevision: null,
          sequence: null,
          sourceObservedAt: null,
          bytes: Buffer.from(
            JSON.stringify({
              id: 'report',
              transferReference: 'fixture-transfer',
              componentIds: ['capture'],
              reportedAt: '2026-01-02T00:00:00.000Z',
              gross: { amountMinor: '9007199254740993', currency: 'PHP' },
              fees: { amountMinor: '0', currency: 'PHP' },
              refunds: { amountMinor: '0', currency: 'PHP' },
              chargebacks: { amountMinor: '0', currency: 'PHP' },
              net: { amountMinor: '1', currency: 'PHP' },
            }),
          ),
        },
      ],
    });
    await fixtureIngestion.requestNormalization(
      reportFixture.id,
      'synthetic-settlement-v1',
      'migration-fixture',
    );
    await fixtureIngestion.normalizeBatch(
      reportFixture.id,
      'synthetic-settlement-v1',
    );
    const reportDerivations = await fixtureProcessor.deriveBatch(
      reportFixture.id,
      'synthetic-settlement-v1',
    );
    await fixtureProcessor.evaluate(
      'settlement',
      reportDerivations[0]!.id,
      'before-phase5',
    );
    const processorSnapshot = async (): Promise<string> =>
      JSON.stringify(
        await Promise.all(
          [
            'processor.interpreter_version',
            'processor.payment',
            'processor.derivation',
            'processor.activity',
            'processor.settlement_batch',
            'processor.membership',
            'processor.evaluation',
            'processor.evaluation_activity',
            'audit.audit_event',
            'outbox.outbox_event',
          ].map(
            async (table) =>
              (
                await admin!.query(
                  `SELECT coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(t)) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t`,
                )
              ).rows[0].rows,
          ),
        ),
      );
    const beforeProcessorUpgrade = await processorSnapshot();
    const beforeBankIngestionUpgrade = await ingestionSnapshot();
    await migrate(admin);
    if (
      (await processorSnapshot()) !== beforeProcessorUpgrade ||
      (await ingestionSnapshot()) !== beforeBankIngestionUpgrade ||
      (await snapshot()) !== beforeUpgrade
    )
      throw new Error(
        'Phase 5 migration changed prior financial/evidence history',
      );
    console.log(
      'Populated Phase 4 -> Phase 5 upgrade preserves processor and Phase 1–3 history PASS',
    );
    await migrate(admin); // Empty migration plus idempotent hash consistency gate.
    await admin.query(
      'CREATE ROLE flow_test_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE flow_ledger_writer',
    );
    await admin.query(
      'CREATE ROLE flow_test_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE flow_ledger_reader',
    );
    await admin.query(
      'CREATE ROLE flow_test_ingestion LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE flow_ingestion_writer',
    );
    await admin.query(
      'CREATE ROLE flow_test_processor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE flow_processor_writer',
    );
    await admin.query(
      'CREATE ROLE flow_test_bank LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE flow_bank_writer',
    );
    const version = await admin.query<{ version: string }>(
      'SHOW server_version',
    );
    console.log(
      `Disposable PostgreSQL ${Object.values(version.rows[0]!)[0]}; migration from empty + hash consistency PASS`,
    );
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          '--test',
          '--test-concurrency=1',
          'tests/ledger.integration.test.ts',
          'tests/simulator-ledger.integration.test.ts',
          'tests/ingestion.integration.test.ts',
          'tests/simulator-ingestion.integration.test.ts',
          'tests/processor.integration.test.ts',
          'tests/simulator-processor.integration.test.ts',
          'tests/bank.integration.test.ts',
          'tests/simulator-bank.integration.test.ts',
        ],
        {
          env: {
            ...process.env,
            FLOW_TEST_ADMIN_URL: url,
            FLOW_TEST_BANK_URL: url.replace(
              'flow_test_admin@',
              'flow_test_bank@',
            ),
            FLOW_TEST_PROCESSOR_URL: url.replace(
              'flow_test_admin@',
              'flow_test_processor@',
            ),
            FLOW_TEST_INGESTION_URL: url.replace(
              'flow_test_admin@',
              'flow_test_ingestion@',
            ),
            FLOW_TEST_WRITER_URL: url.replace(
              'flow_test_admin@',
              'flow_test_writer@',
            ),
            FLOW_TEST_READER_URL: url.replace(
              'flow_test_admin@',
              'flow_test_reader@',
            ),
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Integration suite exited ${code}`)),
      );
    });
  } finally {
    await admin?.end();
    if (started) await exec('docker', ['stop', '--time', '2', name]);
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'Integration infrastructure failed',
  );
  process.exitCode = 1;
});
