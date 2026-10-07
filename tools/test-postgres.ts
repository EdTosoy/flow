import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from './migrations';
import { PostgresReconciliation } from '@flow/reconciliation-postgres';
import { fixture as reconciliationFixture } from '../tests/helpers/reconciliation-fixture';
import { PostgresBank } from '@flow/bank-postgres';
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
    await migrate(admin, '004_bank.sql');
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
    const bankSource = await fixtureIngestion.registerSource({
      bookId: ingestionBook,
      environment: 'synthetic',
      provider: 'migration-bank',
      externalAccountId: 'bank',
    });
    const bankFixture = await fixtureIngestion.ingest({
      sourceAccountId: bankSource,
      batchKey: 'before-phase6',
      actorId: 'migration-fixture',
      provenance: { adapterVersion: 'fixture-v1' },
      records: [
        {
          locator: '0',
          objectKind: 'synthetic-bank-entry',
          externalId: 'entry',
          sourceRevision: null,
          sequence: null,
          sourceObservedAt: null,
          bytes: Buffer.from(
            JSON.stringify({
              id: 'entry',
              status: 'booked',
              amount: { amountMinor: '9007199254740993', currency: 'PHP' },
              bookedAt: '2026-01-03T00:00:00.000Z',
              transferReference: 'fixture-transfer',
              statementReference: 'statement',
              lineIdentity: 'line-1',
              sequence: 1,
              runningBalance: {
                amountMinor: '9007199254740993',
                currency: 'PHP',
              },
            }),
          ),
        },
        {
          locator: '1',
          objectKind: 'synthetic-bank-statement',
          externalId: 'statement',
          sourceRevision: null,
          sequence: null,
          sourceObservedAt: null,
          bytes: Buffer.from(
            JSON.stringify({
              id: 'statement',
              currency: 'PHP',
              reportedAt: '2026-01-04T00:00:00.000Z',
              opening: { amountMinor: '0', currency: 'PHP' },
              closing: { amountMinor: '1', currency: 'PHP' },
              expectedLineCount: 1,
              lineIds: ['line-1'],
              sequenceRange: { from: 1, to: 1 },
            }),
          ),
        },
      ],
    });
    const fixtureBank = new PostgresBank(admin);
    for (const nv of [
      'synthetic-bank-entry-v1',
      'synthetic-bank-statement-v1',
    ] as const) {
      await fixtureIngestion.requestNormalization(
        bankFixture.id,
        nv,
        'migration-fixture',
      );
      await fixtureIngestion.normalizeBatch(bankFixture.id, nv);
      for (const d of await fixtureBank.deriveBatch(bankFixture.id, nv))
        if (d.kind === 'statement')
          await fixtureBank.evaluate(d.id, 'before-phase6');
    }
    const priorSnapshot = async (): Promise<string> =>
      JSON.stringify(
        await Promise.all(
          [
            'bank.interpreter_version',
            'bank.account',
            'bank.statement_group',
            'bank.derivation',
            'bank.entry',
            'bank.statement',
            'bank.membership',
            'bank.statement_reference',
            'bank.balance_observation',
            'bank.evaluation',
            'bank.evaluation_entry',
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
    const phase5Before = await priorSnapshot(),
      phase4Before = await processorSnapshot(),
      phase3Before = await ingestionSnapshot();
    await migrate(admin, '005_reconciliation.sql');
    if (
      (await priorSnapshot()) !== phase5Before ||
      (await processorSnapshot()) !== phase4Before ||
      (await ingestionSnapshot()) !== phase3Before ||
      (await snapshot()) !== beforeUpgrade
    )
      throw new Error('Phase 6 migration changed Phase 1–5 history');
    console.log(
      'Populated Phase 5 -> Phase 6 preserves exact bank/processor/ingestion/ledger/audit/outbox history PASS',
    );
    const priorReconciliation = await reconciliationFixture(
      admin,
      admin,
      admin,
      admin,
    );
    const upgradeRun = await new PostgresReconciliation(admin).run(
      priorReconciliation.command,
    );
    const reconciliationSnapshot = async (): Promise<string> =>
      JSON.stringify(
        await Promise.all(
          [
            'run',
            'run_member',
            'candidate',
            'outcome_plan',
            'match_group',
            'match_group_member',
            'outcome',
            'allocation_decision',
            'current_allocation',
          ].map(
            async (table) =>
              (
                await admin!.query(
                  `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM reconciliation.${table} t`,
                )
              ).rows[0].rows,
          ),
        ),
      );
    const phase6History = await reconciliationSnapshot(),
      phase6Current = await new PostgresReconciliation(admin).summary(
        upgradeRun.id,
      );
    const phase6PriorBank = await priorSnapshot(),
      phase6PriorProcessor = await processorSnapshot(),
      phase6PriorIngestion = await ingestionSnapshot();
    await migrate(admin);
    if (
      (await reconciliationSnapshot()) !== phase6History ||
      JSON.stringify(
        await new PostgresReconciliation(admin).summary(upgradeRun.id),
      ) !== JSON.stringify(phase6Current) ||
      (await priorSnapshot()) !== phase6PriorBank ||
      (await processorSnapshot()) !== phase6PriorProcessor ||
      (await ingestionSnapshot()) !== phase6PriorIngestion
    )
      throw new Error(
        'Phase 7 migration changed Phase 1–6 history/current proof',
      );
    console.log(
      'Populated Phase 6 -> Phase 7 preserves frozen runs/members/results/allocations/current assurance and prior evidence PASS',
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
    await admin.query(
      'CREATE ROLE flow_test_reconciliation LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE flow_reconciliation_writer',
    );
    const version = await admin.query<{ version: string }>(
      'SHOW server_version',
    );
    console.log(
      `Disposable PostgreSQL ${Object.values(version.rows[0]!)[0]}; migration from empty + hash consistency PASS`,
    );
    const requested = process.argv.slice(2);
    const files = [
      'tests/ledger.integration.test.ts',
      'tests/simulator-ledger.integration.test.ts',
      'tests/ingestion.integration.test.ts',
      'tests/simulator-ingestion.integration.test.ts',
      'tests/processor.integration.test.ts',
      'tests/simulator-processor.integration.test.ts',
      'tests/bank.integration.test.ts',
      'tests/simulator-bank.integration.test.ts',
      'tests/reconciliation.integration.test.ts',
      'tests/grouped-reconciliation.integration.test.ts',
      'tests/simulator-grouped-reconciliation.integration.test.ts',
      'tests/simulator-reconciliation.integration.test.ts',
    ];
    if (requested.some((file) => !files.includes(file)))
      throw new Error('Unknown integration test path');
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          '--test',
          '--test-concurrency=1',
          ...(requested.length ? requested : files),
        ],
        {
          env: {
            ...process.env,
            FLOW_TEST_ADMIN_URL: url,
            FLOW_TEST_RECONCILIATION_URL: url.replace(
              'flow_test_admin@',
              'flow_test_reconciliation@',
            ),
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
  if (typeof error === 'object' && error !== null && 'position' in error)
    console.error(
      'SQL position:',
      error.position,
      'internal position:',
      'internalPosition' in error ? error.internalPosition : undefined,
    );
  console.error(
    error instanceof Error
      ? error.message
      : 'Integration infrastructure failed',
  );
  process.exitCode = 1;
});
