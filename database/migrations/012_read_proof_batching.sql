-- Phase 13: statement-local batching of existing proofs. No cache or financial history rewrite.
RESET ROLE;
SET LOCAL ROLE flow_ledger_owner;
-- Each distinct original mapping/window population is built once per invocation.
-- valid_against remains the unchanged versioned financial predicate.
CREATE FUNCTION reconciliation.current_valid_many(ids uuid[])
RETURNS TABLE(id uuid,valid boolean) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH groups AS MATERIALIZED (
  SELECT g.id,r.mapping_id,r.window_from,r.window_to FROM reconciliation.match_group g
  JOIN reconciliation.run r ON r.id=g.run_id WHERE g.id=ANY(ids)
 ), scopes AS MATERIALIZED (SELECT DISTINCT mapping_id,window_from,window_to FROM groups),
 populations AS MATERIALIZED (
  SELECT s.*,(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM reconciliation.population(s.mapping_id,s.window_from,s.window_to) x) AS fresh FROM scopes s
 )
 SELECT g.id,reconciliation.valid_against(g.id,p.fresh) FROM groups g
 JOIN populations p USING(mapping_id,window_from,window_to)
$$;
CREATE FUNCTION reconciliation.current_groups(rid uuid)
RETURNS TABLE(id uuid,run_id uuid,status text) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH groups AS MATERIALIZED (
  SELECT g.id,g.run_id,initial.decision AS initial,terminal.decision AS terminal
  FROM reconciliation.match_group g LEFT JOIN reconciliation.allocation_decision initial
  ON initial.group_id=g.id AND initial.decision IN ('ACTIVE','STALE','CONFLICT')
  LEFT JOIN reconciliation.allocation_decision terminal ON terminal.group_id=g.id AND terminal.decision IN ('SUPERSEDED','INVALIDATED') WHERE g.run_id=rid
 ), validity AS MATERIALIZED (
  SELECT * FROM reconciliation.current_valid_many(ARRAY(SELECT id FROM groups WHERE initial='ACTIVE' AND terminal IS NULL))
 )
 SELECT g.id,g.run_id,CASE WHEN g.terminal IS NOT NULL THEN g.terminal
 WHEN g.initial='ACTIVE' THEN CASE WHEN v.valid THEN 'ACTIVE' ELSE 'INVALIDATED' END ELSE g.initial END
 FROM groups g LEFT JOIN validity v ON v.id=g.id
$$;
CREATE FUNCTION reconciliation.active_items(ids uuid[])
RETURNS TABLE(item_id uuid) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH allocations AS MATERIALIZED (
  SELECT a.* FROM reconciliation.current_allocation a
  JOIN reconciliation.allocation_decision initial ON initial.group_id=a.group_id AND initial.decision='ACTIVE'
  WHERE a.item_id=ANY(ids) AND NOT EXISTS(SELECT FROM reconciliation.allocation_decision terminal WHERE terminal.group_id=a.group_id AND terminal.decision IN ('SUPERSEDED','INVALIDATED'))
 ), validity AS MATERIALIZED (
  SELECT * FROM reconciliation.current_valid_many(ARRAY(SELECT DISTINCT group_id FROM allocations))
 )
 SELECT a.item_id FROM allocations a JOIN validity v ON v.id=a.group_id WHERE v.valid
$$;
-- Internal helper only: callers supply the snapshot-local authoritative allocation result.

