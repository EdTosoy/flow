import type { Pool } from 'pg';

export type Status = 'PASS' | 'FAIL' | 'UNKNOWN';
export interface Violation {
  invariant: string;
  entityIds: string[];
  scope: Record<string, string>;
  evidence: Record<string, unknown>;
}
export interface IntegritySummary {
  version: 'system-integrity-v1';
  bookId: string;
  asOf: string;
  integrity: 'PASS' | 'FAIL';
  financialAssurance: Status;
  violations: Violation[];
  controls: {
    key: string;
    type: string;
    status: Status;
    scope: Record<string, unknown>;
    expected: string | null;
    observed: string | null;
    discrepancy: string | null;
  }[];
  work: {
    pending: number;
    processing: number;
    retryable: number;
    terminal: number;
    succeeded: number;
    expiredRecoverable: number;
  };
  open: { exceptions: number; unknownControls: number };
}

/** Operational success never upgrades evidence-backed financial assurance. */
export function health(summary: IntegritySummary): Record<string, Status> {
  const groups: Record<string, string[]> = {
    ledger: ['LEDGER'],
    sourceCompleteness: ['SOURCE', 'SOURCE_PERIOD'],
    processingCompleteness: ['PROCESSING_PARTITION', 'PROCESSING_COMPLETION'],
    processorControls: ['PROCESSOR', 'PROCESSOR_TOTAL', 'PROCESSOR_COVERAGE'],
    bankControls: ['BANK', 'BANK_TOTAL', 'BANK_COMPLETENESS', 'BANK_COVERAGE'],
    reconciliationCoverage: ['RECONCILIATION'],
    allocationIntegrity: ['ALLOCATION'],
    exposureIntegrity: ['EXPOSURE'],
  };
  const result: Record<string, Status> = {};
  for (const [name, types] of Object.entries(groups)) {
    const statuses = summary.controls
      .filter((control) => types.includes(control.type))
      .map((control) => control.status);
    result[name] = statuses.includes('FAIL')
      ? 'FAIL'
      : statuses.length === 0 || statuses.includes('UNKNOWN')
        ? 'UNKNOWN'
        : 'PASS';
  }
  result['workerRecoverability'] =
    summary.violations.some((v) =>
      /WORK|OUTBOX|NORMALIZATION_INTENT/.test(v.invariant),
    ) || summary.work.terminal > 0
      ? 'FAIL'
      : summary.work.expiredRecoverable > 0
        ? 'UNKNOWN'
        : 'PASS';
  return result;
}

/** One independent MVCC snapshot; neither writes nor repairs domain state. */
export class PostgresIntegrity {
  constructor(private readonly reader: Pool) {}
  async sweep(
    bookId: string,
    reconciliationRunIds: readonly string[] = [],
  ): Promise<IntegritySummary> {
    const client = await this.reader.connect();
    let discard = false;
    const onError = () => {
      discard = true;
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(
        "SET LOCAL statement_timeout='30s'; SET LOCAL idle_in_transaction_session_timeout='30s'",
      );
      const result = (
        await client.query<{ result: IntegritySummary }>(
          'SELECT integrity.sweep($1::uuid,$2::uuid[]) AS result',
          [bookId, reconciliationRunIds],
        )
      ).rows[0]!.result;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.removeListener('error', onError);
      client.release(discard);
    }
  }
}
