-- Independent read-only verification. No financial state or previous migration changes.
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='flow_integrity_reader') THEN
  CREATE ROLE flow_integrity_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='flow_integrity_reader' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe integrity role'; END IF;
END $$;
CREATE SCHEMA integrity AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA integrity FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
CREATE FUNCTION integrity.sweep(bk uuid, selected_runs uuid[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE violations jsonb:='[]'; financial jsonb; x record; r jsonb; now_at timestamptz:=statement_timestamp(); summary jsonb; v text;
BEGIN
 IF bk IS NULL OR NOT EXISTS(SELECT FROM ledger.book WHERE id=bk) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unknown integrity scope'; END IF;
 IF selected_runs IS NULL OR cardinality(selected_runs)>1000 OR cardinality(selected_runs)<>(SELECT count(DISTINCT id) FROM unnest(selected_runs) id)
 OR EXISTS(SELECT FROM unnest(selected_runs) AS sel(run_id) LEFT JOIN reconciliation.run rr ON rr.id=sel.run_id LEFT JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id IS DISTINCT FROM bk)
 OR EXISTS(SELECT FROM reconciliation.run WHERE id=ANY(selected_runs) GROUP BY mapping_id HAVING count(*)>1) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Explicit distinct mapping runs required'; END IF;
 -- Reuse source-owned and Phase 9 control mathematics, without creating a control run.
 SELECT coalesce(jsonb_agg(controls.evaluate_input(p)-ARRAY['evidence','details']), '[]') INTO financial
 FROM jsonb_array_elements(controls.snapshot(jsonb_build_object('bookId',bk,'reconciliationRunIds',to_jsonb(selected_runs),'maxAgeSeconds',86400),now_at)) p;
 FOR r IN SELECT value FROM jsonb_array_elements(financial) WHERE value->>'status'='FAIL' AND value->>'type' IN ('LEDGER','PROCESSING_PARTITION','RECONCILIATION') LOOP
  -- Incomplete running stages are explicit UNKNOWN; only a broken completed partition is a violation.
  violations:=violations||jsonb_build_array(jsonb_build_object('invariant','INTEGRITY_'||(r->>'type'),'entityIds',jsonb_build_array(coalesce(r->'scope'->>'journalId',r->'scope'->>'reconciliationRunId',r->'scope'->>'batchId',r->>'key')),'scope',r->'scope','evidence',r-ARRAY['scope','key']));
 END LOOP;
 FOR x IN
  SELECT 'SOURCE_RECEIPT_COUNT' invariant,b.id::text id FROM ingestion.batch b JOIN ingestion.source_account a ON a.id=b.source_account_id WHERE a.book_id=bk AND b.imported_count<>(SELECT count(*) FROM ingestion.raw_record WHERE batch_id=b.id)
  UNION ALL
  SELECT 'PROCESSING_OUTPUT_LINK',p.raw_id::text FROM ingestion.processing p JOIN ingestion.raw_record raw ON raw.id=p.raw_id JOIN ingestion.source_account a ON a.id=raw.source_account_id LEFT JOIN ingestion.interpretation i ON i.revision_id=p.revision_id AND i.normalizer_version=p.normalizer_version WHERE a.book_id=bk AND p.state<>'PENDING' AND (i.state IS DISTINCT FROM p.state OR p.completed_at IS NULL)
  UNION ALL
  SELECT 'OUTBOX_REGISTRATION',o.id::text FROM outbox.outbox_event o LEFT JOIN worker.registration reg ON reg.event_id=o.id LEFT JOIN worker.work_item w ON w.event_id=o.id WHERE o.book_id=bk AND (reg.event_id IS NULL OR (reg.disposition='WORK_REQUIRED' AND (w.id IS NULL OR w.handler IS DISTINCT FROM reg.handler OR w.handler_version IS DISTINCT FROM reg.handler_version)) OR (reg.disposition='NO_LOCAL_HANDLER' AND w.id IS NOT NULL))
  UNION ALL
  SELECT 'WORK_STATE_HISTORY',w.id::text FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE o.book_id=bk AND (
   w.attempt_count<>(SELECT count(*) FROM worker.attempt_event WHERE work_id=w.id AND kind='STARTED')
   OR w.attempt_count-CASE WHEN w.state='PROCESSING' THEN 1 ELSE 0 END<>(SELECT count(*) FROM worker.attempt_event WHERE work_id=w.id AND kind IN ('SUCCEEDED','FAILED','EXPIRED'))
   OR (w.state='PROCESSING')<>(num_nonnulls(w.lease_token,w.lease_owner,w.lease_principal,w.claimed_at,w.lease_expires_at)=5)
   OR (w.state='RETRYABLE')<>(w.next_attempt_at IS NOT NULL) OR (w.state IN ('SUCCEEDED','FAILED_TERMINAL'))<>(w.completed_at IS NOT NULL)
   OR (w.state='PROCESSING' AND NOT EXISTS(SELECT FROM worker.attempt_event WHERE work_id=w.id AND attempt=w.attempt_count AND kind='STARTED' AND lease_token=w.lease_token))
   OR w.attempt_count<0 OR w.attempt_count>w.max_attempts OR (w.state='PENDING' AND w.attempt_count<>0)
   OR (w.state='PROCESSING' AND w.lease_expires_at<=w.claimed_at)
   OR (w.state IN ('RETRYABLE','FAILED_TERMINAL') AND NOT EXISTS(SELECT FROM worker.attempt_event WHERE work_id=w.id AND attempt=w.attempt_count AND (kind='FAILED' OR (kind='EXPIRED' AND w.state='FAILED_TERMINAL'))))
   OR (w.state='SUCCEEDED' AND (NOT EXISTS(SELECT FROM worker.attempt_event WHERE work_id=w.id AND attempt=w.attempt_count AND kind='SUCCEEDED') OR EXISTS(SELECT FROM ingestion.processing p JOIN ingestion.raw_record raw ON raw.id=p.raw_id WHERE raw.batch_id=o.batch_id AND p.normalizer_version=o.normalizer_version AND p.state='PENDING'))))
  UNION ALL
  SELECT 'ALLOCATION_CONSERVATION',g.id::text FROM reconciliation.match_group g JOIN reconciliation.run rr ON rr.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id=bk AND (
   g.signed_amount_minor IS DISTINCT FROM (SELECT sum(signed_amount_minor) FROM reconciliation.match_group_member WHERE group_id=g.id AND role='PROCESSOR_SETTLEMENT')
   OR g.signed_amount_minor IS DISTINCT FROM (SELECT sum(signed_amount_minor) FROM reconciliation.match_group_member WHERE group_id=g.id AND role='BANK_MOVEMENT')
   OR 1<>(SELECT count(*) FROM reconciliation.match_group_member WHERE group_id=g.id AND role='BANK_MOVEMENT')
   OR EXISTS(SELECT FROM reconciliation.match_group_member gm LEFT JOIN reconciliation.outcome oc ON oc.run_id=gm.run_id AND oc.item_id=gm.item_id WHERE gm.group_id=g.id AND (gm.currency<>g.currency OR oc.group_id IS DISTINCT FROM g.id OR oc.outcome IS DISTINCT FROM 'MATCHED')))
  UNION ALL
  SELECT 'ALLOCATION_RESERVATION',g.id::text FROM reconciliation.match_group g JOIN reconciliation.run rr ON rr.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id=bk AND EXISTS(SELECT FROM reconciliation.current_allocation WHERE group_id=g.id) AND (SELECT count(*) FROM reconciliation.current_allocation WHERE group_id=g.id)<>(SELECT count(*) FROM reconciliation.match_group_member WHERE group_id=g.id)
  UNION ALL
  SELECT 'ALLOCATION_DUPLICATE_ECONOMIC_ITEM',coalesce(it.source_fact_id,it.observation_revision_id)::text FROM reconciliation.current_allocation ca JOIN reconciliation.item it ON it.id=ca.item_id JOIN reconciliation.match_group g ON g.id=ca.group_id JOIN reconciliation.run rr ON rr.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id=bk GROUP BY coalesce(it.source_fact_id,it.observation_revision_id),ca.relationship_scope HAVING count(*)>1
  UNION ALL
  SELECT 'EXCEPTION_EVENT_CHAIN',e.id::text FROM exceptions.event e JOIN exceptions.case_record c ON c.id=e.case_id JOIN reconciliation.account_mapping m ON m.id=c.mapping_id LEFT JOIN exceptions.event prev ON prev.case_id=e.case_id AND prev.version=e.version-1 WHERE m.book_id=bk AND ((e.version=1 AND (e.action<>'CREATED' OR e.previous_state<>'ABSENT')) OR (e.version>1 AND e.previous_state IS DISTINCT FROM prev.state) OR (e.state='RESOLVED')<>(e.resolution IS NOT NULL) OR NOT EXISTS(SELECT FROM audit.audit_event WHERE exception_event_id=e.id) OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE exception_event_id=e.id))
  UNION ALL
  SELECT 'EXCEPTION_MISSING_HISTORY',c.id::text FROM exceptions.case_record c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=bk AND NOT EXISTS(SELECT FROM exceptions.event WHERE case_id=c.id)
  UNION ALL
  SELECT 'CONTROL_COMPLETENESS',rr.id::text FROM controls.run rr WHERE rr.book_id=bk AND rr.state='COMPLETED' AND ((SELECT count(*) FROM controls.input WHERE run_id=rr.id)<>(SELECT count(*) FROM controls.result WHERE run_id=rr.id) OR NOT EXISTS(SELECT FROM audit.audit_event WHERE control_run_id=rr.id) OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE control_run_id=rr.id))
  UNION ALL
  SELECT 'CONTROL_FROZEN_INPUTS',rr.id::text FROM controls.run rr WHERE rr.book_id=bk AND rr.state<>'DRAFT' AND (rr.input_hash IS DISTINCT FROM encode(sha256(convert_to(rr.manifest::text,'UTF8')),'hex') OR rr.manifest IS DISTINCT FROM (SELECT coalesce(jsonb_agg(payload ORDER BY key),'[]') FROM controls.input WHERE run_id=rr.id))
  UNION ALL
  SELECT 'CONTROL_REPRODUCIBILITY',rr.id::text FROM controls.run rr JOIN controls.input i ON i.run_id=rr.id LEFT JOIN controls.result cr ON cr.run_id=i.run_id AND cr.key=i.key WHERE rr.book_id=bk AND cr.run_id IS NOT NULL AND cr.result IS DISTINCT FROM controls.evaluate_input(i.payload)
  UNION ALL
  SELECT 'LEDGER_COMPANIONS',j.id::text FROM ledger.ledger_transaction j WHERE j.book_id=bk AND (NOT EXISTS(SELECT FROM audit.audit_event WHERE journal_id=j.id) OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE journal_id=j.id) OR NOT EXISTS(SELECT FROM ledger.command_receipt WHERE journal_id=j.id))
  UNION ALL
  SELECT 'DUPLICATE_FINANCIAL_EFFECT',min(j.id::text) FROM ledger.ledger_transaction j WHERE j.book_id=bk GROUP BY j.effect_namespace,j.business_effect_key HAVING count(*)>1
  UNION ALL
  SELECT 'NORMALIZATION_INTENT_COMPANIONS',req.batch_id::text FROM ingestion.normalization_request req JOIN ingestion.batch b ON b.id=req.batch_id JOIN ingestion.source_account a ON a.id=b.source_account_id WHERE a.book_id=bk AND (NOT EXISTS(SELECT FROM outbox.outbox_event WHERE batch_id=req.batch_id AND normalizer_version=req.normalizer_version AND event_type='ingestion.normalization_requested') OR EXISTS(SELECT FROM ingestion.raw_record raw LEFT JOIN ingestion.processing p ON p.raw_id=raw.id AND p.normalizer_version=req.normalizer_version WHERE raw.batch_id=req.batch_id AND p.raw_id IS NULL))
  UNION ALL
  SELECT 'EXCEPTION_VERIFIED_EVIDENCE',e.id::text FROM exceptions.event e JOIN exceptions.case_record c ON c.id=e.case_id JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=bk AND e.resolution='FIXED_AND_VERIFIED' AND NOT EXISTS(SELECT FROM reconciliation.outcome WHERE run_id=e.evidence_run_id AND item_id=c.item_id AND outcome='MATCHED')
 LOOP
  violations:=violations||jsonb_build_array(jsonb_build_object('invariant',x.invariant,'entityIds',jsonb_build_array(x.id),'scope',jsonb_build_object('bookId',bk),'evidence',jsonb_build_object('check','STRUCTURAL_QUERY')));
 END LOOP;
 -- Explicitly selected canonical exposure: metadata never adds another monetary component.
 FOR x IN SELECT id FROM reconciliation.run WHERE id=ANY(selected_runs) AND state='COMPLETED' LOOP
  r:=controls.exposure(x.id);
  IF EXISTS(SELECT FROM jsonb_array_elements(r->'components') z GROUP BY z->>'identity' HAVING count(*)>1)
  OR (r->>'acceptedRiskMinor')::numeric>(r->>'unreconciledMinor')::numeric
  OR (r->>'acceptedRiskMinor')::numeric IS DISTINCT FROM (CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(r->'components') z WHERE z->>'identity'='unproven-cross-side-overlap' OR (z->>'amountMinor' IS NULL AND (z->>'acceptedRisk')::boolean)) THEN NULL ELSE (SELECT coalesce(sum((z->>'amountMinor')::numeric) FILTER(WHERE (z->>'acceptedRisk')::boolean),0) FROM jsonb_array_elements(r->'components') z) END)
  THEN violations:=violations||jsonb_build_array(jsonb_build_object('invariant','EXPOSURE_CANONICAL','entityIds',jsonb_build_array(x.id),'scope',jsonb_build_object('bookId',bk),'evidence',jsonb_build_object('check','COMPONENT_IDENTITY_AND_SUBSET'))); END IF;
 END LOOP;
 SELECT jsonb_build_object('pending',count(*) FILTER(WHERE state='PENDING'),'processing',count(*) FILTER(WHERE state='PROCESSING'),'retryable',count(*) FILTER(WHERE state='RETRYABLE'),'terminal',count(*) FILTER(WHERE state='FAILED_TERMINAL'),'succeeded',count(*) FILTER(WHERE state='SUCCEEDED'),'expiredRecoverable',count(*) FILTER(WHERE state='PROCESSING' AND lease_expires_at<=now_at)) INTO summary FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE o.book_id=bk;
 SELECT CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(financial) p WHERE p->>'status'='FAIL') THEN 'FAIL' WHEN EXISTS(SELECT FROM jsonb_array_elements(financial) p WHERE p->>'status'='UNKNOWN') THEN 'UNKNOWN' ELSE 'PASS' END INTO v;
 RETURN jsonb_build_object('version','system-integrity-v1','bookId',bk,'asOf',now_at,'integrity',CASE WHEN jsonb_array_length(violations)=0 THEN 'PASS' ELSE 'FAIL' END,'financialAssurance',v,'violations',violations,'controls',financial,'work',summary,'open',jsonb_build_object('exceptions',(SELECT count(*) FROM exceptions.current_case c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=bk AND c.state<>'RESOLVED'),'unknownControls',(SELECT count(*) FROM jsonb_array_elements(financial) z WHERE z->>'status'='UNKNOWN')));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA integrity FROM PUBLIC;
GRANT USAGE ON SCHEMA integrity TO flow_integrity_reader;
GRANT EXECUTE ON FUNCTION integrity.sweep(uuid,uuid[]) TO flow_integrity_reader;
RESET ROLE;