CREATE FUNCTION exceptions.cause_with_current(rid uuid,iid uuid,active uuid[]) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE m reconciliation.run_member%ROWTYPE; o reconciliation.outcome%ROWTYPE; r reconciliation.run%ROWTYPE;  cls text; amount numeric; exposure numeric; exwhy text; edges jsonb; grouped jsonb; condition jsonb;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid;
 SELECT * INTO STRICT m FROM reconciliation.run_member WHERE run_id=rid AND item_id=iid;
 SELECT * INTO STRICT o FROM reconciliation.outcome WHERE run_id=rid AND item_id=iid;
 IF r.state<>'COMPLETED' THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Cases require completed outcomes'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(c)-'run_id' ORDER BY c.processor_item_id,c.bank_item_id),'[]') INTO edges FROM reconciliation.candidate c WHERE run_id=rid AND (processor_item_id=iid OR bank_item_id=iid);
 SELECT coalesce(jsonb_agg(to_jsonb(c)-'run_id' ORDER BY c.group_key_hash,c.bank_item_id),'[]') INTO grouped FROM reconciliation.group_candidate c WHERE run_id=rid AND (bank_item_id=iid OR iid=ANY(processor_item_ids));
 IF o.outcome='MATCHED' THEN
  IF iid=ANY(active) THEN RETURN NULL; END IF;
  cls:='CURRENT_PROOF_INVALIDATED'; exposure:=NULL; exwhy:='CURRENT_PROOF_UNAVAILABLE';
 ELSIF o.outcome='AMBIGUOUS' THEN cls:='AMBIGUOUS_MATCH'; exwhy:='AMBIGUOUS_COUNTERPART';
 ELSIF o.outcome='INELIGIBLE' THEN
  cls:=CASE WHEN m.snapshot->'reasons' ?| ARRAY['AMBIGUOUS_REVISION','AMBIGUOUS_ACTIVITY','AMBIGUOUS_SETTLEMENT','AMBIGUOUS_ENTRY','AMBIGUOUS_STATEMENT'] THEN 'SOURCE_REVISION_AMBIGUITY'
   WHEN m.snapshot->'reasons' ? 'SOURCE_INCOMPLETE' THEN 'SOURCE_INCOMPLETENESS'
   WHEN m.snapshot->'reasons' ?| ARRAY['DUPLICATE_MEMBERSHIP','DUPLICATE_LINE_IDENTITY','DUPLICATE_SOURCE_LINE_REFERENCE'] THEN 'DUPLICATE_EVIDENCE'
   WHEN m.snapshot->'reasons' ?| ARRAY['MISSING_ACTIVITY','PENDING_ACTIVITY','CROSS_CURRENCY_MEMBERSHIP','CONFLICTING_MEMBERSHIP','NET_MISMATCH','PAYMENT_CONTROL_FAILED','INVALID_SIGN','INVALID_PARENT','CROSS_CURRENCY_PAYMENT','REFUND_EXCEEDS_CAPTURE','CLOSING_BALANCE_MISMATCH','LINE_COUNT_MISMATCH','MISSING_REFERENCED_LINE','LINE_REFERENCE_COVERAGE','SEQUENCE_COVERAGE_FAILED','INVALID_STATEMENT_ORDERING','ENTRY_OUTSIDE_STATEMENT_PERIOD','PENDING_ENTRY','CONFLICTING_STATEMENT_ASSOCIATION','UNVERIFIED_ENTRY_IDENTITY','MISSING_STATEMENT_REPORT'] THEN CASE WHEN m.side='PROCESSOR' THEN 'PROCESSOR_INCONSISTENCY' ELSE 'BANK_INCONSISTENCY' END
   ELSE 'UNSUPPORTED_CASE' END; exwhy:='INELIGIBLE_EVIDENCE';
 ELSE
  cls:=CASE WHEN jsonb_array_length(grouped)>0 THEN 'UNSUPPORTED_CASE' WHEN jsonb_array_length(edges)=0 THEN CASE WHEN m.side='PROCESSOR' THEN 'MISSING_BANK_MOVEMENT' ELSE 'EXTRA_BANK_MOVEMENT' END ELSE 'UNSUPPORTED_CASE' END;
  exwhy:='WHOLE_UNMATCHED_ITEM'; amount:=(m.snapshot->>'amountMinor')::numeric;
  IF jsonb_array_length(grouped)>0 THEN exwhy:='GROUPED_DISCREPANCY_UNKNOWN';
  ELSIF jsonb_array_length(edges)=1 AND (edges->0->'evidence'->>'amountExact')='false' AND (edges->0->'evidence'->>'processorEligible')='true' AND (edges->0->'evidence'->>'bankEligible')='true'
   AND NOT EXISTS(SELECT FROM reconciliation.candidate c WHERE c.run_id=rid AND (c.processor_item_id=(edges->0->>'processor_item_id')::uuid OR c.bank_item_id=(edges->0->>'bank_item_id')::uuid) AND to_jsonb(c)-'run_id'<>edges->0) THEN
   cls:='AMOUNT_MISMATCH'; exwhy:='EXACT_PAIR_RESIDUAL';
   SELECT abs((p.snapshot->>'amountMinor')::numeric-(b.snapshot->>'amountMinor')::numeric) INTO exposure FROM reconciliation.run_member p JOIN reconciliation.run_member b ON b.run_id=p.run_id WHERE p.run_id=rid AND p.item_id=(edges->0->>'processor_item_id')::uuid AND b.item_id=(edges->0->>'bank_item_id')::uuid;
  ELSIF jsonb_array_length(edges)=0 AND (m.snapshot->>'eligible')::boolean THEN exposure:=abs(amount);
  ELSE exwhy:='FAILED_RULE_DISCREPANCY_UNKNOWN'; END IF;
 END IF;
 IF exposure>9223372036854775807 THEN exposure:=NULL; exwhy:='MONEY_MAGNITUDE_OUT_OF_RANGE'; END IF;
 condition:=jsonb_build_object('outcome',o.outcome,'reason',o.reason,'snapshot',m.snapshot,'candidates',edges,'groupCandidates',grouped,'invalidCurrentProof',o.outcome='MATCHED');
 RETURN jsonb_build_object('condition',condition,'classification',cls,'currency',(SELECT currency FROM reconciliation.account_mapping WHERE id=r.mapping_id),'exposureMinor',exposure::text,'exposureReason',exwhy);
