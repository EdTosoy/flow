-- Phase 12: approved, versioned operations reads only. No financial data rewrite.
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='flow_operations_reader') THEN CREATE ROLE flow_operations_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='flow_operations_reader' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe operations capability'; END IF;
END $$;
CREATE SCHEMA operations AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA operations FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
-- Fixed operations allowlist, book scoping, parameter-only predicates and bounded projections.
CREATE FUNCTION operations.read_v1(bk uuid, kind text, opt jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE data jsonb; rows jsonb; summary jsonb; swept jsonb; cr controls.run%ROWTYPE; rr reconciliation.run%ROWTYPE;
 lim integer:=coalesce((opt->>'limit')::integer,50); cid uuid:=(opt->>'id')::uuid; ev uuid:=(opt->>'evaluation')::uuid;
 after_id uuid:=coalesce((opt->'cursor'->>'id')::uuid,'00000000-0000-0000-0000-000000000000');
 after_time timestamptz:=coalesce((opt->'cursor'->>'time')::timestamptz,'-infinity');
 after_key text:=coalesce(opt->'cursor'->>'key',''); selected uuid[]:='{}';
BEGIN
 IF lim NOT BETWEEN 1 AND 100 OR jsonb_typeof(opt)<>'object' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid read parameters'; END IF;
 IF kind='books' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."cursorTime",x.id),'[]') INTO rows FROM(SELECT id,code,environment,created_at::text AS "cursorTime" FROM ledger.book WHERE (created_at,id)>(after_time,after_id) ORDER BY created_at,id LIMIT lim+1)x;
  RETURN jsonb_build_object('version','operations-read-v1','asOf',statement_timestamp(),'items',rows);
 END IF;
 IF bk IS NULL OR NOT EXISTS(SELECT FROM ledger.book WHERE id=bk) THEN RAISE EXCEPTION USING ERRCODE='P0012',MESSAGE='Read scope not found'; END IF;
 IF ev IS NOT NULL THEN
  SELECT * INTO cr FROM controls.run WHERE id=ev AND book_id=bk;
  IF cr.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0012',MESSAGE='Read scope not found'; END IF;
  selected:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(cr.command->'reconciliationRunIds'));
 END IF;
 IF kind IN ('overview','integrity') THEN
  swept:=integrity.sweep(bk,selected);
  IF ev IS NOT NULL THEN summary:=controls.summary(ev); END IF;
  data:=jsonb_build_object('book',(SELECT jsonb_build_object('id',id,'code',code,'environment',environment) FROM ledger.book WHERE id=bk),
   'integrity',swept,'evaluation',CASE WHEN summary IS NOT NULL THEN summary-'results'-'processing'-'statuses' END,
   'latestEvaluationAt',(SELECT max(completed_at) FROM controls.run WHERE book_id=bk));
 ELSIF kind='evaluations' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."cursorTime",x.id),'[]') INTO rows FROM(
   SELECT id,version,state,created_at::text AS "cursorTime",frozen_at AS "frozenAt",completed_at AS "completedAt" FROM controls.run WHERE book_id=bk AND (created_at,id)>(after_time,after_id) ORDER BY created_at,id LIMIT lim+1)x;
 ELSIF kind='controls' THEN
  IF ev IS NULL THEN rows:='[]'; ELSE
   summary:=controls.summary(ev);
   SELECT coalesce(jsonb_agg(z ORDER BY z->>'key'),'[]') INTO rows FROM(
    SELECT value||jsonb_build_object('cursorKey',value->>'key','caseIds',(SELECT coalesce(jsonb_agg(case_id ORDER BY case_id),'[]') FROM controls.case_link WHERE run_id=ev AND key=value->>'key')) AS z FROM jsonb_array_elements(summary->'results')
    WHERE value->>'key'>after_key AND (opt->>'status' IS NULL OR value->>'status'=opt->>'status') AND (opt->>'category' IS NULL OR value->>'type'=opt->>'category') AND (opt->>'currency' IS NULL OR value->>'currency'=opt->>'currency') ORDER BY value->>'key' LIMIT lim+1)x;
   data:=jsonb_build_object('evaluation',summary-'results'-'processing'-'reconciliation'-'exposure');
  END IF;
 ELSIF kind='control' THEN
  IF ev IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Evaluation required'; END IF;
  summary:=controls.summary(ev);
  SELECT value||jsonb_build_object('evaluationId',ev,'evaluationVersion',cr.version,'evaluatedAt',cr.frozen_at,'current',summary->'current','currentReason',summary->>'currentReason','caseIds',(SELECT coalesce(jsonb_agg(case_id ORDER BY case_id),'[]') FROM controls.case_link WHERE run_id=ev AND key=value->>'key')) INTO data FROM jsonb_array_elements(summary->'results') WHERE value->>'key'=opt->>'key';
 ELSIF kind='reconciliation' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."cursorTime",x.id),'[]') INTO rows FROM(
   SELECT r.id,r.mapping_id AS "mappingId",r.rule_version AS "ruleVersion",r.state,m.currency,r.started_at::text AS "cursorTime",r.completed_at AS "completedAt",(SELECT count(*)::text FROM reconciliation.match_group WHERE run_id=r.id AND shape='1:1') AS "exactGroups",(SELECT count(*)::text FROM reconciliation.match_group WHERE run_id=r.id AND shape='N:1') AS "groupedGroups",reconciliation.summary(r.id) AS summary
   FROM reconciliation.run r JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE m.book_id=bk AND (r.started_at,r.id)>(after_time,after_id) AND (opt->>'currency' IS NULL OR m.currency=opt->>'currency') AND (opt->>'status' IS NULL OR r.state=opt->>'status') AND (cid IS NULL OR r.id=cid) ORDER BY r.started_at,r.id LIMIT lim+1)x;
 ELSIF kind='run' THEN
  SELECT r.* INTO rr FROM reconciliation.run r JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE r.id=cid AND m.book_id=bk;
  IF rr.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0012',MESSAGE='Read scope not found'; END IF;
  data:=jsonb_build_object('id',rr.id,'mappingId',rr.mapping_id,'ruleVersion',rr.rule_version,'state',rr.state,'windowFrom',rr.window_from,'windowTo',rr.window_to,'frozenAt',rr.sealed_at,'completedAt',rr.completed_at,'summary',reconciliation.summary(rr.id),'currency',(SELECT currency FROM reconciliation.account_mapping WHERE id=rr.mapping_id));
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') INTO rows FROM(
   SELECT m.item_id AS id,m.side,m.processor_batch_id AS "processorEvidenceId",m.bank_entry_id AS "bankEvidenceId",(m.snapshot-'history'-'groupVariants')||jsonb_build_object('history',(SELECT coalesce(jsonb_agg(value),'[]') FROM(SELECT value FROM jsonb_array_elements(coalesce(m.snapshot->'history','[]')) WITH ORDINALITY ORDER BY ordinality LIMIT 50) h),'historyCount',jsonb_array_length(coalesce(m.snapshot->'history','[]')),'groupVariants',(SELECT coalesce(jsonb_agg(value),'[]') FROM(SELECT value FROM jsonb_array_elements(coalesce(m.snapshot->'groupVariants','[]')) WITH ORDINALITY ORDER BY ordinality LIMIT 50) h),'groupVariantCount',jsonb_array_length(coalesce(m.snapshot->'groupVariants','[]'))) AS snapshot,exceptions.cause(m.run_id,m.item_id) AS cause,o.outcome AS outcome,o.reason,o.group_id AS "groupId",
    (SELECT jsonb_build_object('id',g.id,'shape',g.shape,'amountMinor',g.signed_amount_minor::text,'currency',g.currency,'current',reconciliation.current_valid(g.id),'proof',g.evidence-'processorSnapshot'-'processorSnapshots'-'bankSnapshot','frozenDifferenceMinor',((g.evidence->'bankSnapshot'->>'amountMinor')::numeric-(g.evidence->>'signedAmountMinor')::numeric)::text,'members',(SELECT jsonb_agg(jsonb_build_object('itemId',gm.item_id,'role',gm.role,'amountMinor',gm.signed_amount_minor::text) ORDER BY gm.item_id) FROM reconciliation.match_group_member gm WHERE gm.group_id=g.id)) FROM reconciliation.match_group g WHERE g.id=o.group_id) AS allocation,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'state',c.state,'resolution',c.resolution)),'[]') FROM exceptions.current_case c WHERE c.item_id=m.item_id AND c.mapping_id=rr.mapping_id) AS cases
   FROM reconciliation.run_member m LEFT JOIN reconciliation.outcome o ON o.run_id=m.run_id AND o.item_id=m.item_id WHERE m.run_id=rr.id AND m.item_id>after_id AND (opt->>'status' IS NULL OR o.outcome=opt->>'status') ORDER BY m.item_id LIMIT lim+1)x;
 ELSIF kind='exceptions' THEN
  SELECT coalesce(jsonb_agg(z ORDER BY ct,id),'[]') INTO rows FROM(
   SELECT c.id,c.created_at ct,exceptions.case_view(c.id)||jsonb_build_object('cursorTime',c.created_at::text,'updatedAt',c.updated_at) z FROM exceptions.current_case c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=bk AND (c.created_at,c.id)>(after_time,after_id)
    AND (opt->>'status' IS NULL OR c.state=opt->>'status') AND (opt->>'currency' IS NULL OR m.currency=opt->>'currency') AND (opt->>'category' IS NULL OR c.classification=opt->>'category') AND (cid IS NULL OR c.id=cid) ORDER BY c.created_at,c.id LIMIT lim+1)x;
 ELSIF kind='case' THEN
  IF NOT EXISTS(SELECT FROM exceptions.case_record c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE c.id=cid AND m.book_id=bk) THEN RAISE EXCEPTION USING ERRCODE='P0012',MESSAGE='Read scope not found'; END IF;
  data:=exceptions.case_view(cid)||jsonb_build_object('linkedControlCount',(SELECT count(*)::text FROM controls.case_link WHERE case_id=cid),'linkedControls',(SELECT coalesce(jsonb_agg(jsonb_build_object('evaluation',run_id,'key',key) ORDER BY run_id,key),'[]') FROM (SELECT run_id,key FROM controls.case_link WHERE case_id=cid ORDER BY run_id,key LIMIT 100)x));
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.version),'[]') INTO rows FROM(
   SELECT e.id,version,action,previous_state AS "previousState",state,classification,assignee_id AS "assigneeId",resolution,actor_id AS "actorId",reason,note,evidence_run_id AS "evidenceRunId",created_at AS "createdAt",to_jsonb(a)-'event_id' AS attachment FROM exceptions.event e LEFT JOIN exceptions.attachment a ON a.event_id=e.id WHERE e.case_id=cid AND e.version>coalesce((opt->'cursor'->>'sequence')::integer,0) ORDER BY version LIMIT lim+1)x;
 ELSIF kind='workers' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."cursorTime",x.id),'[]') INTO rows FROM(
   SELECT w.id,w.state,w.handler,w.handler_version AS "handlerVersion",w.attempt_count AS attempts,w.max_attempts AS "maxAttempts",w.created_at::text AS "cursorTime",w.next_attempt_at AS "nextAttemptAt",w.lease_expires_at AS "leaseExpiresAt",w.completed_at AS "completedAt",w.last_failure_class AS "failureClass",w.last_failure_code AS "failureCode",o.event_type AS "eventType",(w.state='PROCESSING' AND w.lease_expires_at<=statement_timestamp()) AS "expiredRecoverable"
   FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE o.book_id=bk AND (w.created_at,w.id)>(after_time,after_id) AND (opt->>'status' IS NULL OR w.state=opt->>'status') AND (cid IS NULL OR w.id=cid) ORDER BY w.created_at,w.id LIMIT lim+1)x;
  data:=jsonb_build_object('counts',(SELECT jsonb_object_agg(state,n) FROM(SELECT state,count(*)::text n FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE o.book_id=bk GROUP BY state)x),'oldestPendingAt',(SELECT min(w.created_at) FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE o.book_id=bk AND w.state='PENDING'));
 ELSIF kind='work' THEN
  SELECT jsonb_build_object('id',w.id,'state',w.state,'handler',w.handler,'eventType',o.event_type,'attempts',w.attempt_count,'nextAttemptAt',w.next_attempt_at,'leaseExpiresAt',w.lease_expires_at,'createdAt',w.created_at,'completedAt',w.completed_at,'failureClass',w.last_failure_class,'failureCode',w.last_failure_code) INTO data FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id WHERE w.id=cid AND o.book_id=bk;
  IF data IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0012',MESSAGE='Read scope not found'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."cursorTime",x.id),'[]') INTO rows FROM(SELECT e.id,e.attempt,e.kind,e.failure_class AS "failureClass",e.failure_code AS "failureCode",e.recorded_at::text AS "cursorTime" FROM worker.attempt_event e WHERE e.work_id=cid AND (e.recorded_at,e.id)>(after_time,after_id) ORDER BY e.recorded_at,e.id LIMIT lim+1)x;
 ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Unsupported read operation'; END IF;
 IF data IS NULL AND rows IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0012',MESSAGE='Read scope not found'; END IF;
 RETURN jsonb_build_object('version','operations-read-v1','asOf',statement_timestamp(),'data',data,'items',rows);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA operations FROM PUBLIC;
GRANT USAGE ON SCHEMA operations TO flow_operations_reader;
GRANT EXECUTE ON FUNCTION operations.read_v1(uuid,text,jsonb) TO flow_operations_reader;
RESET ROLE;
