-- Phase 9 only: immutable, versioned, independently scoped control evaluations.
RESET ROLE;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['flow_control_reader','flow_control_writer'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r); END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe control role'; END IF;
 END LOOP;
END $$;
GRANT flow_control_reader TO flow_control_writer;
CREATE SCHEMA controls AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA controls FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
CREATE TABLE controls.version(version text PRIMARY KEY,contract text NOT NULL);
INSERT INTO controls.version VALUES('financial-controls-v1','Received-book snapshot; independent acquisition and source-local totals; exact whole population accounting; explicitly selected mapping runs; canonical once-per-condition exposure; unknown period closure');
CREATE TABLE controls.run(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), book_id uuid NOT NULL REFERENCES ledger.book ON DELETE RESTRICT,
 run_key text NOT NULL CHECK(length(run_key) BETWEEN 1 AND 512), version text NOT NULL REFERENCES controls.version ON DELETE RESTRICT,
 command jsonb NOT NULL, actor_id text NOT NULL CHECK(length(btrim(actor_id)) BETWEEN 1 AND 512),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','SEALED','EVALUATING','COMPLETED')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), frozen_at timestamptz, completed_at timestamptz,
 seal_transaction xid8, manifest jsonb, input_hash text,
 UNIQUE(book_id,run_key), CHECK((state='DRAFT')=(manifest IS NULL)), CHECK((state='DRAFT')=(frozen_at IS NULL)),
 CHECK((state='DRAFT')=(seal_transaction IS NULL)), CHECK((state='COMPLETED')=(completed_at IS NOT NULL)),
 CHECK(input_hash IS NOT DISTINCT FROM encode(sha256(convert_to(manifest::text,'UTF8')),'hex'))
);
CREATE TABLE controls.input(
 run_id uuid NOT NULL REFERENCES controls.run ON DELETE RESTRICT, key text NOT NULL, payload jsonb NOT NULL,
 source_account_id uuid REFERENCES ingestion.source_account ON DELETE RESTRICT,
 batch_id uuid REFERENCES ingestion.batch ON DELETE RESTRICT,
 processor_settlement_id uuid REFERENCES processor.settlement_batch ON DELETE RESTRICT,
 bank_statement_id uuid REFERENCES bank.statement ON DELETE RESTRICT,
 reconciliation_run_id uuid REFERENCES reconciliation.run ON DELETE RESTRICT,
 match_group_id uuid REFERENCES reconciliation.match_group ON DELETE RESTRICT,
 journal_id uuid REFERENCES ledger.ledger_transaction ON DELETE RESTRICT,
 currency text REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 PRIMARY KEY(run_id,key), CHECK(payload->>'key'=key), CHECK(currency IS NOT DISTINCT FROM payload->>'currency')
);
CREATE TABLE controls.result(
 run_id uuid NOT NULL,key text NOT NULL, result jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('PASS','FAIL','UNKNOWN')),
 severity text NOT NULL CHECK(severity IN ('WARNING','ERROR','CRITICAL')),
 currency text REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 expected numeric, observed numeric, discrepancy numeric,
 evaluated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(run_id,key), FOREIGN KEY(run_id,key) REFERENCES controls.input ON DELETE RESTRICT,
 CHECK(expected IS NULL OR expected::text ~ '^-?[0-9]+$'),CHECK(observed IS NULL OR observed::text ~ '^-?[0-9]+$'),
 CHECK(discrepancy IS NOT DISTINCT FROM observed-expected), CHECK(currency IS NOT DISTINCT FROM result->>'currency'),
 CHECK(status=result->>'status' AND severity=result->>'severity')
);
CREATE TABLE controls.case_link(
 run_id uuid NOT NULL,key text NOT NULL,case_id uuid NOT NULL REFERENCES exceptions.case_record ON DELETE RESTRICT,
 PRIMARY KEY(run_id,key,case_id),FOREIGN KEY(run_id,key) REFERENCES controls.result ON DELETE RESTRICT
);
-- Pure result semantics. No missing evidence may become PASS.
CREATE FUNCTION controls.evaluate_input(p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE s text; e numeric:=(p->>'expected')::numeric; o numeric:=(p->>'observed')::numeric; d jsonb:=p->'details';
BEGIN
 s:=CASE p->>'mode'
 WHEN 'coverage' THEN CASE d->>'completeness' WHEN 'PROVEN_COMPLETE' THEN 'PASS' WHEN 'PROVEN_INCOMPLETE' THEN 'FAIL' ELSE 'UNKNOWN' END
 WHEN 'checks' THEN CASE WHEN jsonb_array_length(d->'controls')>0 THEN 'FAIL' WHEN coalesce((d->>'sufficient')::boolean,true) THEN 'PASS' ELSE 'UNKNOWN' END
 WHEN 'partition' THEN CASE WHEN d->>'state' IS NOT NULL AND d->>'state'<>'COMPLETED' THEN 'UNKNOWN' WHEN e IS NULL OR o IS NULL THEN 'UNKNOWN' WHEN e=o AND coalesce((d->>'invalid')::integer,0)=0 THEN 'PASS' ELSE 'FAIL' END
 WHEN 'completion' THEN CASE WHEN (d->>'failed')::bigint>0 THEN 'FAIL' WHEN (d->>'pending')::bigint>0 OR (d->>'missing')::bigint>0 THEN 'UNKNOWN' ELSE 'PASS' END
 WHEN 'age' THEN CASE WHEN o IS NULL THEN 'UNKNOWN' WHEN o>e THEN 'FAIL' ELSE 'PASS' END
 WHEN 'exposure' THEN CASE WHEN o>0 OR ((d->>'knownUnreconciledMinor')::numeric>0 AND NOT EXISTS(SELECT FROM jsonb_array_elements(d->'components') z WHERE z->>'identity'='unproven-cross-side-overlap') AND NOT coalesce((d->>'selectionStale')::boolean,false)) THEN 'FAIL' WHEN (d->>'unknownCount')::bigint>0 THEN 'UNKNOWN' ELSE 'PASS' END
 ELSE CASE WHEN e IS NULL OR o IS NULL THEN 'UNKNOWN' WHEN e=o THEN 'PASS' ELSE 'FAIL' END END;
 RETURN jsonb_build_object('key',p->>'key','type',p->>'type','scope',p->'scope','status',s,
 'unit',CASE WHEN p->>'mode'='age' THEN 'SECONDS' WHEN p->>'type' IN ('PROCESSOR_TOTAL','BANK_TOTAL','EXPOSURE') OR (p->>'type' IN ('LEDGER','ALLOCATION') AND p->>'currency' IS NOT NULL) THEN 'MINOR_UNITS' WHEN p->>'type' IN ('SOURCE','PROCESSING_PARTITION','PROCESSING_COMPLETION','PROCESSOR_COVERAGE','BANK_COVERAGE','RECONCILIATION','BANK_COMPLETENESS') THEN 'COUNT' ELSE 'ASSERTION' END,
 'severity',CASE WHEN p->>'type' IN ('LEDGER','ALLOCATION') THEN 'CRITICAL' WHEN p->>'type' IN ('SOURCE_PERIOD','FRESHNESS') THEN 'WARNING' ELSE 'ERROR' END,
 'currency',p->>'currency','expected',e::text,'observed',o::text,'discrepancy',(o-e)::text,'details',d,'evidence',p->'evidence');
END $$;
CREATE FUNCTION controls.input_data(k text,t text,scope jsonb,c text,e numeric,o numeric,mode text,d jsonb,ev jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('key',k,'type',t,'scope',scope,'currency',c,'expected',e::text,'observed',o::text,'mode',mode,'details',d,'evidence',ev)
$$;
-- Canonical exposure comes from one explicitly selected run per mapping, never summed historical runs/cases.
-- Exact pair residuals deduplicate both sides; other unresolved items have one stable identity each.
CREATE FUNCTION controls.exposure(rid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; row record; cause jsonb; k text; items uuid[]; components jsonb:='[]'; seen text[]:='{}'; amount numeric; risk boolean; events jsonb;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid;
 IF r.state<>'COMPLETED' THEN RETURN jsonb_build_object('components','[]'::jsonb,'unreconciledMinor','0','acceptedRiskMinor','0','unknownCount',1,'state',r.state); END IF;
 FOR row IN SELECT * FROM reconciliation.run_member WHERE run_id=rid ORDER BY item_id LOOP
  IF EXISTS(SELECT FROM reconciliation.active_allocation WHERE item_id=row.item_id) THEN CONTINUE; END IF;
  cause:=exceptions.cause(rid,row.item_id); IF cause IS NULL THEN CONTINUE; END IF;
  items:=ARRAY[row.item_id]; k:='item:'||row.item_id;
  IF cause->>'classification'='AMOUNT_MISMATCH' THEN
   items:=ARRAY[(cause->'condition'->'candidates'->0->>'processor_item_id')::uuid,(cause->'condition'->'candidates'->0->>'bank_item_id')::uuid];
   -- A counterpart allocated by a different valid run invalidates this old residual's interpretation.
   IF EXISTS(SELECT FROM reconciliation.active_allocation WHERE item_id=ANY(items)) THEN
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
-- One MVCC snapshot, reused source-owned calculation semantics. No oracle or mutable latest guesses.
CREATE FUNCTION controls.snapshot(p jsonb,at_time timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE bk uuid:=(p->>'bookId')::uuid; data jsonb:='[]'; x record; y record; s jsonb; scope jsonb; ev jsonb; d jsonb; e numeric; o numeric; n bigint; pending bigint; failed bigint; missing bigint; invalid integer; c text; v_side text;
BEGIN
 IF (SELECT count(*) FROM ingestion.raw_record rr JOIN ingestion.source_account a ON a.id=rr.source_account_id WHERE a.book_id=bk)>100000 THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='Control population bound exceeded'; END IF;
 IF NOT EXISTS(SELECT FROM ingestion.source_account WHERE book_id=bk) THEN
  data:=data||jsonb_build_array(controls.input_data('source-period:book:'||bk,'SOURCE_PERIOD',jsonb_build_object('bookId',bk,'population','ALL_RECEIVED_AS_OF_FREEZE'),NULL,NULL,NULL,'total',jsonb_build_object('reason','NO_CONFIGURED_SOURCE_SCOPE_OR_INDEPENDENT_PERIOD_CLOSURE'),'{}'));
 END IF;
 FOR x IN SELECT a.*,src.provider,src.environment FROM ingestion.source_account a JOIN ingestion.source src ON src.id=a.source_id WHERE a.book_id=bk ORDER BY a.id LOOP
  scope:=jsonb_build_object('bookId',bk,'sourceAccountId',x.id,'environment',x.environment,'provider',x.provider,'population','ALL_RECEIVED_AS_OF_FREEZE');
  data:=data||jsonb_build_array(controls.input_data('source-period:'||x.id,'SOURCE_PERIOD',scope,NULL,NULL,NULL,'total',jsonb_build_object('reason','NO_INDEPENDENT_PERIOD_CLOSURE'),'{}'));
  FOR y IN SELECT * FROM ingestion.batch WHERE source_account_id=x.id ORDER BY id LOOP
   SELECT count(*),coalesce(jsonb_agg(jsonb_build_object('rawId',id,'revisionId',revision_id,'sequence',source_sequence,'checksum',checksum) ORDER BY id),'[]') INTO n,ev FROM ingestion.raw_record WHERE batch_id=y.id;
   d:=jsonb_build_object('completeness',ingestion.coverage(y.id),'expectedCount',y.expected_count,'sequenceFrom',y.sequence_from,'sequenceTo',y.sequence_to,'importedCount',y.imported_count,'received',n,'manifestChecksum',y.manifest_checksum,'artifactChecksum',y.artifact_checksum);
   data:=data||jsonb_build_array(controls.input_data('source:'||y.id,'SOURCE',scope||jsonb_build_object('batchId',y.id),NULL,coalesce(y.expected_count,y.sequence_to::bigint-y.sequence_from+1),n,'coverage',d,ev));
   FOR c IN SELECT normalizer_version FROM ingestion.normalization_request WHERE batch_id=y.id ORDER BY normalizer_version LOOP
    SELECT count(*) FILTER(WHERE pr.state='PENDING'),count(*) FILTER(WHERE pr.state='FAILED'),count(*) FILTER(WHERE pr.state='NORMALIZED'),count(*) FILTER(WHERE pr.raw_id IS NULL),coalesce(jsonb_agg(jsonb_build_object('rawId',rr.id,'revisionId',rr.revision_id,'state',pr.state,'interpretation',i.result,'completedAt',pr.completed_at) ORDER BY rr.id),'[]')
    INTO pending,failed,o,missing,ev FROM ingestion.raw_record rr LEFT JOIN ingestion.processing pr ON pr.raw_id=rr.id AND pr.normalizer_version=c LEFT JOIN ingestion.interpretation i ON i.revision_id=rr.revision_id AND i.normalizer_version=c WHERE rr.batch_id=y.id;
    d:=jsonb_build_object('received',n,'normalized',o,'failed',failed,'pending',pending,'missing',missing,'normalizerVersion',c);
    data:=data||jsonb_build_array(controls.input_data('partition:'||y.id||':'||c,'PROCESSING_PARTITION',scope||jsonb_build_object('batchId',y.id,'normalizerVersion',c),NULL,n,o+pending+failed,'partition',d,ev),
    controls.input_data('processing:'||y.id||':'||c,'PROCESSING_COMPLETION',scope||jsonb_build_object('batchId',y.id,'normalizerVersion',c),NULL,n,o,'completion',d,ev));
   END LOOP;
  END LOOP;
  -- Every successfully normalized supported interpretation must have its pinned domain derivation.
  FOR c IN SELECT unnest(ARRAY['PROCESSOR_COVERAGE','BANK_COVERAGE']) LOOP
   SELECT count(*),count(dd.id),coalesce(jsonb_agg(jsonb_build_object('revisionId',i.revision_id,'normalizerVersion',i.normalizer_version,'derivationId',dd.id) ORDER BY i.revision_id,i.normalizer_version),'[]') INTO e,o,ev
   FROM ingestion.interpretation i JOIN ingestion.revision rev ON rev.id=i.revision_id
   LEFT JOIN LATERAL(SELECT pd.id FROM processor.derivation pd WHERE c='PROCESSOR_COVERAGE' AND pd.revision_id=i.revision_id AND pd.normalizer_version=i.normalizer_version AND pd.interpreter_version='processor-v1'
    UNION ALL SELECT bd.id FROM bank.derivation bd WHERE c='BANK_COVERAGE' AND bd.revision_id=i.revision_id AND bd.normalizer_version=i.normalizer_version AND bd.interpreter_version='bank-v1') dd ON true
   WHERE rev.source_account_id=x.id AND i.state='NORMALIZED' AND ((c='PROCESSOR_COVERAGE' AND i.normalizer_version IN ('synthetic-movement-v1','synthetic-movement-v2','synthetic-settlement-v1') AND rev.fact_id IS NOT NULL) OR (c='BANK_COVERAGE' AND i.normalizer_version IN ('synthetic-bank-entry-v1','synthetic-bank-statement-v1')));
   data:=data||jsonb_build_array(controls.input_data(lower(c)||':'||x.id,c,scope,NULL,e,o,'total',jsonb_build_object('interpreted',o,'normalizedEligible',e),ev));
  END LOOP;
 END LOOP;
 FOR x IN SELECT b.* FROM processor.settlement_batch b JOIN ingestion.source_account a ON a.id=b.source_account_id WHERE a.book_id=bk ORDER BY b.id LOOP
  s:=processor.evaluation_snapshot('settlement',x.id,'synthetic-movement-v1','processor-v1');scope:=jsonb_build_object('bookId',bk,'sourceAccountId',x.source_account_id,'processorSettlementId',x.id,'currency',x.currency);
  data:=data||jsonb_build_array(controls.input_data('processor:'||x.id,'PROCESSOR',scope,x.currency,NULL,NULL,'checks',s->'result',s->'input'),
  controls.input_data('processor-total:'||x.id,'PROCESSOR_TOTAL',scope,x.currency,(s->'result'->>'calculatedNetMinor')::numeric,(s->'result'->>'reportedNetMinor')::numeric,'total',s->'result',s->'input'));
 END LOOP;
 FOR x IN SELECT DISTINCT a.id AS source_account_id,m.currency FROM ingestion.source_account a JOIN reconciliation.account_mapping m ON m.bank_source_account_id=a.id WHERE a.book_id=bk AND NOT EXISTS(SELECT FROM bank.statement st WHERE st.source_account_id=a.id AND st.currency=m.currency) ORDER BY a.id,m.currency LOOP
  data:=data||jsonb_build_array(controls.input_data('bank-total-unknown:'||x.source_account_id||':'||x.currency,'BANK_TOTAL',jsonb_build_object('bookId',bk,'sourceAccountId',x.source_account_id,'currency',x.currency),x.currency,NULL,NULL,'total',jsonb_build_object('reason','NO_INDEPENDENT_STATEMENT_STOCKS'),'{}'));
 END LOOP;
 FOR x IN SELECT b.* FROM bank.statement b JOIN ingestion.source_account a ON a.id=b.source_account_id WHERE a.book_id=bk ORDER BY b.id LOOP
  s:=bank.statement_snapshot(x.id,'bank-v1');scope:=jsonb_build_object('bookId',bk,'sourceAccountId',x.source_account_id,'bankStatementId',x.id,'currency',x.currency,'from',x.period_from,'to',x.period_to);
  data:=data||jsonb_build_array(controls.input_data('bank:'||x.id,'BANK',scope,x.currency,NULL,NULL,'checks',s->'result',s->'input'),
  controls.input_data('bank-total:'||x.id,'BANK_TOTAL',scope,x.currency,(s->'result'->>'calculatedClosingMinor')::numeric,(s->'result'->>'reportedClosingMinor')::numeric,'total',s->'result',s->'input'),
  controls.input_data('bank-completeness:'||x.id,'BANK_COMPLETENESS',scope,x.currency,(s->'result'->>'expectedLineCount')::numeric,(s->'result'->>'receivedLineCount')::numeric,'coverage',s->'result',s->'input'));
 END LOOP;
 FOR x IN SELECT r.*,m.currency FROM reconciliation.run r JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE m.book_id=bk ORDER BY r.id LOOP
  FOR v_side IN SELECT unnest(ARRAY['PROCESSOR','BANK']) LOOP
   SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',rm.item_id,'snapshot',rm.snapshot,'outcome',ro.outcome,'reason',ro.reason,'groupId',ro.group_id) ORDER BY rm.item_id),'[]'),count(ro.item_id) INTO ev,o
   FROM reconciliation.run_member rm LEFT JOIN reconciliation.outcome ro ON ro.run_id=rm.run_id AND ro.item_id=rm.item_id WHERE rm.run_id=x.id AND rm.side=v_side;
   e:=(x.manifest->>CASE v_side WHEN 'PROCESSOR' THEN 'processorCount' ELSE 'bankCount' END)::numeric;
   invalid:=CASE WHEN e IS DISTINCT FROM jsonb_array_length(ev)::numeric THEN 1 ELSE 0 END;
   d:=jsonb_build_object('state',x.state,'population',jsonb_array_length(ev),'outcomes',o,'invalid',invalid,'matched',(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'outcome'='MATCHED'),'unmatched',(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'outcome'='UNMATCHED'),'ambiguous',(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'outcome'='AMBIGUOUS'),'ineligible',(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'outcome'='INELIGIBLE'),'ruleVersion',x.rule_version,'populationHash',x.manifest->>'populationHash');
   scope:=jsonb_build_object('bookId',bk,'reconciliationRunId',x.id,'mappingId',x.mapping_id,'currency',x.currency,'side',v_side,'from',x.window_from,'to',x.window_to);
   data:=data||jsonb_build_array(controls.input_data('reconciliation:'||x.id||':'||v_side,'RECONCILIATION',scope,NULL,e,o,'partition',d,ev));
  END LOOP;
  IF p->'reconciliationRunIds' ? x.id::text THEN
   s:=controls.exposure(x.id); scope:=jsonb_build_object('bookId',bk,'reconciliationRunId',x.id,'mappingId',x.mapping_id,'currency',x.currency,'from',x.window_from,'to',x.window_to);
   -- Compare selected frozen run with a fresh full population, not receipt ordering.
   SELECT coalesce(jsonb_agg(to_jsonb(pop) ORDER BY pop.side,pop.identity),'[]') INTO ev FROM reconciliation.population(x.mapping_id,x.window_from,x.window_to) pop;
   invalid:=CASE WHEN x.state='COMPLETED' AND x.manifest->'population'=ev THEN 0 ELSE 1 END;
   IF invalid=1 THEN s:=s||jsonb_build_object('selectionStale',true,'knownHistoricalMinor',s->>'unreconciledMinor','unreconciledMinor',NULL,'acceptedRiskMinor',NULL,'unknownCount',greatest(1,(s->>'unknownCount')::integer)); END IF;
   data:=data||jsonb_build_array(controls.input_data('exposure:'||x.id,'EXPOSURE',scope,x.currency,0,(s->>'unreconciledMinor')::numeric,'exposure',s,jsonb_build_object('selectedRun',x.id,'currentPopulation',ev)));
   data:=data||jsonb_build_array(controls.input_data('freshness:'||x.id,'FRESHNESS',scope,NULL,0,invalid,'total',jsonb_build_object('selectedRunCurrent',invalid=0,'ruleVersion',x.rule_version),ev));
  END IF;
 END LOOP;
 FOR x IN SELECT * FROM reconciliation.account_mapping WHERE book_id=bk ORDER BY id LOOP
  data:=data||jsonb_build_array(controls.input_data('selection:'||x.id,'RECONCILIATION',jsonb_build_object('bookId',bk,'mappingId',x.id,'currency',x.currency),NULL,NULL,NULL,'checks',jsonb_build_object('controls','[]'::jsonb,'sufficient',EXISTS(SELECT FROM reconciliation.run rr WHERE rr.mapping_id=x.id AND p->'reconciliationRunIds' ? rr.id::text),'reason','EXPLICIT_MAPPING_POPULATION_REQUIRED'),jsonb_build_object('selectedRunIds',p->'reconciliationRunIds')));
 END LOOP;
 data:=data||jsonb_build_array(controls.input_data('allocation-population:'||bk,'ALLOCATION',jsonb_build_object('bookId',bk,'population','ALL_CURRENT_RESERVATIONS'),NULL,NULL,NULL,'checks',jsonb_build_object('controls',CASE WHEN EXISTS(SELECT FROM reconciliation.current_allocation ca JOIN reconciliation.item it ON it.id=ca.item_id JOIN reconciliation.match_group g ON g.id=ca.group_id JOIN reconciliation.run rr ON rr.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id=bk GROUP BY coalesce(it.source_fact_id,it.observation_revision_id),ca.relationship_scope HAVING count(*)>1) THEN '["DUPLICATE_ECONOMIC_ALLOCATION"]'::jsonb ELSE '[]'::jsonb END),
 (SELECT coalesce(jsonb_agg(to_jsonb(ca) ORDER BY ca.item_id),'[]') FROM reconciliation.current_allocation ca JOIN reconciliation.match_group g ON g.id=ca.group_id JOIN reconciliation.run rr ON rr.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id=bk)));
 -- Independent whole reservation/group audit: uniqueness, roles, money, outcome links, proof freshness.
 FOR x IN SELECT g.* FROM reconciliation.match_group g JOIN reconciliation.run r ON r.id=g.run_id JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE m.book_id=bk AND EXISTS(SELECT FROM reconciliation.current_allocation a WHERE a.group_id=g.id) ORDER BY g.id LOOP
  SELECT coalesce(sum(gm.signed_amount_minor) FILTER(WHERE gm.role='PROCESSOR_SETTLEMENT'),0),coalesce(sum(gm.signed_amount_minor) FILTER(WHERE gm.role='BANK_MOVEMENT'),0),coalesce(jsonb_agg(jsonb_build_object('itemId',gm.item_id,'role',gm.role,'currency',gm.currency,'amountMinor',gm.signed_amount_minor::text,'reservedGroupId',a.group_id,'outcome',oc.outcome,'outcomeGroupId',oc.group_id) ORDER BY gm.item_id),'[]') INTO e,o,ev
  FROM reconciliation.match_group_member gm LEFT JOIN reconciliation.current_allocation a ON a.item_id=gm.item_id LEFT JOIN reconciliation.outcome oc ON oc.run_id=gm.run_id AND oc.item_id=gm.item_id WHERE gm.group_id=x.id;
  invalid:=(SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'currency'<>x.currency OR z->>'reservedGroupId' IS DISTINCT FROM x.id::text OR z->>'outcomeGroupId' IS DISTINCT FROM x.id::text OR z->>'outcome' IS DISTINCT FROM 'MATCHED');
  IF (SELECT count(*) FROM jsonb_array_elements(ev) z WHERE z->>'role'='BANK_MOVEMENT')<>1 OR jsonb_array_length(ev)<2 OR jsonb_array_length(ev)>33 OR e<>x.signed_amount_minor OR o<>x.signed_amount_minor OR NOT reconciliation.current_valid(x.id) THEN invalid:=invalid+1; END IF;
  d:=jsonb_build_object('controls',CASE WHEN invalid=0 THEN '[]'::jsonb ELSE '["ALLOCATION_INTEGRITY_OR_FRESHNESS_FAILED"]'::jsonb END,'processorMinor',e::text,'bankMinor',o::text,'groupMinor',x.signed_amount_minor::text,'invalid',invalid);
  data:=data||jsonb_build_array(controls.input_data('allocation:'||x.id,'ALLOCATION',jsonb_build_object('bookId',bk,'matchGroupId',x.id,'reconciliationRunId',x.run_id),x.currency,e,o,'checks',d,jsonb_build_object('members',ev,'proof',x.evidence)));
 END LOOP;
 FOR x IN SELECT * FROM ledger.ledger_transaction WHERE book_id=bk ORDER BY id LOOP
  SELECT coalesce(sum(amount_minor) FILTER(WHERE side='debit'),0),coalesce(sum(amount_minor) FILTER(WHERE side='credit'),0),count(*),coalesce(jsonb_agg(jsonb_build_object('entryId',id,'accountId',account_id,'amountMinor',amount_minor::text,'currency',currency,'side',side) ORDER BY line_number),'[]') INTO e,o,n,ev FROM ledger.ledger_entry WHERE journal_id=x.id;
  invalid:=CASE WHEN n BETWEEN 2 AND 1000 AND e=o AND x.state='posted' AND NOT EXISTS(SELECT FROM ledger.ledger_entry WHERE journal_id=x.id AND (currency<>x.currency OR book_id<>bk)) THEN 0 ELSE 1 END;
  data:=data||jsonb_build_array(controls.input_data('ledger:'||x.id,'LEDGER',jsonb_build_object('bookId',bk,'journalId',x.id),x.currency,e,o,'checks',jsonb_build_object('entryCount',n,'controls',CASE WHEN invalid=0 THEN '[]'::jsonb ELSE '["JOURNAL_INTEGRITY_FAILED"]'::jsonb END),ev));
 END LOOP;
 -- Aging is an explicit deterministic cutoff policy, not a worker or silent closure.
 SELECT coalesce(jsonb_agg(jsonb_build_object('caseId',c.id,'eventId',c.event_id,'createdAt',c.created_at,'resolution',c.resolution) ORDER BY c.id),'[]'),floor(extract(epoch FROM at_time-min(c.created_at))) INTO ev,o
 FROM exceptions.current_case c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE m.book_id=bk AND NOT EXISTS(SELECT FROM reconciliation.active_allocation WHERE item_id=c.item_id);
 data:=data||jsonb_build_array(controls.input_data('aging:'||bk,'FRESHNESS',jsonb_build_object('bookId',bk,'population','UNRECONCILED_CASES','asOf',at_time),NULL,(p->>'maxAgeSeconds')::numeric,o,'age',jsonb_build_object('oldestUnresolvedAgeSeconds',o::text),ev));
 IF jsonb_array_length(data)>20000 THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='Control result bound exceeded'; END IF;
 data:=data||jsonb_build_array(controls.input_data('ledger-population:'||bk,'LEDGER',jsonb_build_object('bookId',bk,'population','ALL_POSTED_JOURNALS'),NULL,NULL,NULL,'checks',jsonb_build_object('controls','[]'::jsonb,'journalCount',(SELECT count(*) FROM ledger.ledger_transaction WHERE book_id=bk)),(SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM ledger.ledger_transaction WHERE book_id=bk)));
 RETURN (SELECT jsonb_agg(z ORDER BY z->>'key') FROM jsonb_array_elements(data) z);
END $$;
ALTER TABLE audit.audit_event ADD COLUMN control_run_id uuid UNIQUE REFERENCES controls.run ON DELETE RESTRICT;
ALTER TABLE outbox.outbox_event ADD COLUMN control_run_id uuid UNIQUE REFERENCES controls.run ON DELETE RESTRICT;
DO $$ DECLARE t text; c record; branch text; BEGIN
 FOREACH t IN ARRAY ARRAY['audit.audit_event','outbox.outbox_event'] LOOP
  branch:=CASE WHEN t='audit.audit_event' THEN $b$control_run_id IS NOT NULL AND action='controls.completed' AND previous_state='EVALUATING' AND new_state='COMPLETED' AND reversal_of IS NULL AND command_key IS NULL AND policy_version='financial-controls-v1'$b$ ELSE $b$control_run_id IS NOT NULL AND event_type='controls.completed' AND normalizer_version IS NULL AND command_key IS NULL AND aggregate_version=1 AND schema_version=1 AND payload=jsonb_build_object('bookId',book_id,'controlRunId',control_run_id)$b$ END;
  FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expr FROM pg_constraint WHERE conrelid=t::regclass AND contype='c' AND (pg_get_expr(conbin,conrelid) LIKE '%num_nonnulls%' OR pg_get_expr(conbin,conrelid) ~ '(action|previous_state|new_state|payload|event_type)') LOOP
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',t,c.conname);
   EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK ((control_run_id IS NULL AND (%s)) OR (%s))',t,c.conname,c.expr,branch);
  END LOOP;
 END LOOP;
END $$;
ALTER TABLE audit.audit_event ADD CHECK(control_run_id IS NULL OR num_nonnulls(account_id,journal_id,batch_id,revision_id,processor_evaluation_id,bank_evaluation_id,reconciliation_decision_id,exception_event_id)=0);
ALTER TABLE outbox.outbox_event ADD CHECK(control_run_id IS NULL OR num_nonnulls(account_id,journal_id,batch_id,processor_derivation_id,bank_derivation_id,reconciliation_decision_id,reconciliation_run_id,exception_event_id)=0);
CREATE FUNCTION controls.lock_book(bk uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM FROM ledger.book WHERE id=bk FOR NO KEY UPDATE;
 PERFORM FROM ingestion.source_account WHERE book_id=bk ORDER BY id FOR UPDATE;
END $$;
CREATE FUNCTION controls.create_run(p jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE bk uuid:=(p->>'bookId')::uuid;r controls.run%ROWTYPE;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>7 OR NOT(p ?& ARRAY['bookId','runKey','actorId','version','reconciliationRunIds','maxAgeSeconds','createCases']) OR p->>'version' IS DISTINCT FROM 'financial-controls-v1'
 OR length(btrim(p->>'runKey')) NOT BETWEEN 1 AND 512 OR length(btrim(p->>'actorId')) NOT BETWEEN 1 AND 512 OR jsonb_typeof(p->'createCases') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(p->'reconciliationRunIds') IS DISTINCT FROM 'array' OR p->>'maxAgeSeconds' !~ '^[1-9][0-9]*$' OR (p->>'maxAgeSeconds')::numeric NOT BETWEEN 1 AND 31536000 THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='Invalid control command'; END IF;
 p:=jsonb_set(p,'{bookId}',to_jsonb(bk::text));
 p:=jsonb_set(p,'{reconciliationRunIds}',(SELECT coalesce(jsonb_agg((v::uuid)::text ORDER BY (v::uuid)::text),'[]') FROM jsonb_array_elements_text(p->'reconciliationRunIds') v));
 IF EXISTS(SELECT FROM jsonb_array_elements_text(p->'reconciliationRunIds') z LEFT JOIN reconciliation.run rr ON rr.id=z::uuid LEFT JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE m.book_id IS DISTINCT FROM bk)
 OR (SELECT count(*) FROM jsonb_array_elements_text(p->'reconciliationRunIds'))<>(SELECT count(DISTINCT rr.mapping_id) FROM jsonb_array_elements_text(p->'reconciliationRunIds') z JOIN reconciliation.run rr ON rr.id=z::uuid) THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='One explicit population per book mapping required'; END IF;
 PERFORM FROM ledger.book WHERE id=bk FOR NO KEY UPDATE;
 SELECT * INTO r FROM controls.run WHERE book_id=bk AND run_key=p->>'runKey' FOR UPDATE;
 IF r.id IS NOT NULL THEN IF r.command<>p THEN RAISE EXCEPTION USING ERRCODE='P9001',MESSAGE='Control identity conflict'; END IF; RETURN r.id; END IF;
 INSERT INTO controls.run(book_id,run_key,version,command,actor_id) VALUES(bk,p->>'runKey',p->>'version',p,p->>'actorId') RETURNING id INTO r.id;
 RETURN r.id;
END $$;
CREATE FUNCTION controls.freeze(rid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r controls.run%ROWTYPE; data jsonb; z jsonb; tm timestamptz:=transaction_timestamp();
BEGIN
 IF current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='Controls freeze requires repeatable read'; END IF;
 SELECT * INTO STRICT r FROM controls.run WHERE id=rid;
 PERFORM controls.lock_book(r.book_id);
 SELECT * INTO STRICT r FROM controls.run WHERE id=rid FOR UPDATE;
 IF r.state<>'DRAFT' THEN RETURN; END IF;
 data:=controls.snapshot(r.command,tm);
 UPDATE controls.run SET state='SEALED',frozen_at=tm,seal_transaction=pg_current_xact_id(),manifest=data,input_hash=encode(sha256(convert_to(data::text,'UTF8')),'hex') WHERE id=rid;
 FOR z IN SELECT * FROM jsonb_array_elements(data) LOOP
  INSERT INTO controls.input(run_id,key,payload,currency,source_account_id,batch_id,processor_settlement_id,bank_statement_id,reconciliation_run_id,match_group_id,journal_id)
  VALUES(rid,z->>'key',z,z->>'currency',(z->'scope'->>'sourceAccountId')::uuid,(z->'scope'->>'batchId')::uuid,(z->'scope'->>'processorSettlementId')::uuid,(z->'scope'->>'bankStatementId')::uuid,(z->'scope'->>'reconciliationRunId')::uuid,(z->'scope'->>'matchGroupId')::uuid,(z->'scope'->>'journalId')::uuid);
 END LOOP;
END $$;
CREATE FUNCTION controls.evaluate(rid uuid,lim integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r controls.run%ROWTYPE;x record; z jsonb;n integer:=0;
BEGIN
 IF lim NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='Invalid evaluation limit'; END IF;
 SELECT * INTO STRICT r FROM controls.run WHERE id=rid FOR UPDATE;
 IF r.state='COMPLETED' THEN RETURN 0; END IF;
 IF r.state='DRAFT' THEN RAISE EXCEPTION USING ERRCODE='P9002',MESSAGE='Input not frozen'; END IF;
 IF r.state='SEALED' THEN UPDATE controls.run SET state='EVALUATING' WHERE id=rid; END IF;
 FOR x IN SELECT i.* FROM controls.input i WHERE i.run_id=rid AND NOT EXISTS(SELECT FROM controls.result rs WHERE rs.run_id=i.run_id AND rs.key=i.key) ORDER BY i.key LIMIT lim LOOP
  z:=controls.evaluate_input(x.payload);
  INSERT INTO controls.result(run_id,key,result,status,severity,currency,expected,observed,discrepancy)
  VALUES(rid,x.key,z,z->>'status',z->>'severity',z->>'currency',(z->>'expected')::numeric,(z->>'observed')::numeric,(z->>'discrepancy')::numeric);n:=n+1;
 END LOOP;
 RETURN n;
END $$;
CREATE FUNCTION controls.linkable(p jsonb,cid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT FROM exceptions.case_record cr JOIN reconciliation.account_mapping m ON m.id=cr.mapping_id JOIN reconciliation.item it ON it.id=cr.item_id LEFT JOIN ingestion.source_fact f ON f.id=it.source_fact_id LEFT JOIN ingestion.revision rev ON rev.id=it.observation_revision_id
 WHERE cr.id=cid AND m.book_id=(p->'scope'->>'bookId')::uuid AND (p->>'currency' IS NULL OR m.currency=p->>'currency') AND (
 (p->>'type' IN ('EXPOSURE','FRESHNESS') AND m.id=(p->'scope'->>'mappingId')::uuid)
 OR (p->>'type' IN ('SOURCE','PROCESSOR','PROCESSOR_TOTAL','BANK','BANK_TOTAL','BANK_COMPLETENESS') AND coalesce(f.source_account_id,rev.source_account_id)=(p->'scope'->>'sourceAccountId')::uuid)
 OR (p->>'type'='ALLOCATION' AND EXISTS(SELECT FROM reconciliation.match_group_member gm WHERE gm.group_id=(p->'scope'->>'matchGroupId')::uuid AND gm.item_id=cr.item_id))))
$$;
CREATE FUNCTION controls.complete(rid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r controls.run%ROWTYPE;x record;ids uuid[];cid uuid;reconid uuid;
BEGIN
 SELECT * INTO STRICT r FROM controls.run WHERE id=rid;
 PERFORM controls.lock_book(r.book_id);
 SELECT * INTO STRICT r FROM controls.run WHERE id=rid FOR UPDATE;
 IF r.state='COMPLETED' THEN RETURN; END IF;
 IF r.state<>'EVALUATING' OR (SELECT count(*) FROM controls.result WHERE run_id=rid)<>jsonb_array_length(r.manifest) THEN RAISE EXCEPTION USING ERRCODE='P9004',MESSAGE='Incomplete control run'; END IF;
 IF (r.command->>'createCases')::boolean THEN
  FOR reconid IN SELECT z::uuid FROM jsonb_array_elements_text(r.command->'reconciliationRunIds') z WHERE EXISTS(SELECT FROM controls.input i JOIN controls.result rs USING(run_id,key) WHERE i.run_id=rid AND rs.status='FAIL' AND i.payload->>'type' IN ('SOURCE','PROCESSOR','PROCESSOR_TOTAL','BANK','BANK_TOTAL','BANK_COMPLETENESS','EXPOSURE','ALLOCATION','FRESHNESS')) AND EXISTS(SELECT FROM reconciliation.run rr WHERE rr.id=z::uuid AND rr.state='COMPLETED') LOOP
   ids:=exceptions.generate(jsonb_build_object('runId',reconid,'actorId',r.actor_id));
   FOREACH cid IN ARRAY ids LOOP
    INSERT INTO controls.case_link(run_id,key,case_id) SELECT rid,i.key,cid FROM controls.input i JOIN controls.result rs USING(run_id,key) WHERE i.run_id=rid AND rs.status='FAIL' AND controls.linkable(i.payload,cid) ON CONFLICT DO NOTHING;
   END LOOP;
  END LOOP;
 END IF;
 UPDATE controls.run SET state='COMPLETED',completed_at=transaction_timestamp() WHERE id=rid;
 INSERT INTO audit.audit_event(book_id,control_run_id,action,actor_id,previous_state,new_state,reason,policy_version)
 VALUES(r.book_id,rid,'controls.completed',r.actor_id,'EVALUATING','COMPLETED','Immutable frozen control population fully evaluated',r.version);
 INSERT INTO outbox.outbox_event(book_id,control_run_id,event_type,aggregate_version,schema_version,payload)
 VALUES(r.book_id,rid,'controls.completed',1,1,jsonb_build_object('bookId',r.book_id,'controlRunId',rid));
END $$;
CREATE FUNCTION controls.guard_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Control history immutable'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'DRAFT' OR NEW.command->>'version' IS DISTINCT FROM NEW.version OR NEW.command->>'bookId' IS DISTINCT FROM NEW.book_id::text OR NEW.command->>'runKey' IS DISTINCT FROM NEW.run_key OR NEW.command->>'actorId' IS DISTINCT FROM NEW.actor_id THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Invalid control origin'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','frozen_at','completed_at','seal_transaction','manifest','input_hash'])<>(to_jsonb(OLD)-ARRAY['state','frozen_at','completed_at','seal_transaction','manifest','input_hash']) THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Immutable control identity'; END IF;
  IF OLD.state='DRAFT' AND NEW.state='SEALED' THEN
   IF current_setting('transaction_isolation')<>'repeatable read' OR NEW.seal_transaction<>pg_current_xact_id() OR NEW.frozen_at IS DISTINCT FROM transaction_timestamp() OR NEW.manifest IS DISTINCT FROM controls.snapshot(NEW.command,NEW.frozen_at) THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Forged frozen population'; END IF;
  ELSIF OLD.state='SEALED' AND NEW.state='EVALUATING' THEN
   IF to_jsonb(NEW)-'state'<>to_jsonb(OLD)-'state' THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Frozen control inputs'; END IF;
  ELSIF OLD.state='EVALUATING' AND NEW.state='COMPLETED' THEN
   IF to_jsonb(NEW)-ARRAY['state','completed_at']<>to_jsonb(OLD)-ARRAY['state','completed_at'] OR NEW.completed_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Frozen control inputs'; END IF;
  ELSE RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Illegal control transition'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_run_guard BEFORE INSERT OR UPDATE OR DELETE ON controls.run FOR EACH ROW EXECUTE FUNCTION controls.guard_run();
CREATE FUNCTION controls.guard_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r controls.run%ROWTYPE;p jsonb;z jsonb;v jsonb:=to_jsonb(NEW);
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Immutable control evidence/result/link'; END IF;
 SELECT * INTO STRICT r FROM controls.run WHERE id=(v->>'run_id')::uuid FOR UPDATE;
 IF TG_TABLE_NAME='input' THEN
  IF r.state<>'SEALED' OR r.seal_transaction<>pg_current_xact_id() OR NOT EXISTS(SELECT FROM jsonb_array_elements(r.manifest) x WHERE x->>'key'=v->>'key' AND x=v->'payload') THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Input sealed'; END IF;
  p:=v->'payload';
  IF (p->'scope'->>'bookId')::uuid<>r.book_id OR v->>'source_account_id' IS DISTINCT FROM p->'scope'->>'sourceAccountId' OR v->>'batch_id' IS DISTINCT FROM p->'scope'->>'batchId' OR v->>'processor_settlement_id' IS DISTINCT FROM p->'scope'->>'processorSettlementId' OR v->>'bank_statement_id' IS DISTINCT FROM p->'scope'->>'bankStatementId' OR v->>'reconciliation_run_id' IS DISTINCT FROM p->'scope'->>'reconciliationRunId' OR v->>'match_group_id' IS DISTINCT FROM p->'scope'->>'matchGroupId' OR v->>'journal_id' IS DISTINCT FROM p->'scope'->>'journalId' THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Typed control evidence mismatch'; END IF;
 ELSIF TG_TABLE_NAME='result' THEN
  SELECT payload INTO STRICT p FROM controls.input WHERE run_id=r.id AND key=v->>'key';z:=controls.evaluate_input(p);
  IF r.state<>'EVALUATING' OR v->'result'<>z OR v->>'expected' IS DISTINCT FROM z->>'expected' OR v->>'observed' IS DISTINCT FROM z->>'observed' OR v->>'discrepancy' IS DISTINCT FROM z->>'discrepancy' OR v->>'evaluated_at' IS NULL THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Forged or late control result'; END IF;
 ELSE
  SELECT payload INTO STRICT p FROM controls.input WHERE run_id=r.id AND key=v->>'key';
  IF r.state<>'EVALUATING' OR NOT EXISTS(SELECT FROM controls.result WHERE run_id=r.id AND key=v->>'key' AND status='FAIL') OR NOT controls.linkable(p,(v->>'case_id')::uuid) THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Invalid control case association'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION controls.validate_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r controls.run%ROWTYPE;data jsonb;
BEGIN
 SELECT * INTO STRICT r FROM controls.run WHERE id=NEW.id;
 IF r.state<>'DRAFT' THEN
  SELECT coalesce(jsonb_agg(payload ORDER BY key),'[]') INTO data FROM controls.input WHERE run_id=r.id;
  IF data<>r.manifest THEN RAISE EXCEPTION USING ERRCODE='P9004',MESSAGE='Incomplete frozen population'; END IF;
 END IF;
 IF r.state='COMPLETED' AND ((SELECT count(*) FROM controls.result WHERE run_id=r.id)<>jsonb_array_length(r.manifest) OR NOT EXISTS(SELECT FROM audit.audit_event WHERE control_run_id=r.id AND book_id=r.book_id AND actor_id=r.actor_id AND database_principal=session_user AND policy_version=r.version) OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE control_run_id=r.id AND book_id=r.book_id)) THEN RAISE EXCEPTION USING ERRCODE='P9004',MESSAGE='Incomplete control results/companions'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER control_run_complete AFTER INSERT OR UPDATE ON controls.run DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION controls.validate_run();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['input','result','case_link'] LOOP
  EXECUTE format('CREATE TRIGGER control_child_guard BEFORE INSERT OR UPDATE OR DELETE ON controls.%I FOR EACH ROW EXECUTE FUNCTION controls.guard_child()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['version','run','input','result','case_link'] LOOP
  EXECUTE format('CREATE TRIGGER control_no_truncate BEFORE TRUNCATE ON controls.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
END $$;
CREATE TRIGGER control_version_immutable BEFORE UPDATE OR DELETE ON controls.version FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE FUNCTION controls.guard_companion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r controls.run%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM controls.run WHERE id=NEW.control_run_id;
 IF r.state<>'COMPLETED' OR NEW.book_id<>r.book_id OR (TG_TABLE_SCHEMA='audit' AND (to_jsonb(NEW)->>'actor_id'<>r.actor_id OR to_jsonb(NEW)->>'database_principal'<>session_user)) THEN RAISE EXCEPTION USING ERRCODE='P9003',MESSAGE='Invalid control companion'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER control_audit_guard BEFORE INSERT ON audit.audit_event FOR EACH ROW WHEN(NEW.control_run_id IS NOT NULL) EXECUTE FUNCTION controls.guard_companion();
CREATE TRIGGER control_outbox_guard BEFORE INSERT ON outbox.outbox_event FOR EACH ROW WHEN(NEW.control_run_id IS NOT NULL) EXECUTE FUNCTION controls.guard_companion();
CREATE FUNCTION controls.summary(rid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r controls.run%ROWTYPE;data jsonb;fresh boolean:=false;rs jsonb;assurance text;why text:='INCOMPLETE';
BEGIN
 SELECT * INTO STRICT r FROM controls.run WHERE id=rid;
 IF r.state='COMPLETED' THEN
  IF statement_timestamp()-r.frozen_at>make_interval(secs=>(r.command->>'maxAgeSeconds')::integer) THEN why:='EVALUATION_EXPIRED';
  ELSE BEGIN
   fresh:=controls.snapshot(r.command,r.frozen_at)=r.manifest;why:=CASE WHEN fresh THEN 'UNCHANGED_INPUTS' ELSE 'INPUTS_CHANGED' END;
  EXCEPTION WHEN SQLSTATE 'P9002' OR SQLSTATE 'P6002' THEN fresh:=false;why:='CURRENT_POPULATION_UNSUPPORTED'; END; END IF;
 END IF;
 SELECT coalesce(jsonb_agg(result ORDER BY key),'[]') INTO rs FROM controls.result WHERE run_id=rid;
 assurance:=CASE WHEN EXISTS(SELECT FROM controls.result WHERE run_id=rid AND status='FAIL') THEN 'FAIL' WHEN NOT fresh OR EXISTS(SELECT FROM controls.result WHERE run_id=rid AND status='UNKNOWN') THEN 'UNKNOWN' ELSE 'PASS' END;
 RETURN jsonb_build_object('id',rid,'bookId',r.book_id,'version',r.version,'state',r.state,'frozenAt',r.frozen_at,'completedAt',r.completed_at,'current',fresh,'currentReason',why,'assurance',assurance,'results',rs,
 'statuses',coalesce((SELECT jsonb_agg(to_jsonb(z) ORDER BY z.type,z.status) FROM(SELECT result->>'type' AS type,status,count(*) AS count FROM controls.result WHERE run_id=rid GROUP BY result->>'type',status) z),'[]'),
 'processing',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',result->'scope','status',status,'counts',result->'details') ORDER BY key) FROM controls.result WHERE run_id=rid AND result->>'type'='PROCESSING_PARTITION'),'[]'),
 'reconciliation',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',result->'scope','status',status,'counts',result->'details') ORDER BY key) FROM controls.result WHERE run_id=rid AND result->>'type'='RECONCILIATION'),'[]'),
 'exposure',coalesce((SELECT jsonb_agg(jsonb_build_object('scope',result->'scope','currency',currency,'status',status,'unreconciledMinor',result->'details'->'unreconciledMinor','acceptedRiskMinor',result->'details'->'acceptedRiskMinor','knownUnreconciledMinor',result->'details'->'knownUnreconciledMinor','knownAcceptedRiskMinor',result->'details'->'knownAcceptedRiskMinor','unknownCount',result->'details'->'unknownCount','acceptedRiskUnknownCount',result->'details'->'acceptedRiskUnknownCount','selectionStale',result->'details'->'selectionStale','processorClaimMinor',result->'details'->'processorClaimMinor','bankClaimMinor',result->'details'->'bankClaimMinor','pairResidualMinor',result->'details'->'pairResidualMinor') ORDER BY key) FROM controls.result WHERE run_id=rid AND result->>'type'='EXPOSURE'),'[]'),
 'cases',coalesce((SELECT jsonb_agg(jsonb_build_object('key',key,'caseId',case_id) ORDER BY key,case_id) FROM controls.case_link WHERE run_id=rid),'[]'));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA controls FROM PUBLIC;
GRANT USAGE ON SCHEMA controls TO flow_control_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA controls TO flow_control_reader;
GRANT EXECUTE ON FUNCTION controls.summary(uuid) TO flow_control_reader;
GRANT EXECUTE ON FUNCTION controls.create_run(jsonb),controls.freeze(uuid),controls.evaluate(uuid,integer),controls.complete(uuid) TO flow_control_writer;
RESET ROLE;