END $$;
-- Existing command callers retain their two-argument interface and guarded proof lookup.
CREATE OR REPLACE FUNCTION exceptions.cause(rid uuid,iid uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT exceptions.cause_with_current(rid,iid,CASE WHEN (SELECT outcome FROM reconciliation.outcome WHERE run_id=rid AND item_id=iid)='MATCHED'
 THEN ARRAY(SELECT item_id FROM reconciliation.active_allocation WHERE item_id=iid) ELSE '{}'::uuid[] END)
$$;
CREATE OR REPLACE FUNCTION controls.exposure(rid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; row record; cause jsonb; k text; items uuid[]; components jsonb:='[]'; seen text[]:='{}'; amount numeric; risk boolean; events jsonb; active uuid[];
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid;
 IF r.state<>'COMPLETED' THEN RETURN jsonb_build_object('components','[]'::jsonb,'unreconciledMinor','0','acceptedRiskMinor','0','unknownCount',1,'state',r.state); END IF;
 SELECT ARRAY(SELECT item_id FROM reconciliation.active_items(ARRAY(SELECT item_id FROM reconciliation.run_member WHERE run_id=rid))) INTO active;
 FOR row IN SELECT * FROM reconciliation.run_member WHERE run_id=rid ORDER BY item_id LOOP
  IF row.item_id=ANY(active) THEN CONTINUE; END IF;
  cause:=exceptions.cause_with_current(rid,row.item_id,active); IF cause IS NULL THEN CONTINUE; END IF;
  items:=ARRAY[row.item_id]; k:='item:'||row.item_id;
  IF cause->>'classification'='AMOUNT_MISMATCH' THEN
   items:=ARRAY[(cause->'condition'->'candidates'->0->>'processor_item_id')::uuid,(cause->'condition'->'candidates'->0->>'bank_item_id')::uuid];
   -- A counterpart allocated by a different valid run invalidates this old residual's interpretation.
   IF items && active THEN
    cause:=jsonb_set(cause,'{exposureMinor}','null'::jsonb);
   END IF;
   k:='pair:'||items[1]||':'||items[2];
  END IF;
  IF k=ANY(seen) THEN CONTINUE; END IF; seen:=array_append(seen,k);
  SELECT coalesce(bool_or(c.state='RESOLVED' AND c.resolution='ACCEPTED_RISK'),false),coalesce(jsonb_agg(jsonb_build_object('caseId',c.id,'eventId',c.event_id,'version',c.version,'state',c.state,'resolution',c.resolution) ORDER BY c.id),'[]') INTO risk,events
  FROM exceptions.current_case c WHERE c.mapping_id=r.mapping_id AND c.item_id=ANY(items);
  amount:=(cause->>'exposureMinor')::numeric;
  components:=components||jsonb_build_array(jsonb_build_object('identity',k,'itemIds',to_jsonb(items),'amountMinor',amount::text,'acceptedRisk',risk,'side',CASE WHEN k LIKE 'pair:%' THEN 'RELATIONSHIP' ELSE row.side END,'caseEvents',events,'reason',cause->>'exposureReason','cause',cause));
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_array_elements(components) z WHERE z->>'side'='PROCESSOR') AND EXISTS(SELECT FROM jsonb_array_elements(components) z WHERE z->>'side'='BANK') THEN
  components:=components||jsonb_build_array(jsonb_build_object('identity','unproven-cross-side-overlap','side','UNKNOWN','amountMinor',NULL,'acceptedRisk',false,'reason','CROSS_SIDE_EXPOSURE_NOT_ADDITIVE'));
 END IF;
 RETURN jsonb_build_object('state',r.state,'components',components,'knownUnreconciledMinor',CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(components) z WHERE z->>'identity'='unproven-cross-side-overlap') THEN NULL ELSE (SELECT coalesce(sum((x->>'amountMinor')::numeric),0)::text FROM jsonb_array_elements(components) x) END,
 'knownAcceptedRiskMinor',CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(components) z WHERE z->>'identity'='unproven-cross-side-overlap') THEN NULL ELSE (SELECT coalesce(sum((x->>'amountMinor')::numeric) FILTER(WHERE (x->>'acceptedRisk')::boolean),0)::text FROM jsonb_array_elements(components) x) END,
 'unreconciledMinor',CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(components) z WHERE z->>'amountMinor' IS NULL) THEN NULL ELSE (SELECT coalesce(sum((x->>'amountMinor')::numeric),0)::text FROM jsonb_array_elements(components) x) END,
 'acceptedRiskMinor',CASE WHEN EXISTS(SELECT FROM jsonb_array_elements(components) z WHERE z->>'identity'='unproven-cross-side-overlap' OR (z->>'amountMinor' IS NULL AND (z->>'acceptedRisk')::boolean)) THEN NULL ELSE (SELECT coalesce(sum((x->>'amountMinor')::numeric) FILTER(WHERE (x->>'acceptedRisk')::boolean),0)::text FROM jsonb_array_elements(components) x) END,
 'unknownCount',(SELECT count(*) FROM jsonb_array_elements(components) x WHERE x->>'amountMinor' IS NULL),
 'acceptedRiskUnknownCount',(SELECT count(*) FROM jsonb_array_elements(components) x WHERE x->>'amountMinor' IS NULL AND (x->>'acceptedRisk')::boolean),
 'processorClaimMinor',(SELECT coalesce(sum((x->>'amountMinor')::numeric),0)::text FROM jsonb_array_elements(components) x WHERE x->>'side'='PROCESSOR'),
 'bankClaimMinor',(SELECT coalesce(sum((x->>'amountMinor')::numeric),0)::text FROM jsonb_array_elements(components) x WHERE x->>'side'='BANK'),
 'pairResidualMinor',(SELECT coalesce(sum((x->>'amountMinor')::numeric),0)::text FROM jsonb_array_elements(components) x WHERE x->>'side'='RELATIONSHIP'));

