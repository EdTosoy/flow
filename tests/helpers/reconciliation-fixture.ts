import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PostgresIngestion } from '@flow/ingestion-postgres';
import { PostgresProcessor } from '@flow/processor-postgres';
import { PostgresBank } from '@flow/bank-postgres';
import type { RunCommand } from '@flow/reconciliation-domain';
export const reportTime = '2026-01-02T00:00:00.000Z',
  bankTime = '2026-01-03T00:00:00.000Z';
export const money = (value: string, currency = 'PHP') => ({
  amountMinor: value,
  currency,
});
export function entry(
  id: string | null = 'bank',
  amount = '970000',
  reference: string | null = 'transfer',
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    status: 'booked',
    bookedAt: bankTime,
    amount: money(amount),
    transferReference: reference,
    ...extra,
  };
}
export function report(
  id = 'settlement',
  net = '970000',
  reference = 'transfer',
  components = ['capture', 'fee'],
) {
  return {
    id,
    reportedAt: reportTime,
    transferReference: reference,
    componentIds: components,
    gross: money('1000000'),
    fees: money('30000'),
    refunds: money('0'),
    chargebacks: money('0'),
    net: money(net),
  };
}
export async function importEvidence(
  ingestion: PostgresIngestion,
  domain: PostgresProcessor | PostgresBank,
  source: string,
  kind: string,
  nv: NonNullable<Parameters<PostgresIngestion['normalizeBatch']>[1]>,
  objects: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) {
  const batch = await ingestion.ingest({
    sourceAccountId: source,
    batchKey: randomUUID(),
    actorId: 'phase6-fixture',
    provenance: { adapterVersion: 'public-like-fixture-v1' },
    records: objects.map((body, i) => ({
      locator: String(i),
      objectKind: kind,
      externalId: typeof body['id'] === 'string' ? body['id'] : null,
      sourceRevision: null,
      sequence: null,
      sourceObservedAt: null,
      bytes: Buffer.from(JSON.stringify(body)),
    })),
    ...extra,
  });
  if (nv !== 'synthetic-movement-v1')
    await ingestion.requestNormalization(batch.id, nv, 'phase6-fixture');
  await ingestion.normalizeBatch(batch.id, nv);
  return domain.deriveBatch(batch.id, nv);
}
export async function fixture(
  admin: Pool,
  ip: Pool,
  pp: Pool,
  bp: Pool,
  options: {
    banks?: readonly Record<string, unknown>[];
    reports?: readonly Record<string, unknown>[];
    capture?: string;
    fee?: string;
  } = {},
) {
  const book = randomUUID();
  await admin.query(
    "INSERT INTO ledger.book(id,code,environment) VALUES($1,$2,'synthetic')",
    [book, 'recon-' + book],
  );
  const ingestion = new PostgresIngestion(ip),
    processor = new PostgresProcessor(pp),
    bank = new PostgresBank(bp);
  const source = await ingestion.registerSource({
    bookId: book,
    environment: 'synthetic',
    provider: 'synthetic-processor',
    externalAccountId: 'processor',
  });
  const bankSource = await ingestion.registerSource({
    bookId: book,
    environment: 'synthetic',
    provider: 'synthetic-bank',
    externalAccountId: 'bank',
  });
  await importEvidence(
    ingestion,
    processor,
    source,
    'synthetic-movement',
    'synthetic-movement-v1',
    [
      {
        id: 'capture',
        kind: 'capture',
        paymentReference: 'payment',
        parentCaptureId: null,
        amount: money(options.capture ?? '1000000'),
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'fee',
        kind: 'fee',
        paymentReference: 'payment',
        parentCaptureId: 'capture',
        amount: money(options.fee ?? '-30000'),
        occurredAt: '2026-01-01T00:00:01.000Z',
      },
    ],
  );
  const reports = await importEvidence(
    ingestion,
    processor,
    source,
    'synthetic-settlement',
    'synthetic-settlement-v1',
    options.reports ?? [report()],
  );
  const entries = await importEvidence(
    ingestion,
    bank,
    bankSource,
    'synthetic-bank-entry',
    'synthetic-bank-entry-v1',
    options.banks ?? [entry()],
  );
  const mappingId = (
    await admin.query<{ id: string }>(
      "INSERT INTO reconciliation.account_mapping(book_id,processor_source_account_id,bank_source_account_id,currency,reference_contract) VALUES($1,$2,$3,'PHP','synthetic-transfer-reference-v1') RETURNING id",
      [book, source, bankSource],
    )
  ).rows[0]!.id;
  const command: RunCommand = {
    mappingId,
    runKey: 'run-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-10T00:00:00.000Z',
    effectiveAt: '2026-01-10T00:00:00.000Z',
    actorId: 'phase6-verifier',
  };
  return {
    book,
    source,
    bankSource,
    mappingId,
    ingestion,
    processor,
    bank,
    reports,
    entries,
    command,
  };
}
