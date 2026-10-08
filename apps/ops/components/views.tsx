import Link from 'next/link';
import { Panel, Status, Table, Time, Empty, Notice, Id, url } from './common';
import { money, age } from './format';
import {
  object as obj,
  rows,
  text as t,
  type Model,
  type Row,
  type Json,
} from './model';
type Context = { model: Model; book: string; evaluation?: string | undefined };
const cell = (v: Json | undefined) => t(v).replaceAll('_', ' ');
function Details({ data }: { data: Row }) {
  return (
    <dl className="details">
      {Object.entries(data).map(([k, v]) => (
        <div key={k}>
          <dt>{k.replaceAll(/([A-Z])/g, ' $1')}</dt>
          <dd>
            {v !== null && typeof v === 'object' ? (
              <pre>{JSON.stringify(v, null, 2)}</pre>
            ) : (
              cell(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function Overview({ model, book, evaluation }: Context) {
  const data = model.data ?? {},
    s = obj(data['integrity']),
    e = obj(data['evaluation']);
  return (
    <>
      <div className="metric-grid">
        <div className="metric">
          <span>Financial assurance · current sweep</span>
          <Status value={t(s['financialAssurance'])} />
          <small>Evidence strength, independent of worker success</small>
        </div>
        <div className="metric">
          <span>Structural integrity</span>
          <Status value={t(s['integrity'])} />
          <small>
            Current-state verification, not tamper-proof attestation
          </small>
        </div>
        <div className="metric">
          <span>Open operational cases</span>
          <strong>{t(obj(s['open'])['exceptions'])}</strong>
          <small>Case count ≠ economic discrepancy count</small>
        </div>
        <div className="metric">
          <span>Terminal work</span>
          <strong className="negative">{t(obj(s['work'])['terminal'])}</strong>
          <small>Retained for investigation</small>
        </div>
      </div>
      <Panel
        title="Financial assurance checks"
        aside={
          <Link href={url('integrity', book, evaluation)}>
            Inspect integrity →
          </Link>
        }
      >
        <div className="check-grid">
          {Object.entries(model.checks ?? {}).map(([k, v]) => (
            <div key={k}>
              <span>{k.replaceAll(/([A-Z])/g, ' $1')}</span>
              <Status value={v} />
            </div>
          ))}
        </div>
        <p className="footnote">
          UNKNOWN source completeness means independent account-period closure
          evidence is unavailable or insufficient. Successful processing does
          not prove source completeness.
        </p>
      </Panel>
      <Panel
        title="Unreconciled exposure"
        aside={<span className="eyebrow">FROZEN CONTROL EVALUATION</span>}
      >
        {!evaluation ? (
          <Empty>
            Select a control evaluation below. No financial population evaluated
            for this view yet. Assurance: UNKNOWN.
          </Empty>
        ) : (
          <>
            <Evaluation data={e} />
            <Exposure values={rows(e['exposure'])} />
          </>
        )}
      </Panel>
      <Panel title="Investigation scope">
        <p>
          Book <Id value={book} /> · Latest completed evaluation recorded{' '}
          <Time value={data['latestEvaluationAt']} />
        </p>
        <p className="muted">
          Choose an evaluation explicitly. Historical runs are never summed or
          selected as financial truth by arrival order.
        </p>
      </Panel>
    </>
  );
}
function Exposure({ values }: { values: Row[] }) {
  return values.length ? (
    <>
      <Table
        headers={[
          'Mapping / currency',
          'Unreconciled exposure',
          'Accepted-risk subset',
          'Processor-side claims',
          'Bank-side claims',
          'Unique pair residual',
          'Unknown components',
        ]}
      >
        {values.map((v, i) => (
          <tr key={i}>
            <td>
              <Id value={t(obj(v['scope'])['mappingId'])} />
              <br />
              {t(v['currency'])}
            </td>
            <td className="money">
              {money(v['unreconciledMinor'], v['currency'])}
            </td>
            <td className="money">
              {money(v['acceptedRiskMinor'], v['currency'])}
              <br />
              <small>Still unreconciled</small>
            </td>
            <td className="money">
              {money(v['processorClaimMinor'], v['currency'])}
            </td>
            <td className="money">
              {money(v['bankClaimMinor'], v['currency'])}
            </td>
            <td className="money">
              {money(v['pairResidualMinor'], v['currency'])}
            </td>
            <td>
              {t(v['unknownCount'])}
              {v['selectionStale'] === true && (
                <>
                  <br />
                  <Status value="STALE" />
                </>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <p className="footnote">
        Source-side claims are not additive when overlap is unproven. Case
        values and control failures add no second monetary exposure. Ambiguous
        amounts remain UNKNOWN.
      </p>
    </>
  ) : (
    <Empty>
      No selected mapping exposure. UNKNOWN; no zero exposure claim.
    </Empty>
  );
}
export function Evaluation({ data }: { data: Row }) {
  return (
    <div className="evaluation">
      <span>
        Evaluation <Id value={t(data['id'])} /> · {t(data['version'])}
      </span>
      <span>
        <Status value={t(data['assurance'])} />{' '}
        <Status
          value={data['current'] === true ? 'CURRENT' : 'STALE / INCOMPLETE'}
        />
      </span>
      <span>
        Frozen <Time value={data['frozenAt']} /> · {cell(data['currentReason'])}
      </span>
    </div>
  );
}
export function Evaluations({
  model,
  book,
  section,
}: {
  model: Model;
  book: string;
  section: string;
}) {
  return (
    <Panel title="Choose a control evaluation">
      {model.items?.length ? (
        <Table
          headers={[
            'Evaluation',
            'Version / lifecycle',
            'Frozen at (UTC)',
            'Completed at (UTC)',
            'Scope',
          ]}
        >
          {model.items.map((v) => (
            <tr key={t(v['id'])}>
              <td>
                <Id value={t(v['id'])} />
              </td>
              <td>
                {t(v['version'])}
                <br />
                <Status value={t(v['state'])} />
              </td>
              <td>
                <Time value={v['frozenAt']} />
              </td>
              <td>
                <Time value={v['completedAt']} />
              </td>
              <td>
                <Link href={url(section, book, t(v['id']))}>
                  Inspect evaluation →
                </Link>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>No evaluations yet. Financial assurance remains UNKNOWN.</Empty>
      )}
    </Panel>
  );
}
export function Reconciliation({ model, book, evaluation }: Context) {
  return (
    <Panel title="Reconciliation runs">
      {model.items?.length ? (
        <Table
          headers={[
            'Run / rule',
            'Population (processor / bank)',
            'Frozen outcomes',
            'Matched groups',
            'Current proof',
            'Completed at',
          ]}
        >
          {model.items.map((r) => {
            const s = obj(r['summary']);
            return (
              <tr key={t(r['id'])}>
                <td>
                  <Id
                    value={t(r['id'])}
                    href={url('reconciliation', book, evaluation, t(r['id']))}
                  />
                  <br />
                  <small>
                    {t(r['ruleVersion'])} · {t(r['currency'])}
                  </small>
                  <br />
                  <Status value={t(r['state'])} />
                </td>
                <td>
                  {t(s['processorPopulation'])} / {t(s['bankPopulation'])}
                  <br />
                  <small>Each side has its own item count</small>
                </td>
                <td>
                  {rows(s['outcomes']).map((o, i) => (
                    <div key={i}>
                      {cell(o['side'])} · {cell(o['outcome'])}:{' '}
                      <b>{t(o['count'])}</b>
                    </div>
                  ))}
                </td>
                <td>
                  {t(s['matchedGroups'])}
                  <br />
                  <small>
                    1:1: {t(r['exactGroups'])} · N:1: {t(r['groupedGroups'])}
                  </small>
                </td>
                <td>
                  {rows(s['current']).map((c, i) => (
                    <div key={i}>
                      {t(c['count'])} <Status value={t(c['status'])} />
                    </div>
                  ))}
                </td>
                <td>
                  <Time value={r['completedAt']} />
                </td>
              </tr>
            );
          })}
        </Table>
      ) : (
        <Empty>
          No runs in this scope. No evaluated financial population; assurance
          UNKNOWN.
        </Empty>
      )}
      <p className="footnote">
        Frozen MATCHED outcomes are historical. Current allocation proof is
        separate. Group counts and member counts use different denominators.
      </p>
    </Panel>
  );
}
export function Exceptions({ model, book, evaluation }: Context) {
  return (
    <Panel title="Exception queue">
      {model.items?.length ? (
        <Table
          headers={[
            'Case / financial state',
            'Operational state',
            'Classification / assignment',
            'Item exposure',
            'Age / latest activity',
            'Evidence',
          ]}
        >
          {model.items.map((c) => (
            <tr key={t(c['id'])}>
              <td>
                <Id
                  value={t(c['id'])}
                  href={url('exceptions', book, evaluation, t(c['id']))}
                />
                <br />
                <Status
                  value={
                    c['currentlyReconciled'] === true
                      ? 'CURRENTLY RECONCILED'
                      : 'UNRECONCILED'
                  }
                />
              </td>
              <td>
                <Status value={t(c['state'])} />
                {c['resolution'] && (
                  <>
                    <br />
                    {cell(c['resolution'])}
                  </>
                )}
              </td>
              <td>
                {cell(c['classification'])}
                <br />
                <small>
                  {c['assigneeId'] ? t(c['assigneeId']) : 'Unassigned'}
                </small>
              </td>
              <td className="money">
                {money(obj(c['exposure'])['amountMinor'], c['currency'])}
                <br />
                <small>{t(c['side'])} · non-additive case value</small>
              </td>
              <td>
                {age(c['createdAt'], model.asOf)}
                <br />
                <Time value={c['updatedAt']} />
              </td>
              <td>
                <Link
                  href={url(
                    'reconciliation',
                    book,
                    evaluation,
                    t(c['evidenceRunId']),
                  )}
                >
                  Linked run →
                </Link>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>
          No cases match this filter. This does not establish financial
          completeness.
        </Empty>
      )}
    </Panel>
  );
}
export function Case({ model, book, evaluation }: Context) {
  const c = model.data ?? {};
  return (
    <>
      <Panel title="Operational case">
        <div className="two-column">
          <div>
            <h3>Operational status</h3>
            <Status value={t(c['state'])} />
            <p>{cell(c['resolution'])}</p>
          </div>
          <div>
            <h3>Financial reconciliation</h3>
            <Status
              value={
                c['currentlyReconciled'] === true
                  ? 'CURRENTLY RECONCILED'
                  : 'UNRECONCILED'
              }
            />
            <p className="money">
              Item exposure:{' '}
              {money(obj(c['exposure'])['amountMinor'], c['currency'])}
            </p>
          </div>
        </div>
        {c['resolution'] === 'ACCEPTED_RISK' && (
          <Notice>
            Accepted risk is an operational disposition. The associated money
            remains unreconciled unless separate fresh allocation proof exists.
          </Notice>
        )}
        <Details
          data={{
            caseId: c['id'] ?? null,
            classification: c['classification'] ?? null,
            assignment: c['assigneeId'] ?? null,
            side: c['side'] ?? null,
            itemId: c['itemId'] ?? null,
            exposureReason: c['exposureReason'] ?? null,
            createdAt: c['createdAt'] ?? null,
          }}
        />
        <Link
          href={url('reconciliation', book, evaluation, t(c['evidenceRunId']))}
        >
          Inspect linked reconciliation evidence →
        </Link>
        <div>
          <p className="footnote">
            Linked control references: {t(c['linkedControlCount'])}. Showing at
            most 100; use control evaluation navigation for further history.
          </p>
          {rows(c['linkedControls']).map((v, i) => (
            <p key={i}>
              <Link
                href={url('controls', book, t(v['evaluation']), 'result', {
                  key: t(v['key']),
                })}
              >
                Linked control {t(v['key'])}
              </Link>
            </p>
          ))}
        </div>
      </Panel>
      <Panel title="Append-only case history and notes">
        {model.items?.length ? (
          <ol className="timeline">
            {model.items.map((e) => (
              <li key={t(e['id'])}>
                <div>
                  <span className="eyebrow">VERSION {t(e['version'])}</span>{' '}
                  <b>{cell(e['action'])}</b> <Time value={e['createdAt']} />
                </div>
                <p>
                  {cell(e['previousState'])} → {cell(e['state'])} ·{' '}
                  {cell(e['resolution'])}
                </p>
                <p>{t(e['reason'])}</p>
                {e['note'] && <blockquote>{t(e['note'])}</blockquote>}
                <small>
                  Actor: {t(e['actorId'])} · Assignment: {cell(e['assigneeId'])}{' '}
                  · {cell(e['classification'])}
                </small>
                {Object.keys(obj(e['attachment'])).length > 0 && (
                  <Details data={obj(e['attachment'])} />
                )}
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No history on this page.</Empty>
        )}
      </Panel>
    </>
  );
}
export function Run({ model, book, evaluation }: Context) {
  const r = model.data ?? {},
    s = obj(r['summary']);
  return (
    <>
      <Panel title="Frozen reconciliation population">
        <Details
          data={{
            runId: r['id'] ?? null,
            ruleVersion: r['ruleVersion'] ?? null,
            lifecycle: r['state'] ?? null,
            currency: r['currency'] ?? null,
            windowFrom: r['windowFrom'] ?? null,
            windowTo: r['windowTo'] ?? null,
            frozenAt: r['frozenAt'] ?? null,
            processorItems: s['processorPopulation'] ?? null,
            bankItems: s['bankPopulation'] ?? null,
            populationHash: s['populationHash'] ?? null,
          }}
        />
        <p className="footnote">
          Frozen evidence remains historical. Each group's current proof is
          evaluated separately; case closure changes no match.
        </p>
      </Panel>
      <Panel title="Evidence, outcomes and allocation">
        {model.items?.length ? (
          model.items.map((m) => {
            const snap = obj(m['snapshot']),
              a = obj(m['allocation']);
            return (
              <article className="evidence-item" key={t(m['id'])}>
                <div className="panel-heading">
                  <h3>
                    {t(m['side'])} · <Id value={t(m['id'])} />
                  </h3>
                  <Status value={t(m['outcome'])} />
                </div>
                <p className="money">
                  {money(snap['amountMinor'], snap['currency'])}
                </p>
                <p>{cell(m['reason'])}</p>
                <p className="footnote">
                  At most 50 historical revisions/declarations are displayed,
                  with their full frozen counts.
                </p>
                <Details
                  data={{
                    processorEvidenceId: m['processorEvidenceId'] ?? null,
                    bankEvidenceId: m['bankEvidenceId'] ?? null,
                    itemExposureWhereEstablished: money(
                      obj(m['cause'])['exposureMinor'],
                      r['currency'],
                    ),
                    discrepancyReason:
                      obj(m['cause'])['exposureReason'] ?? null,
                    evidenceId: snap['evidenceId'] ?? null,
                    sourceAccountId: snap['sourceAccountId'] ?? null,
                    revisionId: snap['revisionId'] ?? null,
                    reference: snap['reference'] ?? null,
                    time: snap['time'] ?? null,
                    reasons: snap['reasons'] ?? null,
                    eligibility: snap['eligible'] ?? null,
                    history: snap['history'] ?? null,
                    historyCount: snap['historyCount'] ?? null,
                    groupDeclarations: snap['groupVariants'] ?? null,
                    groupDeclarationCount: snap['groupVariantCount'] ?? null,
                  }}
                />
                {Object.keys(a).length > 0 && (
                  <>
                    <h3>
                      {t(a['shape'])} allocation · <Id value={t(a['id'])} />
                    </h3>
                    <Status
                      value={
                        a['current'] === true
                          ? 'CURRENT'
                          : 'STALE / INVALIDATED'
                      }
                    />
                    <p className="money">
                      Allocated {money(a['amountMinor'], a['currency'])}
                      <br />
                      Frozen bank minus processor total:{' '}
                      {money(a['frozenDifferenceMinor'], a['currency'])}
                    </p>
                    <details>
                      <summary>Frozen rule proof and exact comparisons</summary>
                      <Details data={obj(a['proof'])} />
                    </details>
                    <Table
                      headers={[
                        'Member identity',
                        'Role',
                        'Exact contribution',
                      ]}
                    >
                      {rows(a['members']).map((v) => (
                        <tr key={t(v['itemId'])}>
                          <td>
                            <Id value={t(v['itemId'])} />
                          </td>
                          <td>{cell(v['role'])}</td>
                          <td className="money">
                            {money(v['amountMinor'], a['currency'])}
                          </td>
                        </tr>
                      ))}
                    </Table>
                  </>
                )}
                {rows(m['cases']).map((c) => (
                  <p key={t(c['id'])}>
                    <Link
                      href={url('exceptions', book, evaluation, t(c['id']))}
                    >
                      Case {t(c['id'])} →
                    </Link>{' '}
                    · {cell(c['state'])}
                  </p>
                ))}
              </article>
            );
          })
        ) : (
          <Empty>No frozen members on this page.</Empty>
        )}
      </Panel>
    </>
  );
}
function controlValue(r: Row, k: string) {
  return r['unit'] === 'MINOR_UNITS' ? money(r[k], r['currency']) : t(r[k]);
}
export function Controls({ model, book, evaluation }: Context) {
  const e = obj(model.data?.['evaluation']);
  return (
    <Panel title="Financial controls">
      {Object.keys(e).length > 0 && <Evaluation data={e} />}
      <p className="footnote">
        FAIL is a proven violation. UNKNOWN means insufficient evidence; it is
        not success or zero.
      </p>
      {model.items?.length ? (
        <Table
          headers={[
            'Control / scope',
            'Status',
            'Expected',
            'Observed',
            'Discrepancy',
            'Unit / evidence',
          ]}
        >
          {model.items.map((c) => (
            <tr key={t(c['key'])}>
              <td>
                <Link
                  href={url('controls', book, evaluation, 'result', {
                    key: t(c['key']),
                  })}
                >
                  {cell(c['type'])}
                </Link>
                <br />
                <Id value={t(c['key'])} />
                <br />
                <small>{t(c['scope'])}</small>
              </td>
              <td>
                <Status value={t(c['status'])} />
              </td>
              <td className="money">{controlValue(c, 'expected')}</td>
              <td className="money">{controlValue(c, 'observed')}</td>
              <td className="money">{controlValue(c, 'discrepancy')}</td>
              <td>
                {cell(c['unit'])}
                <br />
                <small>{t(c['currency'])}</small>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>
          {evaluation
            ? 'No controls match this filter.'
            : 'Select an evaluation. No frozen control results selected; assurance UNKNOWN.'}
        </Empty>
      )}
    </Panel>
  );
}
export function Control({ model, book }: Context) {
  const c = model.data ?? {};
  return (
    <Panel title="Control evidence">
      <Status value={t(c['status'])} />
      <Details
        data={{
          controlKey: c['key'] ?? null,
          evaluationId: c['evaluationId'] ?? null,
          evaluationVersion: c['evaluationVersion'] ?? null,
          evaluatedAt: c['evaluatedAt'] ?? null,
          currentReason: c['currentReason'] ?? null,
          type: c['type'] ?? null,
          scope: c['scope'] ?? null,
          expected: controlValue(c, 'expected'),
          observed: controlValue(c, 'observed'),
          discrepancy: controlValue(c, 'discrepancy'),
          unit: c['unit'] ?? null,
          details: c['details'] ?? null,
          evidence: c['evidence'] ?? null,
        }}
      />
      {Array.isArray(c['caseIds']) &&
        c['caseIds'].map((v) => (
          <p key={t(v)}>
            <Link href={url('exceptions', book, undefined, t(v))}>
              Linked case {t(v)} →
            </Link>
          </p>
        ))}
    </Panel>
  );
}
export function Workers({ model, book, evaluation }: Context) {
  const d = model.data ?? {},
    counts = obj(d['counts']);
  return (
    <>
      <div className="metric-grid">
        {['PENDING', 'PROCESSING', 'RETRYABLE', 'FAILED_TERMINAL'].map((k) => (
          <div className="metric" key={k}>
            <span>{k.replaceAll('_', ' ')}</span>
            <strong>{t(counts[k] ?? '0')}</strong>
          </div>
        ))}
      </div>
      <Panel title="Durable work">
        <p>
          Oldest pending: <Time value={d['oldestPendingAt']} /> ·{' '}
          {age(d['oldestPendingAt'], model.asOf)}
        </p>
        {model.items?.length ? (
          <Table
            headers={[
              'Work / event',
              'State',
              'Handler',
              'Attempts',
              'Retry / lease (UTC)',
              'Failure class',
            ]}
          >
            {model.items.map((w) => (
              <tr key={t(w['id'])}>
                <td>
                  <Id
                    value={t(w['id'])}
                    href={url('workers', book, evaluation, t(w['id']))}
                  />
                  <br />
                  <small>{t(w['eventType'])}</small>
                </td>
                <td>
                  <Status value={t(w['state'])} />
                  {w['expiredRecoverable'] === true && (
                    <>
                      <br />
                      <Status value="EXPIRED · RECOVERABLE" />
                    </>
                  )}
                </td>
                <td>
                  {t(w['handler'])} v{t(w['handlerVersion'])}
                </td>
                <td>
                  {t(w['attempts'])} / {t(w['maxAttempts'])}
                </td>
                <td>
                  <Time
                    value={
                      w['nextAttemptAt'] ??
                      w['leaseExpiresAt'] ??
                      w['completedAt']
                    }
                  />
                </td>
                <td>
                  {cell(w['failureClass'])}
                  <br />
                  <small>{t(w['failureCode'])}</small>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>
            No work matches this filter. Worker status does not establish
            financial assurance.
          </Empty>
        )}
        <p className="footnote">
          Retries and expired leases recover through existing workers. This
          dashboard has no requeue action or arbitrary payload access.
        </p>
      </Panel>
    </>
  );
}
export function Work({ model }: Context) {
  return (
    <>
      <Panel title="Durable work metadata">
        <Details data={model.data ?? {}} />
      </Panel>
      <Panel title="Append-only attempts">
        <Table
          headers={[
            'Attempt',
            'Outcome',
            'Failure class / safe code',
            'Recorded at (UTC)',
          ]}
        >
          {model.items?.map((w) => (
            <tr key={t(w['id'])}>
              <td>{t(w['attempt'])}</td>
              <td>
                <Status value={t(w['kind'])} />
              </td>
              <td>
                {cell(w['failureClass'])} · {cell(w['failureCode'])}
              </td>
              <td>
                <Time value={w['cursorTime']} />
              </td>
            </tr>
          ))}
        </Table>
      </Panel>
    </>
  );
}
export function Integrity({ model }: Context) {
  const s = obj(model.data?.['integrity']);
  return (
    <>
      <Notice>
        Current-state engineering verification. This is not tamper-proof
        attestation, certification, historical forensic proof or production
        disaster-recovery assurance.
      </Notice>
      <Panel title="Independent integrity sweep">
        <p>
          Sweep as of <Time value={s['asOf']} /> · {t(s['version'])}
        </p>
        <p>
          <Status value={t(s['integrity'])} /> structural integrity ·{' '}
          <Status value={t(s['financialAssurance'])} /> financial assurance
        </p>
        <div className="check-grid">
          {Object.entries(model.checks ?? {}).map(([k, v]) => (
            <div key={k}>
              <span>{k.replaceAll(/([A-Z])/g, ' $1')}</span>
              <Status value={v} />
            </div>
          ))}
        </div>
        <p className="footnote">
          The sweep covers ledger, provenance, processing,
          reconciliation/allocation, exception history, frozen controls,
          canonical exposure and outbox/attempt integrity. Incomplete execution
          is reported as unavailable, never PASS.
        </p>
      </Panel>
      <Panel title="Invariant violations">
        {rows(s['violations']).length ? (
          <>
            <Table headers={['Invariant', 'Entity IDs', 'Scope / evidence']}>
              {rows(s['violations'])
                .slice(0, 50)
                .map((v, i) => (
                  <tr key={i}>
                    <td>{t(v['invariant'])}</td>
                    <td>{t(v['entityIds'])}</td>
                    <td>
                      {t(v['scope'])}
                      <br />
                      {t(v['evidence'])}
                    </td>
                  </tr>
                ))}
            </Table>
            <p>
              Showing at most 50 of {rows(s['violations']).length} violations.
              Use the integrity CLI for the complete bounded sweep.
            </p>
          </>
        ) : (
          <Empty>
            No structural violations detected in this supported current
            snapshot. Financial assurance may still be FAIL or UNKNOWN.
          </Empty>
        )}
      </Panel>
    </>
  );
}