END $$;
CREATE OR REPLACE FUNCTION controls.snapshot(p jsonb,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE bk uuid:=(p->>'bookId')::uuid; data jsonb[]:='{}'; x record; y record; s jsonb; scope jsonb; ev jsonb; d jsonb; e numeric; o numeric; n bigint; pending bigint; failed bigint; missing bigint; invalid integer; c text; v_side text; validity jsonb; active_cases uuid[];
BEGIN
 IF (SELECT count(*) FROM ingestion.raw_record rr JOIN ingestion.source_account a ON a.id=rr.source_account_id WHERE a.book_id=bk)>100000 THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='Control population bound exceeded'; END IF;
 IF NOT EXISTS(SELECT FROM ingestion.source_account WHERE book_id=bk) THEN
  data:=array_append(data,controls.input_data('source-period:book:'||bk,'SOURCE_PERIOD',jsonb_build_object('bookId',bk,'population','ALL_RECEIVED_AS_OF_FREEZE'),NULL,NULL,NULL,'total',jsonb_build_object('reason','NO_CONFIGURED_SOURCE_SCOPE_OR_INDEPENDENT_PERIOD_CLOSURE'),'{}'));
 END IF;
 FOR x IN SELECT a.*,src.provider,src.environment FROM ingestion.source_account a JOIN ingestion.source src ON src.id=a.source_id WHERE a.book_id=bk ORDER BY a.id LOOP
  scope:=jsonb_build_object('bookId',bk,'sourceAccountId',x.id,'environment',x.environment,'provider',x.provider,'population','ALL_RECEIVED_AS_OF_FREEZE');
  data:=array_append(data,controls.input_data('source-period:'||x.id,'SOURCE_PERIOD',scope,NULL,NULL,NULL,'total',jsonb_build_object('reason','NO_INDEPENDENT_PERIOD_CLOSURE'),'{}'));
  FOR y IN SELECT * FROM ingestion.batch WHERE source_account_id=x.id ORDER BY id LOOP
   SELECT count(*),coalesce(jsonb_agg(jsonb_build_object('rawId',id,'revisionId',revision_id,'sequence',source_sequence,'checksum',checksum) ORDER BY id),'[]') INTO n,ev FROM ingestion.raw_record WHERE batch_id=y.id;
   d:=jsonb_build_object('completeness',ingestion.coverage(y.id),'expectedCount',y.expected_count,'sequenceFrom',y.sequence_from,'sequenceTo',y.sequence_to,'importedCount',y.imported_count,'received',n,'manifestChecksum',y.manifest_checksum,'artifactChecksum',y.artifact_checksum);
   data:=array_append(data,controls.input_data('source:'||y.id,'SOURCE',scope||jsonb_build_object('batchId',y.id),NULL,coalesce(y.expected_count,y.sequence_to::bigint-y.sequence_from+1),n,'coverage',d,ev));
   FOR c IN SELECT normalizer_version FROM ingestion.normalization_request WHERE batch_id=y.id ORDER BY normalizer_version LOOP
    SELECT count(*) FILTER(WHERE pr.state='PENDING'),count(*) FILTER(WHERE pr.state='FAILED'),count(*) FILTER(WHERE pr.state='NORMALIZED'),count(*) FILTER(WHERE pr.raw_id IS NULL),coalesce(jsonb_agg(jsonb_build_object('rawId',rr.id,'revisionId',rr.revision_id,'state',pr.state,'interpretation',i.result,'completedAt',pr.completed_at) ORDER BY rr.id),'[]')
    INTO pending,failed,o,missing,ev FROM ingestion.raw_record rr LEFT JOIN ingestion.processing pr ON pr.raw_id=rr.id AND pr.normalizer_version=c LEFT JOIN ingestion.interpretation i ON i.revision_id=rr.revision_id AND i.normalizer_version=c WHERE rr.batch_id=y.id;
    d:=jsonb_build_object('received',n,'normalized',o,'failed',failed,'pending',pending,'missing',missing,'normalizerVersion',c);
    data:=array_append(data,controls.input_data('partition:'||y.id||':'||c,'PROCESSING_PARTITION',scope||jsonb_build_object('batchId',y.id,'normalizerVersion',c),NULL,n,o+pending+failed,'partition',d,ev));
 data:=array_append(data,controls.input_data('processing:'||y.id||':'||c,'PROCESSING_COMPLETION',scope||jsonb_build_object('batchId',y.id,'normalizerVersion',c),NULL,n,o,'completion',d,ev));
   END LOOP;
  END LOOP;
  -- Every successfully normalized supported interpretation must have its pinned domain derivation.
  FOR c IN SELECT unnest(ARRAY['PROCESSOR_COVERAGE','BANK_COVERAGE']) LOOP
   SELECT count(*),count(dd.id),coalesce(jsonb_agg(jsonb_build_object('revisionId',i.revision_id,'normalizerVersion',i.normalizer_version,'derivationId',dd.id) ORDER BY i.revision_id,i.normalizer_version),'[]') INTO e,o,ev
   FROM ingestion.interpretation i JOIN ingestion.revision rev ON rev.id=i.revision_id
   LEFT JOIN LATERAL(SELECT pd.id FROM processor.derivation pd WHERE c='PROCESSOR_COVERAGE' AND pd.revision_id=i.revision_id AND pd.normalizer_version=i.normalizer_version AND pd.interpreter_version='processor-v1'
    UNION ALL SELECT bd.id FROM bank.derivation bd WHERE c='BANK_COVERAGE' AND bd.revision_id=i.revision_id AND bd.normalizer_version=i.normalizer_version AND bd.interpreter_version='bank-v1') dd ON true
   WHERE rev.source_account_id=x.id AND i.state='NORMALIZED' AND ((c='PROCESSOR_COVERAGE' AND i.normalizer_version IN ('synthetic-movement-v1','synthetic-movement-v2','synthetic-settlement-v1') AND rev.fact_id IS NOT NULL) OR (c='BANK_COVERAGE' AND i.normalizer_version IN ('synthetic-bank-entry-v1','synthetic-bank-statement-v1')));
   data:=array_append(data,controls.input_data(lower(c)||':'||x.id,c,scope,NULL,e,o,'total',jsonb_build_object('interpreted',o,'normalizedEligible',e),ev));
  END LOOP;
 END LOOP;
 FOR x IN SELECT b.* FROM processor.settlement_batch b JOIN ingestion.source_account a ON a.id=b.source_account_id WHERE a.book_id=bk ORDER BY b.id LOOP
  s:=processor.evaluation_snapshot('settlement',x.id,'synthetic-movement-v1','processor-v1');scope:=jsonb_build_object('bookId',bk,'sourceAccountId',x.source_account_id,'processorSettlementId',x.id,'currency',x.currency);
  data:=array_append(data,controls.input_data('processor:'||x.id,'PROCESSOR',scope,x.currency,NULL,NULL,'checks',s->'result',s->'input'));
 data:=array_append(data,controls.input_data('processor-total:'||x.id,'PROCESSOR_TOTAL',scope,x.currency,(s->'result'->>'calculatedNetMinor')::numeric,(s->'result'->>'reportedNetMinor')::numeric,'total',s->'result',s->'input'));
 END LOOP;
 FOR x IN SELECT DISTINCT a.id AS source_account_id,m.currency FROM ingestion.source_account a JOIN reconciliation.account_mapping m ON m.bank_source_account_id=a.id WHERE a.book_id=bk AND NOT EXISTS(SELECT FROM bank.statement st WHERE st.source_account_id=a.id AND st.currency=m.currency) ORDER BY a.id,m.currency LOOP
  data:=array_append(data,controls.input_data('bank-total-unknown:'||x.source_account_id||':'||x.currency,'BANK_TOTAL',jsonb_build_object('bookId',bk,'sourceAccountId',x.source_account_id,'currency',x.currency),x.currency,NULL,NULL,'total',jsonb_build_object('reason','NO_INDEPENDENT_STATEMENT_STOCKS'),'{}'));
 END LOOP;
 FOR x IN SELECT b.* FROM bank.statement b JOIN ingestion.source_account a ON a.id=b.source_account_id WHERE a.book_id=bk ORDER BY b.id LOOP
  s:=bank.statement_snapshot(x.id,'bank-v1');scope:=jsonb_build_object('bookId',bk,'sourceAccountId',x.source_account_id,'bankStatementId',x.id,'currency',x.currency,'from',x.period_from,'to',x.period_to);
  data:=array_append(data,controls.input_data('bank:'||x.id,'BANK',scope,x.currency,NULL,NULL,'checks',s->'result',s->'input'));
 data:=array_append(data,controls.input_data('bank-total:'||x.id,'BANK_TOTAL',scope,x.currency,(s->'result'->>'calculatedClosingMinor')::numeric,(s->'result'->>'reportedClosingMinor')::numeric,'total',s->'result',s->'input'));
 data:=array_append(data,controls.input_data('bank-completeness:'||x.id,'BANK_COMPLETENESS',scope,x.currency,(s->'result'->>'expectedLineCount')::numeric,(s->'result'->>'receivedLineCount')::numeric,'coverage',s->'result',s->'input'));
 END LOOP;
 FOR x IN SELECT r.*,m.currency FROM reconciliation.run r JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE m.book_id=bk ORDER BY r.id LOOP
  FOR v_side IN SELECT unnest(ARRAY['PROCESSOR','BANK']) LOOP
   SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',rm.item_id,'snapshot',rm.snapshot,'outcome',ro.outcome,'reason',ro.reason,'groupId',ro.group_id) ORDER BY rm.item_id),'[]'),count(ro.item_id) INTO ev,o
   FROM reconciliation.run_member rm LEFT JOIN reconciliation.outcome ro ON ro.run_id=rm.run_id AND ro.item_id=rm.item_id WHERE rm.run_id=x.id AND rm.side=v_side;
   e:=(x.manifest->>CASE v_side WHEN 'PROCESSOR' THEN 'processorCount' ELSE 'bankCount' END)::numeric;
   invalid:=CASE WHEN e IS DISTINCT FROM jsonb_array_length(ev)::numeric THEN 1 ELSE 0 END;
   d:=jsonb_build_object('state',x.state,'population',jsonb_array_length(ev),'outcomes',o,'invalid',invalid,'matched',(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'outcome'='MATCHED'),'unmatched',(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'outcome'='UNMATCHED'),'ambiguous',(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'outcome'='AMBIGUOUS'),'ineligible',(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'outcome'='INELIGIBLE'),'ruleVersion',x.rule_version,'populationHash',x.manifest->>'populationHash');
   scope:=jsonb_build_object('bookId',bk,'reconciliationRunId',x.id,'mappingId',x.mapping_id,'currency',x.currency,'side',v_side,'from',x.window_from,'to',x.window_to);
   data:=array_append(data,controls.input_data('reconciliation:'||x.id||':'||v_side,'RECONCILIATION',scope,NULL,e,o,'partition',d,ev));
  END LOOP;
  IF p->'reconciliationRunIds' ? x.id::text THEN
   s:=controls.exposure(x.id); scope:=jsonb_build_object('bookId',bk,'reconciliationRunId',x.id,'mappingId',x.mapping_id,'currency',x.currency,'from',x.window_from,'to',x.window_to);
   -- Compare selected frozen run with a fresh full population, not receipt ordering.
   SELECT coalesce(jsonb_agg(to_jsonb(pop) ORDER BY pop.side,pop.identity),'[]') INTO ev FROM reconciliation.population(x.mapping_id,x.window_from,x.window_to) pop;
   invalid:=CASE WHEN x.state='COMPLETED' AND x.manifest->'population'=ev THEN 0 ELSE 1 END;
   IF invalid=1 THEN s:=s||jsonb_build_object('selectionStale',true,'knownHistoricalMinor',s->>'unreconciledMinor','unreconciledMinor',NULL,'acceptedRiskMinor',NULL,'unknownCount',greatest(1,(s->>'unknownCount')::integer)); END IF;
   data:=array_append(data,controls.input_data('exposure:'||x.id,'EXPOSURE',scope,x.currency,0,(s->>'unreconciledMinor')::numeric,'exposure',s,jsonb_build_object('selectedRun',x.id,'currentPopulation',ev)));
   data:=array_append(data,controls.input_data('freshness:'||x.id,'FRESHNESS',scope,NULL,0,invalid,'total',jsonb_build_object('selectedRunCurrent',invalid=0,'ruleVersion',x.rule_version),ev));
  END IF;
 END LOOP;
 FOR x IN SELECT * FROM reconciliation.account_mapping WHERE book_id=bk ORDER BY id LOOP
  data:=array_append(data,controls.input_data('selection:'||x.id,'RECONCILIATION',jsonb_build_object('bookId',bk,'mappingId',x.id,'currency',x.currency),NULL,NULL,NULL,'checks',jsonb_build_object('controls','[]'::jsonb,'sufficient',EXISTS(SELECT FROM reconciliation.run rr WHERE rr.mapping_id=x.id AND p->'reconciliationRunIds' ? rr.id::text),'reason','EXPLICIT_MAPPING_POPULATION_REQUIRED'),jsonb_build_object('selectedRunIds',p->'reconciliationRunIds')));
 END LOOP;
 data:=array_append(data,controls.input_data('allocation-population:'||bk,'ALLOCATION',jsonb_build_object('bookId',bk,'population','ALL_CURRENT_RESERVATIONS'),NULL,NULL,NULL,'checks',jsonb_build_object('controls',CASE WHEN EXISTS(SELECT FROM reconciliation.current_allocation ca JOIN reconciliation.item it ON it.id=ca.item_id JOIN reconciliation.match_group g ON g.id=ca.group_id JOIN reconciliation.run rr ON rr.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id=bk GROUP BY coalesce(it.source_fact_id,it.observation_revision_id),ca.relationship_scope HAVING count(*)>1) THEN '["DUPLICATE_ECONOMIC_ALLOCATION"]'::jsonb ELSE '[]'::jsonb END),
 (SELECT coalesce(jsonb_agg(to_jsonb(ca) ORDER BY ca.item_id),'[]') FROM reconciliation.current_allocation ca JOIN reconciliation.match_group g ON g.id=ca.group_id JOIN reconciliation.run rr ON rr.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id=bk)));
 SELECT coalesce(jsonb_object_agg(id,valid),'{}') INTO validity FROM reconciliation.current_valid_many(ARRAY(SELECT DISTINCT g.id FROM reconciliation.match_group g JOIN reconciliation.run r ON r.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE m.book_id=bk AND EXISTS(SELECT FROM reconciliation.current_allocation a WHERE a.group_id=g.id)));
 -- Independent whole reservation/group audit: uniqueness, roles, money, outcome links, proof freshness.
 FOR x IN SELECT g.* FROM reconciliation.match_group g JOIN reconciliation.run r ON r.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE m.book_id=bk AND EXISTS(SELECT FROM reconciliation.current_allocation a WHERE a.group_id=g.id) ORDER BY g.id LOOP
  SELECT coalesce(sum(gm.signed_amount_minor) FILTER(WHERE gm.role='PROCESSOR_SETTLEMENT'),0),coalesce(sum(gm.signed_amount_minor) FILTER(WHERE gm.role='BANK_MOVEMENT'),0),coalesce(jsonb_agg(jsonb_build_object('itemId',gm.item_id,'role',gm.role,'currency',gm.currency,'amountMinor',gm.signed_amount_minor::text,'reservedGroupId',a.group_id,'outcome',oc.outcome,'outcomeGroupId',oc.group_id) ORDER BY gm.item_id),'[]') INTO e,o,ev
  FROM reconciliation.match_group_member gm LEFT JOIN reconciliation.current_allocation a ON a.item_id=gm.item_id LEFT JOIN reconciliation.outcome oc ON oc.run_id=gm.run_id AND oc.item_id=gm.item_id WHERE gm.group_id=x.id;
  invalid:=(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'currency'<>x.currency OR z->>'reservedGroupId' IS DISTINCT FROM x.id::text OR z->>'outcomeGroupId' IS DISTINCT FROM x.id::text OR z->>'outcome' IS DISTINCT FROM 'MATCHED');
  IF (SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'role'='BANK_MOVEMENT')<>1 OR jsonb_array_length(ev)<2 OR jsonb_array_length(ev)>33 OR e<>x.signed_amount_minor OR o<>x.signed_amount_minor OR NOT (validity->>x.id::text)::boolean THEN invalid:=invalid+1; END IF;
  d:=jsonb_build_object('controls',CASE WHEN invalid=0 THEN '[]'::jsonb ELSE '["ALLOCATION_INTEGRITY_OR_FRESHNESS_FAILED"]'::jsonb END,'processorMinor',e::text,'bankMinor',o::text,'groupMinor',x.signed_amount_minor::text,'invalid',invalid);
  data:=array_append(data,controls.input_data('allocation:'||x.id,'ALLOCATION',jsonb_build_object('bookId',bk,'matchGroupId',x.id,'reconciliationRunId',x.run_id),x.currency,e,o,'checks',d,jsonb_build_object('members',ev,'proof',x.evidence)));
 END LOOP;
 FOR x IN SELECT * FROM ledger.ledger_transaction WHERE book_id=bk ORDER BY id LOOP
  SELECT coalesce(sum(amount_minor) FILTER(WHERE side='debit'),0),coalesce(sum(amount_minor) FILTER(WHERE side='credit'),0),count(*),coalesce(jsonb_agg(jsonb_build_object('entryId',id,'accountId',account_id,'amountMinor',amount_minor::text,'currency',currency,'side',side) ORDER BY line_number),'[]') INTO e,o,n,ev FROM ledger.ledger_entry WHERE journal_id=x.id;
  invalid:=CASE WHEN n BETWEEN 2 AND 1000 AND e=o AND x.state='posted' AND NOT EXISTS(SELECT FROM ledger.ledger_entry WHERE journal_id=x.id AND (currency<>x.currency OR book_id<>bk)) THEN 0 ELSE 1 END;
  data:=array_append(data,controls.input_data('ledger:'||x.id,'LEDGER',jsonb_build_object('bookId',bk,'journalId',x.id),x.currency,e,o,'checks',jsonb_build_object('entryCount',n,'controls',CASE WHEN invalid=0 THEN '[]'::jsonb ELSE '["JOURNAL_INTEGRITY_FAILED"]'::jsonb END),ev));
 END LOOP;
 SELECT ARRAY(SELECT item_id FROM reconciliation.active_items(ARRAY(SELECT c.item_id FROM exceptions.current_case c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=bk))) INTO active_cases;
 -- Aging is an explicit deterministic cutoff policy, not a worker or silent closure.
 SELECT coalesce(jsonb_agg(jsonb_build_object('caseId',c.id,'eventId',c.event_id,'createdAt',c.created_at,'resolution',c.resolution) ORDER BY c.id),'[]'),floor(extract(epoch FROM at_time-min(c.created_at))) INTO ev,o
 FROM exceptions.current_case c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=bk AND NOT c.item_id=ANY(active_cases);
 data:=array_append(data,controls.input_data('aging:'||bk,'FRESHNESS',jsonb_build_object('bookId',bk,'population','UNRECONCILED_CASES','asOf',at_time),NULL,(p->>'maxAgeSeconds')::numeric,o,'age',jsonb_build_object('oldestUnresolvedAgeSeconds',o::text),ev));
 IF cardinality(data)>20000 THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='Control result bound exceeded'; END IF;
 data:=array_append(data,controls.input_data('ledger-population:'||bk,'LEDGER',jsonb_build_object('bookId',bk,'population','ALL_POSTED_JOURNALS'),NULL,NULL,NULL,'checks',jsonb_build_object('controls','[]'::jsonb,'journalCount',(SELECT count(*) FROM ledger.ledger_transaction WHERE book_id=bk)),(SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM ledger.ledger_transaction WHERE book_id=bk)));
 RETURN (SELECT jsonb_agg(z ORDER BY z->>'key') FROM unnest(data) z);
END $$;
CREATE OR REPLACE FUNCTION reconciliation.summary_v6(rid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('id',r.id,'state',r.state,'processorPopulation',coalesce((r.manifest->>'processorCount')::integer,0),'bankPopulation',coalesce((r.manifest->>'bankCount')::integer,0),
 'candidateCount',(SELECT count(*) FROM reconciliation.candidate WHERE run_id=rid),'matchedGroups',(SELECT count(*) FROM reconciliation.match_group WHERE run_id=rid),
 'outcomes',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.side,x.outcome) FROM (SELECT m.side,o.outcome,count(*)::integer AS count FROM reconciliation.outcome o JOIN reconciliation.run_member m USING(run_id,item_id) WHERE o.run_id=rid GROUP BY m.side,o.outcome) x),'[]'),
 'values',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.currency,x.side,x.outcome) FROM (SELECT m.snapshot->>'currency' AS currency,m.side,o.outcome,sum((m.snapshot->>'amountMinor')::numeric)::text AS "amountMinor" FROM reconciliation.outcome o JOIN reconciliation.run_member m USING(run_id,item_id) WHERE o.run_id=rid AND m.snapshot->>'amountMinor' IS NOT NULL GROUP BY m.snapshot->>'currency',m.side,o.outcome) x),'[]'),
 'current',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.status) FROM (SELECT status,count(*)::integer AS count FROM reconciliation.current_groups(rid) GROUP BY status) x),'[]'),
 'sourceCoverage','UNKNOWN','unknownValueCount',(SELECT count(*) FROM reconciliation.run_member WHERE run_id=rid AND snapshot->>'amountMinor' IS NULL),'populationHash',r.manifest->'populationHash') FROM reconciliation.run r WHERE r.id=rid
