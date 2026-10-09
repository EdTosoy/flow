-- Phase 14. Applied migrations and historical policies remain unchanged.
RESET ROLE;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['flow_stripe_ingress','flow_stripe_worker'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r); END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe Stripe capability'; END IF;
 END LOOP;
END $$;
GRANT flow_worker TO flow_stripe_worker;
CREATE SCHEMA stripe AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA stripe FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
INSERT INTO ingestion.normalizer_version VALUES
 ('external-event-v1','Authenticated external snapshot envelope; non-monetary immutable provenance'),
 ('processor-movement-v1','Provider-neutral canonical economic movement, backed by immutable acquired evidence'),
 ('processor-settlement-v1','Provider-neutral explicit whole-component settlement declaration');
CREATE TABLE processor.evidence_policy (
 source_account_id uuid PRIMARY KEY REFERENCES ingestion.source_account ON DELETE RESTRICT,
 activity_version text NOT NULL REFERENCES ingestion.normalizer_version,
 settlement_version text NOT NULL REFERENCES ingestion.normalizer_version,
 CHECK(activity_version='processor-movement-v1' AND settlement_version='processor-settlement-v1')
);
CREATE TRIGGER immutable_policy BEFORE UPDATE OR DELETE ON processor.evidence_policy FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON processor.evidence_policy FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
CREATE FUNCTION processor.activity_version(aid uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$ SELECT coalesce((SELECT activity_version FROM processor.evidence_policy WHERE source_account_id=aid),'synthetic-movement-v1') $$;
CREATE FUNCTION processor.settlement_version(aid uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$ SELECT coalesce((SELECT settlement_version FROM processor.evidence_policy WHERE source_account_id=aid),'synthetic-settlement-v1') $$;
-- Preserve the exact old CHECK expression; admit only the new typed contracts.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint WHERE conrelid='ingestion.interpretation'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%synthetic-bank-statement-v1%' LOOP
  EXECUTE format('ALTER TABLE ingestion.interpretation DROP CONSTRAINT %I',c.conname);
  EXECUTE 'ALTER TABLE ingestion.interpretation ADD CHECK ((('||c.expression||') OR
  (normalizer_version IN (''processor-movement-v1'',''processor-settlement-v1'') AND state=''NORMALIZED'' AND failure_code IS NULL AND amount_minor IS NOT NULL AND currency IS NOT NULL AND occurred_at IS NOT NULL AND direction IS NOT NULL AND result->>''state''=''NORMALIZED'' AND result->''observation''->''amount''=jsonb_build_object(''amountMinor'',amount_minor::text,''currency'',currency) AND result->''observation''->>''direction''=direction AND result->''observation''->>''type''=CASE normalizer_version WHEN ''processor-movement-v1'' THEN ''movement'' ELSE ''settlement'' END) OR
  (normalizer_version=''external-event-v1'' AND state=''NORMALIZED'' AND failure_code IS NULL AND amount_minor IS NULL AND currency IS NULL AND occurred_at IS NOT NULL AND direction IS NULL AND result->>''state''=''NORMALIZED'' AND result->''observation''->>''type''=''external-event'')) IS TRUE)';
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='processor.settlement_batch'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%component_kind%' LOOP EXECUTE format('ALTER TABLE processor.settlement_batch DROP CONSTRAINT %I',c.conname); END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='processor.evaluation'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%synthetic-movement-v1%' LOOP EXECUTE format('ALTER TABLE processor.evaluation DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE processor.settlement_batch ADD CHECK(component_kind IN ('synthetic-movement','processor-movement'));
ALTER TABLE processor.evaluation ADD CHECK(activity_normalizer_version IN ('synthetic-movement-v1','synthetic-movement-v2','processor-movement-v1'));
-- Existing canonical guards retain their old branches, with the new settlement version explicitly dispatched.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('ingestion.guard_interpretation()'::regprocedure);
 d:=replace(d,'NEW.normalizer_version=''synthetic-settlement-v1''','NEW.normalizer_version IN (''synthetic-settlement-v1'',''processor-settlement-v1'')');
 d:=replace(d,'o->>''componentKind'' IS DISTINCT FROM ''synthetic-movement''','o->>''componentKind'' IS DISTINCT FROM (CASE NEW.normalizer_version WHEN ''processor-settlement-v1'' THEN ''processor-movement'' ELSE ''synthetic-movement'' END)');
 EXECUTE d;
 d:=pg_get_functiondef('ingestion.accept_batch(jsonb)'::regprocedure);
 d:=replace(d,'imported_count,completeness)','imported_count,completeness,preferred_version)');
 d:=replace(d,',n,coverage)',',n,coverage,coalesce(p->>''preferredNormalizerVersion'',''synthetic-movement-v1''))');
 d:=replace(d,'request_normalization(bid,''synthetic-movement-v1''','request_normalization(bid,coalesce(p->>''preferredNormalizerVersion'',''synthetic-movement-v1'')');
 EXECUTE d;
 d:=pg_get_functiondef('processor.evaluate(jsonb)'::regprocedure);
 d:=replace(d,'nv NOT IN (''synthetic-movement-v1'',''synthetic-movement-v2'')','nv NOT IN (''synthetic-movement-v1'',''synthetic-movement-v2'',''processor-movement-v1'')'); EXECUTE d;
 d:=pg_get_functiondef('reconciliation.population_v6(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
 d:=replace(d,'reasons text[];','reasons text[]; external_pending boolean;');
 d:=replace(d,'WHERE id=mid;', 'WHERE id=mid;'||chr(10)||' external_pending:=EXISTS(SELECT FROM ingestion.processing ep JOIN ingestion.raw_record er ON er.id=ep.raw_id WHERE er.source_account_id=mapping.processor_source_account_id AND ep.normalizer_version=''external-event-v1'' AND ep.state<>''NORMALIZED'');');
 d:=replace(d,'''synthetic-settlement-v1''','processor.settlement_version(mapping.processor_source_account_id)');
 d:=replace(d,'''synthetic-movement-v1''','processor.activity_version(mapping.processor_source_account_id)');
 d:=replace(d,'identity:=pop.fact_id; side:=''PROCESSOR'';', 'IF external_pending THEN reasons:=array_append(reasons,''EXTERNAL_EVIDENCE_PENDING''); END IF;'||chr(10)||' identity:=pop.fact_id; side:=''PROCESSOR'';'); EXECUTE d;
 d:=pg_get_functiondef('reconciliation.guard_item()'::regprocedure);
 d:=replace(d,'k<>''synthetic-settlement''','k NOT IN (''synthetic-settlement'',''processor-settlement'')'); EXECUTE d;
 d:=pg_get_functiondef('processor.settlement_snapshot(uuid,text,text)'::regprocedure);
 d:=replace(d,'RETURN jsonb_build_object(''input'',jsonb_build_object(''members'',inputs,''batchId'',bid)', 'IF EXISTS(SELECT FROM ingestion.processing ep JOIN ingestion.raw_record er ON er.id=ep.raw_id WHERE er.source_account_id=b.source_account_id AND ep.normalizer_version=''external-event-v1'' AND ep.state<>''NORMALIZED'') THEN complete:=false; END IF;'||chr(10)||' RETURN jsonb_build_object(''input'',jsonb_build_object(''members'',inputs,''batchId'',bid)');
 -- Sufficient is added only when new external evidence is pending; old sources/results retain their exact shape.
 d:=replace(d,'''knownComponentNetMinor'',net::text));','''knownComponentNetMinor'',net::text) || CASE WHEN EXISTS(SELECT FROM ingestion.processing ep JOIN ingestion.raw_record er ON er.id=ep.raw_id WHERE er.source_account_id=b.source_account_id AND ep.normalizer_version=''external-event-v1'' AND ep.state<>''NORMALIZED'') THEN jsonb_build_object(''sufficient'',false) ELSE ''{}''::jsonb END);'); EXECUTE d;
 d:=pg_get_functiondef('controls.snapshot(jsonb,timestamp with time zone)'::regprocedure);
 d:=replace(d,'''synthetic-movement-v1'',''synthetic-movement-v2'',''synthetic-settlement-v1''','''synthetic-movement-v1'',''synthetic-movement-v2'',''synthetic-settlement-v1'',''processor-movement-v1'',''processor-settlement-v1''');
 d:=replace(d,'x.id,''synthetic-movement-v1'',''processor-v1''','x.id,processor.activity_version(x.source_account_id),''processor-v1'''); EXECUTE d;
END $$;
CREATE TABLE stripe.source (
 source_account_id uuid PRIMARY KEY REFERENCES ingestion.source_account ON DELETE RESTRICT,
 account_id text NOT NULL UNIQUE CHECK(account_id ~ '^acct_[A-Za-z0-9_]+$')
);
CREATE TABLE stripe.principal_binding (
 principal name PRIMARY KEY, source_account_id uuid NOT NULL REFERENCES stripe.source ON DELETE RESTRICT,
 capability text NOT NULL CHECK(capability IN ('ingress','worker'))
);
CREATE TABLE stripe.event (
 source_account_id uuid NOT NULL REFERENCES stripe.source ON DELETE RESTRICT,
 event_id text NOT NULL CHECK(event_id ~ '^evt_[A-Za-z0-9_]+$'),
 batch_id uuid NOT NULL UNIQUE REFERENCES ingestion.batch ON DELETE RESTRICT,
 document jsonb NOT NULL CHECK(document->>'object'='event' AND document->'livemode'='false'::jsonb),
 origin text NOT NULL CHECK(origin IN ('webhook','api')),
 received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(source_account_id,event_id)
);
CREATE TABLE stripe.snapshot (
 work_id uuid NOT NULL REFERENCES worker.work_item ON DELETE RESTRICT,
 attempt integer NOT NULL CHECK(attempt>0), key text NOT NULL CHECK(length(key) BETWEEN 1 AND 256),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object' AND octet_length(document::text)<=1048576),
 api_version text NOT NULL CHECK(api_version='2026-09-30.endive'),
 acquired_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(work_id,attempt,key)
);
CREATE TABLE stripe.completion (
 work_id uuid PRIMARY KEY REFERENCES worker.work_item ON DELETE RESTRICT,
 receipt jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['source','principal_binding','event','snapshot','completion'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON stripe.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON stripe.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
END $$;
CREATE FUNCTION stripe.configure(aid uuid,acct text,login name,cap text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF cap NOT IN ('ingress','worker') OR NOT EXISTS(SELECT FROM ingestion.source_account a JOIN ingestion.source s ON s.id=a.source_id WHERE a.id=aid AND s.provider='stripe' AND s.environment='test' AND a.external_account_id=acct) THEN RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='Invalid sandbox source binding'; END IF;
 INSERT INTO stripe.source VALUES(aid,acct) ON CONFLICT DO NOTHING;
 INSERT INTO processor.evidence_policy VALUES(aid,'processor-movement-v1','processor-settlement-v1') ON CONFLICT DO NOTHING;
 INSERT INTO stripe.principal_binding VALUES(login,aid,cap) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT FROM stripe.principal_binding WHERE principal=login AND source_account_id=aid AND capability=cap) THEN RAISE EXCEPTION USING ERRCODE='P1401',MESSAGE='Principal binding conflict'; END IF;
END $$;
CREATE FUNCTION stripe.accept_event(p jsonb,origin text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE aid uuid:=(p->>'sourceAccountId')::uuid; acct text; doc jsonb; old stripe.event%ROWTYPE; accepted jsonb; raw jsonb;
BEGIN
 SELECT account_id INTO STRICT acct FROM stripe.source s JOIN stripe.principal_binding b USING(source_account_id) WHERE s.source_account_id=aid AND b.principal=session_user AND b.capability='ingress';
 IF origin NOT IN ('webhook','api') OR p->>'preferredNormalizerVersion'<>'external-event-v1' OR jsonb_array_length(p->'records')<>1 OR p->>'expectedCount' IS NOT NULL OR p->'expectedSequence'<>'null'::jsonb THEN RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='Invalid event acquisition'; END IF;
 raw:=p->'records'->0;
 IF octet_length(decode(raw->>'bytesHex','hex'))>1048576 THEN RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='Event size bound'; END IF;
 doc:=convert_from(decode(raw->>'bytesHex','hex'),'UTF8')::jsonb;
 IF doc->>'object' IS DISTINCT FROM 'event' OR doc->'livemode' IS DISTINCT FROM 'false'::jsonb OR doc ? 'account' OR doc ? 'context' OR doc->'data'->'object'->'livemode'='true'::jsonb OR doc->>'id' IS DISTINCT FROM raw->>'externalId' OR raw->>'objectKind'<>'stripe-event' OR p->>'batchKey' IS DISTINCT FROM 'stripe-event:'||(doc->>'id') OR p->'provenance'->>'accountId' IS DISTINCT FROM acct OR doc->>'type' NOT IN ('charge.succeeded','refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated','charge.dispute.closed','payout.created','payout.paid','payout.failed','payout.reconciliation_completed') THEN RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='Unsupported sandbox event'; END IF;
 PERFORM 1 FROM ingestion.source_account WHERE id=aid FOR UPDATE;
 SELECT * INTO old FROM stripe.event WHERE source_account_id=aid AND event_id=doc->>'id';
 IF FOUND THEN
  -- Webhook retries preserve exact bytes; API retrieval can serialize the immutable document differently.
  IF (old.document-'pending_webhooks') IS DISTINCT FROM (doc-'pending_webhooks') OR (origin='webhook' AND old.origin='webhook' AND NOT EXISTS(SELECT FROM ingestion.raw_record WHERE batch_id=old.batch_id AND payload_bytes=decode(raw->>'bytesHex','hex'))) THEN RAISE EXCEPTION USING ERRCODE='P1401',MESSAGE='Conflicting event evidence'; END IF;
  RETURN jsonb_build_object('id',old.batch_id,'replayed',true);
 END IF;
 accepted:=ingestion.accept_batch(p);
 INSERT INTO stripe.event VALUES(aid,doc->>'id',(accepted->>'id')::uuid,doc,origin,transaction_timestamp());
 RETURN accepted;
END $$;
CREATE FUNCTION stripe.fence(wid uuid,token uuid) RETURNS worker.work_item LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE w worker.work_item%ROWTYPE;
BEGIN
 SELECT * INTO STRICT w FROM worker.work_item WHERE id=wid FOR UPDATE;
 IF NOT worker.owns(w,token) OR w.handler<>'stripe-evidence' OR w.handler_version<>1 OR NOT EXISTS(SELECT FROM stripe.event e JOIN outbox.outbox_event o ON o.batch_id=e.batch_id JOIN stripe.principal_binding b ON b.source_account_id=e.source_account_id WHERE o.id=w.event_id AND b.principal=session_user AND b.capability='worker') THEN RAISE EXCEPTION USING ERRCODE='P1403',MESSAGE='Stripe work fenced'; END IF;
 RETURN w;
END $$;
CREATE FUNCTION stripe.save_snapshot(wid uuid,token uuid,k text,doc jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w worker.work_item%ROWTYPE; old jsonb;
BEGIN
 w:=stripe.fence(wid,token);
 SELECT document INTO old FROM stripe.snapshot WHERE work_id=wid AND attempt=w.attempt_count AND key=k;
 IF FOUND THEN IF old<>doc THEN RAISE EXCEPTION USING ERRCODE='P1401',MESSAGE='Pinned snapshot conflict'; END IF; RETURN old; END IF;
 INSERT INTO stripe.snapshot VALUES(wid,w.attempt_count,k,doc,'2026-09-30.endive',transaction_timestamp());
 RETURN doc;
END $$;
CREATE FUNCTION ingestion.guard_external_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r ingestion.raw_record%ROWTYPE; d jsonb; o jsonb:=NEW.result->'observation';
BEGIN
 SELECT * INTO STRICT r FROM ingestion.raw_record WHERE id=NEW.basis_raw_id AND revision_id=NEW.revision_id;
 d:=convert_from(r.payload_bytes,'UTF8')::jsonb;
 IF r.object_kind<>'stripe-event' OR o IS DISTINCT FROM jsonb_build_object('type','external-event','externalId',r.external_id,'occurredAt',to_char(to_timestamp((d->>'created')::double precision) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'provider','stripe','eventType',d->>'type','apiVersion',d->'api_version','objectId',d->'data'->'object'->>'id') OR NEW.result IS DISTINCT FROM jsonb_build_object('state','NORMALIZED','observation',o) OR NEW.occurred_at IS DISTINCT FROM (o->>'occurredAt')::timestamptz THEN RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='Invalid event projection'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER interpretation_provenance ON ingestion.interpretation;
CREATE TRIGGER interpretation_provenance BEFORE INSERT ON ingestion.interpretation FOR EACH ROW WHEN (NEW.normalizer_version NOT IN ('synthetic-bank-entry-v1','synthetic-bank-statement-v1','synthetic-settlement-group-v1','external-event-v1') OR NEW.state='FAILED') EXECUTE FUNCTION ingestion.guard_interpretation();
CREATE TRIGGER external_event_provenance BEFORE INSERT ON ingestion.interpretation FOR EACH ROW WHEN (NEW.normalizer_version='external-event-v1' AND NEW.state='NORMALIZED') EXECUTE FUNCTION ingestion.guard_external_event();
CREATE FUNCTION ingestion.guard_processor_contract() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r ingestion.raw_record%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM ingestion.raw_record WHERE id=NEW.basis_raw_id;
 IF r.object_kind IS DISTINCT FROM (CASE NEW.normalizer_version WHEN 'processor-movement-v1' THEN 'processor-movement' ELSE 'processor-settlement' END) OR convert_from(r.payload_bytes,'UTF8')::jsonb IS DISTINCT FROM NEW.result->'observation' OR NOT EXISTS(SELECT FROM processor.evidence_policy WHERE source_account_id=r.source_account_id) THEN RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='Invalid canonical processor provenance'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER canonical_processor_provenance BEFORE INSERT ON ingestion.interpretation FOR EACH ROW WHEN (NEW.normalizer_version IN ('processor-movement-v1','processor-settlement-v1') AND NEW.state='NORMALIZED') EXECUTE FUNCTION ingestion.guard_processor_contract();
CREATE FUNCTION stripe.apply(wid uuid,token uuid,archive jsonb,packets jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w worker.work_item%ROWTYPE; e stripe.event%ROWTYPE; o outbox.outbox_event%ROWTYPE; p jsonb; b jsonb; rr record; nv text; result jsonb; ids jsonb:='[]';
BEGIN
 w:=stripe.fence(wid,token);
 SELECT receipt INTO result FROM stripe.completion WHERE work_id=wid;
 IF FOUND THEN RETURN result; END IF;
 SELECT * INTO STRICT o FROM outbox.outbox_event WHERE id=w.event_id;
 SELECT * INTO STRICT e FROM stripe.event WHERE batch_id=o.batch_id;
 IF jsonb_array_length(packets)>2 OR NOT EXISTS(SELECT FROM stripe.snapshot WHERE work_id=wid) THEN RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='External evidence required'; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(packets) LOOP
  nv:=p->>'preferredNormalizerVersion';
  IF p->>'sourceAccountId' IS DISTINCT FROM e.source_account_id::text OR nv NOT IN ('processor-movement-v1','processor-settlement-v1') OR p->>'batchKey' IS DISTINCT FROM 'stripe-processed:'||e.event_id||':'||nv OR p->>'expectedCount' IS NOT NULL OR p->'expectedSequence'<>'null'::jsonb OR p->'provenance'->>'eventId' IS DISTINCT FROM e.event_id THEN RAISE EXCEPTION USING ERRCODE='P1402',MESSAGE='Processor packet scope mismatch'; END IF;
  b:=ingestion.accept_batch(p);
  FOR rr IN SELECT * FROM ingestion.raw_record WHERE batch_id=(b->>'id')::uuid ORDER BY locator LOOP
   PERFORM ingestion.complete_normalization(rr.id,nv,jsonb_build_object('state','NORMALIZED','observation',convert_from(rr.payload_bytes,'UTF8')::jsonb));
   result:=processor.derive(rr.revision_id,nv,'processor-v1'); ids:=ids||jsonb_build_array(result);
  END LOOP;
 END LOOP;
 FOR rr IN SELECT id FROM ingestion.raw_record WHERE batch_id=e.batch_id LOOP PERFORM ingestion.complete_normalization(rr.id,'external-event-v1',archive); END LOOP;
 result:=jsonb_build_object('derivations',ids,'eventId',e.event_id);
 INSERT INTO stripe.completion VALUES(wid,result,transaction_timestamp());
 RETURN result;
END $$;
-- Routing extends the existing immutable outbox registration; no second queue.
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('worker.register_intent()'::regprocedure);
 d:=replace(d,'INSERT INTO worker.registration','IF NEW.event_type=''ingestion.normalization_requested'' AND NEW.normalizer_version=''external-event-v1'' THEN h:=''stripe-evidence''; hv:=1; END IF;'||chr(10)||' INSERT INTO worker.registration'); d:=replace(d,'SELECT NEW.id,h,hv,max_attempts,base_delay_ms,max_delay_ms,lease_ms,timeout_ms', 'SELECT NEW.id,h,hv,max_attempts,CASE WHEN h=''stripe-evidence'' THEN greatest(1000,base_delay_ms) ELSE base_delay_ms END,CASE WHEN h=''stripe-evidence'' THEN greatest(30000,max_delay_ms) ELSE max_delay_ms END,lease_ms,timeout_ms'); EXECUTE d;
 d:=pg_get_functiondef('worker.claim(text,uuid)'::regprocedure);
 d:=replace(d,'WHERE (scope_book IS NULL OR o.book_id=scope_book)', 'WHERE (x.handler<>''stripe-evidence'' OR EXISTS(SELECT FROM stripe.principal_binding sb JOIN ingestion.batch eb ON eb.source_account_id=sb.source_account_id WHERE sb.principal=session_user AND sb.capability=''worker'' AND eb.id=o.batch_id)) AND (NOT EXISTS(SELECT FROM stripe.principal_binding WHERE principal=session_user AND capability=''worker'') OR o.book_id=(SELECT a.book_id FROM stripe.principal_binding sb JOIN ingestion.source_account a ON a.id=sb.source_account_id WHERE sb.principal=session_user AND sb.capability=''worker'')) AND (scope_book IS NULL OR o.book_id=scope_book)'); EXECUTE d;
 d:=pg_get_functiondef('worker.finish(uuid,uuid,text,text)'::regprocedure);
 d:=replace(d,'w.handler<>''normalize-batch''','(w.handler NOT IN (''normalize-batch'',''stripe-evidence'') OR (w.handler=''stripe-evidence'' AND NOT EXISTS(SELECT FROM stripe.completion WHERE work_id=wid)))'); d:=replace(d,'INSERT INTO worker.attempt_event(work_id,attempt,lease_token,kind,failure_class,failure_code,owner)', 'IF w.handler=''stripe-evidence'' THEN delay_ms:=greatest(delay_ms,least(3600,greatest(0,coalesce(nullif(current_setting(''flow.stripe_retry_seconds'',true),''''),''0'')::integer))*1000::bigint); END IF;'||chr(10)||' INSERT INTO worker.attempt_event(work_id,attempt,lease_token,kind,failure_class,failure_code,owner)');
 EXECUTE d;
END $$;
CREATE FUNCTION stripe.finish(wid uuid,token uuid,fclass text DEFAULT NULL,fcode text DEFAULT NULL,retry_seconds integer DEFAULT 0) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE ok boolean;
BEGIN
 -- The original finish handles token replay, attempts, history and terminal budgets unchanged.
 IF retry_seconds NOT BETWEEN 0 AND 3600 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Retry bound'; END IF;
 PERFORM set_config('flow.stripe_retry_seconds',retry_seconds::text,true);
 ok:=worker.finish(wid,token,fclass,fcode);
 RETURN ok;
END $$;
CREATE FUNCTION stripe.ready(aid uuid,acct text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT FROM stripe.principal_binding b JOIN stripe.source s USING(source_account_id) WHERE b.principal=session_user AND b.capability='ingress' AND b.source_account_id=aid AND s.account_id=acct)
$$;
-- Operator provenance is bounded, redacted metadata. It does not evaluate financial truth.
CREATE FUNCTION operations.processor_provenance(pid uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('provider',s.provider,'environment',s.environment,'accountIdentity',a.external_account_id,
 'normalizerVersion',d.normalizer_version,'interpreterVersion',d.interpreter_version,
 'acquisitionCount',(SELECT count(*)::text FROM ingestion.raw_record WHERE revision_id=d.revision_id),
 'acquisitions',(SELECT coalesce(jsonb_agg(x),'[]') FROM (SELECT jsonb_build_object('rawRecordId',r.id,'eventId',b.request_payload->'provenance'->>'eventId','eventType',b.request_payload->'provenance'->>'eventType','apiVersion',b.request_payload->'provenance'->>'apiVersion','representation',b.request_payload->'provenance'->>'representation') AS x FROM ingestion.raw_record r JOIN ingestion.batch b ON b.id=r.batch_id WHERE r.revision_id=d.revision_id ORDER BY r.id LIMIT 20) q))
 FROM processor.derivation d JOIN ingestion.source_account a ON a.id=d.source_account_id JOIN ingestion.source s ON s.id=a.source_id WHERE d.id=pid
$$;
DO $$ DECLARE d text; BEGIN
 d:=pg_get_functiondef('operations.read_v1(uuid,text,jsonb)'::regprocedure);
 d:=replace(d,'m.processor_batch_id AS "processorEvidenceId",','m.processor_batch_id AS "processorEvidenceId",operations.processor_provenance(m.processor_batch_id) AS "processorProvenance",');
 EXECUTE d;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA stripe FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA stripe FROM PUBLIC;
GRANT USAGE ON SCHEMA stripe TO flow_stripe_ingress,flow_stripe_worker;
GRANT EXECUTE ON FUNCTION stripe.ready(uuid,text),stripe.accept_event(jsonb,text) TO flow_stripe_ingress;
GRANT SELECT ON stripe.event,stripe.snapshot,stripe.completion,stripe.source,stripe.principal_binding TO flow_stripe_worker;
GRANT EXECUTE ON FUNCTION stripe.save_snapshot(uuid,uuid,text,jsonb),stripe.apply(uuid,uuid,jsonb,jsonb),stripe.finish(uuid,uuid,text,text,integer) TO flow_stripe_worker;
GRANT SELECT ON processor.evidence_policy TO flow_processor_reader;
RESET ROLE;