$$;
CREATE OR REPLACE FUNCTION operations.read_v1(bk uuid, kind text, opt jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE data jsonb; rows jsonb; summary jsonb; swept jsonb; cr controls.run%ROWTYPE; rr reconciliation.run%ROWTYPE;
 lim integer:=coalesce((opt->>'limit')::integer,50); cid uuid:=(opt->>'id')::uuid; ev uuid:=(opt->>'evaluation')::uuid;
 after_id uuid:=coalesce((opt->'cursor'->>'id')::uuid,'00000000-0000-0000-0000-000000000000');
 after_time timestamptz:=coalesce((opt->'cursor'->>'time')::timestamptz,'-infinity');
 after_key text:=coalesce(opt->'cursor'->>'key',''); selected uuid[]:='{}'; validity jsonb; active uuid[];
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
  SELECT coalesce(jsonb_object_agg(id,valid),'{}') INTO validity FROM reconciliation.current_valid_many(ARRAY(SELECT id FROM reconciliation.match_group WHERE run_id=rr.id));
  SELECT ARRAY(SELECT item_id FROM reconciliation.active_items(ARRAY(SELECT item_id FROM reconciliation.run_member WHERE run_id=rr.id))) INTO active;
  data:=jsonb_build_object('id',rr.id,'mappingId',rr.mapping_id,'ruleVersion',rr.rule_version,'state',rr.state,'windowFrom',rr.window_from,'windowTo',rr.window_to,'frozenAt',rr.sealed_at,'completedAt',rr.completed_at,'summary',reconciliation.summary(rr.id),'currency',(SELECT currency FROM reconciliation.account_mapping WHERE id=rr.mapping_id));
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]') INTO rows FROM(
   SELECT m.item_id AS id,m.side,m.processor_batch_id AS "processorEvidenceId",m.bank_entry_id AS "bankEvidenceId",(m.snapshot-'history'-'groupVariants')||jsonb_build_object('history',(SELECT coalesce(jsonb_agg(value),'[]') FROM(SELECT value FROM jsonb_array_elements(coalesce(m.snapshot->'history','[]')) WITH ORDINALITY ORDER BY ordinality LIMIT 50) h),'historyCount',jsonb_array_length(coalesce(m.snapshot->'history','[]')),'groupVariants',(SELECT coalesce(jsonb_agg(value),'[]') FROM(SELECT value FROM jsonb_array_elements(coalesce(m.snapshot->'groupVariants','[]')) WITH ORDINALITY ORDER BY ordinality LIMIT 50) h),'groupVariantCount',jsonb_array_length(coalesce(m.snapshot->'groupVariants','[]'))) AS snapshot,exceptions.cause_with_current(m.run_id,m.item_id,active) AS cause,o.outcome AS outcome,o.reason,o.group_id AS "groupId",
    (SELECT jsonb_build_object('id',g.id,'shape',g.shape,'amountMinor',g.signed_amount_minor::text,'currency',g.currency,'current',(validity->>g.id::text)::boolean,'proof',g.evidence-'processorSnapshot'-'processorSnapshots'-'bankSnapshot','frozenDifferenceMinor',((g.evidence->'bankSnapshot'->>'amountMinor')::numeric-(g.evidence->>'signedAmountMinor')::numeric)::text,'members',(SELECT jsonb_agg(jsonb_build_object('itemId',gm.item_id,'role',gm.role,'amountMinor',gm.signed_amount_minor::text) ORDER BY gm.item_id) FROM reconciliation.match_group_member gm WHERE gm.group_id=g.id)) FROM reconciliation.match_group g WHERE g.id=o.group_id) AS allocation,
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

REVOKE ALL ON FUNCTION reconciliation.current_valid_many(uuid[]),reconciliation.current_groups(uuid),reconciliation.active_items(uuid[]),exceptions.cause_with_current(uuid,uuid,uuid[]) FROM PUBLIC;
-- Four correlated revision scans become one scoped aggregate, with identical ambiguity semantics.
CREATE OR REPLACE VIEW ingestion.fact_status AS
 SELECT f.*,(SELECT r.revision_id FROM ingestion.raw_record r JOIN ingestion.revision v ON v.id=r.revision_id WHERE v.fact_id=f.id ORDER BY r.receipt_order DESC LIMIT 1) AS latest_received_revision_id,
 CASE WHEN revisions.n=1 THEN revisions.only_id ELSE NULL END AS active_revision_id,
 CASE WHEN revisions.n>1 THEN 'REVIEW_REQUIRED' ELSE 'UNAMBIGUOUS' END AS revision_state,
 revisions.tokens>revisions.distinct_tokens AS conflicting_source_token
 FROM ingestion.source_fact f CROSS JOIN LATERAL (
  SELECT count(*) AS n,min(v.id::text)::uuid AS only_id,count(source_revision) AS tokens,count(DISTINCT source_revision) AS distinct_tokens
  FROM ingestion.revision v WHERE v.fact_id=f.id
 ) revisions;
CREATE OR REPLACE FUNCTION processor.settlement_snapshot(bid uuid,nv text,iv text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE b processor.settlement_batch%ROWTYPE; controls text[]:='{}'; inputs jsonb; item record; net numeric:=0; complete boolean:=true; p jsonb; counted uuid[]:='{}'; payments jsonb:='{}';
BEGIN
 SELECT * INTO STRICT b FROM processor.settlement_batch WHERE id=bid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal',m.ordinal,'reference',m.external_activity_id,'factId',f.id,'revisionState',f.revision_state,'activeRevisionId',f.active_revision_id,
 'activityId',a.id,'paymentId',a.payment_id,'currency',a.currency,'amountMinor',a.contribution_minor::text,'signControl',a.sign_control,
 'conflictingBatchIds',coalesce((SELECT jsonb_agg(other.id ORDER BY other.id) FROM processor.settlement_batch other JOIN processor.derivation od ON od.id=other.id
 WHERE other.source_account_id=b.source_account_id AND other.fact_id<>b.fact_id AND od.interpreter_version=iv AND EXISTS(SELECT FROM processor.membership om WHERE om.batch_id=other.id AND om.external_activity_id=m.external_activity_id) AND other.component_kind=b.component_kind),'[]')) ORDER BY m.ordinal),'[]') INTO inputs
 FROM processor.membership m
 LEFT JOIN ingestion.fact_status f ON f.source_account_id=b.source_account_id AND f.object_kind=b.component_kind AND f.external_id=m.external_activity_id
 LEFT JOIN processor.derivation d ON d.fact_id=f.id AND d.revision_id=f.active_revision_id AND d.normalizer_version=nv AND d.interpreter_version=iv
 LEFT JOIN processor.activity a ON a.id=d.id WHERE m.batch_id=bid;
 IF (SELECT revision_state FROM ingestion.fact_status WHERE id=b.fact_id)<>'UNAMBIGUOUS' THEN controls:=array_append(controls,'AMBIGUOUS_SETTLEMENT'); END IF;
 IF EXISTS(SELECT FROM processor.membership WHERE batch_id=bid GROUP BY external_activity_id HAVING count(*)>1) THEN controls:=array_append(controls,'DUPLICATE_MEMBERSHIP'); complete:=false; END IF;
 FOR item IN SELECT * FROM jsonb_to_recordset(inputs) AS x("activityId" uuid,"paymentId" uuid,"factId" uuid,"revisionState" text,currency text,"amountMinor" text,"signControl" text,"conflictingBatchIds" jsonb) LOOP
  IF item."factId" IS NULL THEN controls:=array_append(controls,'MISSING_ACTIVITY'); complete:=false;
  ELSIF item."revisionState"<>'UNAMBIGUOUS' THEN controls:=array_append(controls,'AMBIGUOUS_ACTIVITY'); complete:=false;
  ELSIF item."activityId" IS NULL THEN controls:=array_append(controls,'PENDING_ACTIVITY'); complete:=false;
  ELSIF item.currency<>b.currency THEN controls:=array_append(controls,'CROSS_CURRENCY_MEMBERSHIP'); complete:=false;
  ELSIF item."signControl" IS NOT NULL THEN controls:=array_append(controls,'INVALID_SIGN'); complete:=false;
  ELSE
   IF NOT item."activityId"=ANY(counted) THEN net:=net+item."amountMinor"::numeric; counted:=array_append(counted,item."activityId"); END IF;
   -- Identical STABLE payment reads are reused only inside this function invocation.
   IF NOT payments ? item."paymentId"::text THEN
    payments:=jsonb_set(payments,ARRAY[item."paymentId"::text],processor.payment_snapshot(item."paymentId",nv,iv));
   END IF;
   p:=payments->item."paymentId"::text;
   IF jsonb_array_length(p->'result'->'controls')>0 THEN controls:=array_append(controls,'PAYMENT_CONTROL_FAILED'); END IF;
  END IF;
  IF jsonb_array_length(item."conflictingBatchIds")>0 THEN controls:=array_append(controls,'CONFLICTING_MEMBERSHIP'); END IF;
 END LOOP;
 IF complete AND net<>b.reported_net_minor THEN controls:=array_append(controls,'NET_MISMATCH'); END IF;
 SELECT coalesce(array_agg(DISTINCT c ORDER BY c),'{}') INTO controls FROM unnest(controls) c;
 -- knownComponentNet is only a diagnostic subtotal; it is never an expected full net.
 RETURN jsonb_build_object('input',jsonb_build_object('members',inputs,'batchId',bid),'result',jsonb_build_object('controls',to_jsonb(controls),
 'currency',b.currency,'membershipCount',b.declared_count,'reportedNetMinor',b.reported_net_minor::text,'calculatedNetMinor',CASE WHEN complete THEN net::text ELSE NULL END,'knownComponentNetMinor',net::text));
END $$;
RESET ROLE;
