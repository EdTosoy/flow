-- Phase 4 processor claims only; no accounting, bank or reconciliation writes.
RESET ROLE;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['flow_processor_reader','flow_processor_writer'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r);
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe processor capability role'; END IF;
 END LOOP;
END $$;
GRANT flow_processor_reader TO flow_processor_writer;
GRANT flow_ingestion_reader TO flow_processor_reader;
CREATE SCHEMA processor AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA processor FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
-- Add a typed Phase 3 interpretation without changing either historical movement contract.
INSERT INTO ingestion.normalizer_version VALUES ('synthetic-settlement-v1','Itemized synthetic settlement report; strict UTF-8, UTC milliseconds and Money v1; duplicates retained');
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='ingestion.interpretation'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%subtype%' LOOP
  EXECUTE format('ALTER TABLE ingestion.interpretation DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE ingestion.interpretation ADD CHECK (
 (state='FAILED' AND result=jsonb_build_object('state','FAILED','code',failure_code)) OR
 (state='NORMALIZED' AND result->>'state'='NORMALIZED' AND result->'observation'->'amount'=jsonb_build_object('amountMinor',amount_minor::text,'currency',currency)
 AND result->'observation'->>'direction'=direction AND
 ((normalizer_version IN ('synthetic-movement-v1','synthetic-movement-v2') AND result->'observation'->>'type'='movement' AND result->'observation'->>'subtype' IN ('capture','fee','refund','chargeback'))
 OR (normalizer_version='synthetic-settlement-v1' AND result->'observation'->>'type'='settlement'))));
-- Preserve the existing movement guard verbatim, adding a settlement-only branch.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('ingestion.guard_interpretation()'::regprocedure) INTO definition;
 definition:=replace(definition,'BEGIN' || chr(10) || ' SELECT * INTO STRICT r', $branch$BEGIN
 IF NEW.normalizer_version='synthetic-settlement-v1' AND NEW.state='NORMALIZED' THEN
  SELECT * INTO STRICT r FROM ingestion.raw_record WHERE id=NEW.basis_raw_id AND revision_id=NEW.revision_id;
  IF o IS NULL OR jsonb_typeof(o)<>'object' OR o->>'externalId' IS DISTINCT FROM r.external_id OR r.external_id IS NULL
   OR o->>'type' IS DISTINCT FROM 'settlement' OR o->>'componentKind' IS DISTINCT FROM 'synthetic-movement'
   OR o->>'transferReference' IS NULL OR length(o->>'transferReference') NOT BETWEEN 1 AND 512
   OR jsonb_typeof(o->'componentIds') IS DISTINCT FROM 'array' OR jsonb_array_length(o->'componentIds')>10000
   OR EXISTS(SELECT FROM jsonb_array_elements(o->'componentIds') x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 512)
   OR o->>'occurredAt' IS NULL OR o->>'occurredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
   OR to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM o->>'occurredAt'
   OR NEW.result->>'state' IS DISTINCT FROM NEW.state
   OR o->'amount' IS DISTINCT FROM jsonb_build_object('amountMinor',NEW.amount_minor::text,'currency',NEW.currency)
   OR o->>'direction' IS DISTINCT FROM NEW.direction
   OR (SELECT count(*) FROM jsonb_object_keys(o))<>8 OR (SELECT count(*) FROM jsonb_object_keys(NEW.result))<>2
  THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Invalid normalized settlement provenance'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT r$branch$);
 EXECUTE definition;
END $$;

CREATE TABLE processor.interpreter_version (
 version text PRIMARY KEY, contract text NOT NULL
);
INSERT INTO processor.interpreter_version VALUES ('processor-v1','Signed processor components, scoped evidence association, conservative revisions, per-capture refund controls; no internal authorization');
CREATE TABLE processor.payment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_account_id uuid NOT NULL REFERENCES ingestion.source_account ON DELETE RESTRICT,
 external_payment_reference text NOT NULL CHECK(length(external_payment_reference) BETWEEN 1 AND 512),
 UNIQUE(source_account_id,external_payment_reference), UNIQUE(id,source_account_id)
);
CREATE TABLE processor.derivation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 revision_id uuid NOT NULL,
 normalizer_version text NOT NULL,
 interpreter_version text NOT NULL REFERENCES processor.interpreter_version ON DELETE RESTRICT,
 source_account_id uuid NOT NULL,
 fact_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('activity','settlement')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(revision_id,normalizer_version) REFERENCES ingestion.interpretation ON DELETE RESTRICT,
 FOREIGN KEY(revision_id,source_account_id) REFERENCES ingestion.revision(id,source_account_id) ON DELETE RESTRICT,
 FOREIGN KEY(fact_id,source_account_id) REFERENCES ingestion.source_fact(id,source_account_id) ON DELETE RESTRICT,
 UNIQUE(revision_id,normalizer_version,interpreter_version), UNIQUE(id,source_account_id), UNIQUE(id,source_account_id,fact_id)
);
CREATE TABLE processor.activity (
 id uuid PRIMARY KEY,
 source_account_id uuid NOT NULL,
 fact_id uuid NOT NULL,
 payment_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('PAYMENT_CAPTURE','PROCESSOR_FEE','REFUND','CHARGEBACK')),
 contribution_minor bigint NOT NULL,
 currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 parent_reference text CHECK(length(parent_reference) BETWEEN 1 AND 512),
 occurred_at timestamptz NOT NULL CHECK(isfinite(occurred_at)),
 sign_control text CHECK(sign_control='INVALID_SIGN'),
 FOREIGN KEY(id,source_account_id,fact_id) REFERENCES processor.derivation(id,source_account_id,fact_id) ON DELETE RESTRICT,
 FOREIGN KEY(payment_id,source_account_id) REFERENCES processor.payment(id,source_account_id) ON DELETE RESTRICT,
 CHECK((sign_control IS NULL)=(CASE WHEN kind='PAYMENT_CAPTURE' THEN contribution_minor>0 WHEN kind='PROCESSOR_FEE' THEN contribution_minor<=0 ELSE contribution_minor<0 END)),
 UNIQUE(id,source_account_id)
);
CREATE INDEX activity_payment_idx ON processor.activity(payment_id);
CREATE TABLE processor.settlement_batch (
 id uuid PRIMARY KEY,
 source_account_id uuid NOT NULL,
 fact_id uuid NOT NULL,
 currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 reported_net_minor bigint NOT NULL,
 reported_at timestamptz NOT NULL CHECK(isfinite(reported_at)),
 transfer_reference text NOT NULL CHECK(length(transfer_reference) BETWEEN 1 AND 512),
 component_kind text NOT NULL CHECK(component_kind='synthetic-movement'),
 declared_count integer NOT NULL CHECK(declared_count BETWEEN 0 AND 10000),
 FOREIGN KEY(id,source_account_id,fact_id) REFERENCES processor.derivation(id,source_account_id,fact_id) ON DELETE RESTRICT,
 UNIQUE(id,source_account_id)
);
CREATE TABLE processor.membership (
 batch_id uuid NOT NULL REFERENCES processor.settlement_batch ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 10000),
 external_activity_id text NOT NULL CHECK(length(external_activity_id) BETWEEN 1 AND 512),
 -- Preserve repeated references as source inconsistency, never allocate their value twice.
 PRIMARY KEY(batch_id,ordinal)
);
CREATE INDEX membership_reference_idx ON processor.membership(external_activity_id,batch_id);
CREATE TABLE processor.evaluation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_account_id uuid NOT NULL REFERENCES ingestion.source_account ON DELETE RESTRICT,
 payment_id uuid, batch_id uuid,
 evaluation_key text NOT NULL CHECK(length(evaluation_key) BETWEEN 1 AND 512),
 activity_normalizer_version text NOT NULL REFERENCES ingestion.normalizer_version ON DELETE RESTRICT CHECK(activity_normalizer_version IN ('synthetic-movement-v1','synthetic-movement-v2')),
 interpreter_version text NOT NULL REFERENCES processor.interpreter_version ON DELETE RESTRICT,
 input jsonb NOT NULL,
 result jsonb NOT NULL,
 creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 FOREIGN KEY(payment_id,source_account_id) REFERENCES processor.payment(id,source_account_id) ON DELETE RESTRICT,
 FOREIGN KEY(batch_id,source_account_id) REFERENCES processor.settlement_batch(id,source_account_id) ON DELETE RESTRICT,
 CHECK(num_nonnulls(payment_id,batch_id)=1),
 CHECK(jsonb_typeof(input)='object' AND jsonb_typeof(result)='object' AND jsonb_typeof(result->'controls')='array'),
 CHECK(payment_id IS NULL OR result->>'lifecycle' IN ('observed','captured','partially_refunded','refunded','charged_back','under_review')),
 CHECK(payment_id IS NULL OR ((result->>'validRefundMinor')::numeric>=0 AND ((result->>'capturedMinor' IS NOT NULL AND (result->>'validRefundMinor')::numeric <= (result->>'capturedMinor')::numeric) OR (result->>'capturedMinor' IS NULL AND result->>'validRefundMinor'='0')))),
 UNIQUE(payment_id,evaluation_key), UNIQUE(batch_id,evaluation_key)
);
CREATE TABLE processor.evaluation_activity (
 evaluation_id uuid NOT NULL REFERENCES processor.evaluation ON DELETE RESTRICT,
 activity_id uuid NOT NULL REFERENCES processor.activity ON DELETE RESTRICT,
 PRIMARY KEY(evaluation_id,activity_id)
);

CREATE FUNCTION processor.guard_derivation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i ingestion.interpretation%ROWTYPE; r ingestion.revision%ROWTYPE;
BEGIN
 SELECT * INTO STRICT i FROM ingestion.interpretation WHERE revision_id=NEW.revision_id AND normalizer_version=NEW.normalizer_version;
 SELECT * INTO STRICT r FROM ingestion.revision WHERE id=NEW.revision_id;
 IF i.state<>'NORMALIZED' OR r.fact_id IS DISTINCT FROM NEW.fact_id OR
 NEW.kind IS DISTINCT FROM (CASE i.result->'observation'->>'type' WHEN 'movement' THEN 'activity' WHEN 'settlement' THEN 'settlement' END)
 THEN RAISE EXCEPTION USING ERRCODE='P4002',MESSAGE='Processor input provenance mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER derivation_provenance BEFORE INSERT ON processor.derivation FOR EACH ROW EXECUTE FUNCTION processor.guard_derivation();
CREATE FUNCTION processor.guard_projection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d processor.derivation%ROWTYPE; i ingestion.interpretation%ROWTYPE; o jsonb;
BEGIN
 SELECT * INTO STRICT d FROM processor.derivation WHERE id=NEW.id;
 SELECT * INTO STRICT i FROM ingestion.interpretation WHERE revision_id=d.revision_id AND normalizer_version=d.normalizer_version;
 o:=i.result->'observation';
 IF d.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='Derived population is sealed'; END IF;
 IF TG_TABLE_NAME='activity' THEN
  IF d.kind<>'activity' OR NEW.contribution_minor<>i.amount_minor OR NEW.currency<>i.currency OR NEW.occurred_at<>i.occurred_at
  OR NEW.kind IS DISTINCT FROM (CASE o->>'subtype' WHEN 'capture' THEN 'PAYMENT_CAPTURE' WHEN 'fee' THEN 'PROCESSOR_FEE' WHEN 'refund' THEN 'REFUND' WHEN 'chargeback' THEN 'CHARGEBACK' END)
  OR NEW.parent_reference IS DISTINCT FROM o->>'parentReference'
  OR NOT EXISTS(SELECT FROM processor.payment WHERE id=NEW.payment_id AND external_payment_reference=o->>'reference')
  THEN RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='Activity differs from normalized evidence'; END IF;
 ELSE
  IF d.kind<>'settlement' OR NEW.reported_net_minor<>i.amount_minor OR NEW.currency<>i.currency OR NEW.reported_at<>i.occurred_at
  OR NEW.transfer_reference IS DISTINCT FROM o->>'transferReference' OR NEW.declared_count<>jsonb_array_length(o->'componentIds')
  OR NEW.component_kind IS DISTINCT FROM o->>'componentKind'
  THEN RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='Settlement differs from normalized evidence'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER activity_provenance BEFORE INSERT ON processor.activity FOR EACH ROW EXECUTE FUNCTION processor.guard_projection();
CREATE TRIGGER settlement_provenance BEFORE INSERT ON processor.settlement_batch FOR EACH ROW EXECUTE FUNCTION processor.guard_projection();
CREATE FUNCTION processor.guard_membership() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d processor.derivation%ROWTYPE; o jsonb;
BEGIN
 SELECT * INTO STRICT d FROM processor.derivation WHERE id=NEW.batch_id;
 SELECT result->'observation' INTO STRICT o FROM ingestion.interpretation WHERE revision_id=d.revision_id AND normalizer_version=d.normalizer_version;
 IF d.creation_transaction<>pg_current_xact_id() OR NEW.external_activity_id IS DISTINCT FROM o->'componentIds'->>(NEW.ordinal-1)
 THEN RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='Membership provenance mismatch or sealed batch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_provenance BEFORE INSERT ON processor.membership FOR EACH ROW EXECUTE FUNCTION processor.guard_membership();

-- Reuse audit/outbox rather than inventing a second durable messaging mechanism.
ALTER TABLE audit.audit_event ADD COLUMN processor_evaluation_id uuid REFERENCES processor.evaluation ON DELETE RESTRICT;
ALTER TABLE outbox.outbox_event ADD COLUMN processor_derivation_id uuid REFERENCES processor.derivation ON DELETE RESTRICT;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='audit.audit_event'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%num_nonnulls%' OR pg_get_constraintdef(oid) LIKE '%ingestion.batch_accepted%') LOOP
  EXECUTE format('ALTER TABLE audit.audit_event DROP CONSTRAINT %I',c.conname);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='outbox.outbox_event'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%num_nonnulls%' OR pg_get_constraintdef(oid) LIKE '%ingestion.normalization_requested%') LOOP
  EXECUTE format('ALTER TABLE outbox.outbox_event DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE audit.audit_event ADD CHECK(num_nonnulls(account_id,journal_id,batch_id,revision_id,processor_evaluation_id)=1),
 ADD CHECK((account_id IS NOT NULL AND action='ledger.account_created' AND previous_state='absent' AND new_state='open' AND reversal_of IS NULL AND command_key IS NOT NULL)
 OR (journal_id IS NOT NULL AND action IN ('ledger.journal_posted','ledger.journal_reversed') AND previous_state='absent' AND new_state='posted' AND command_key IS NOT NULL AND ((action='ledger.journal_reversed')=(reversal_of IS NOT NULL)))
 OR (batch_id IS NOT NULL AND action IN ('ingestion.batch_accepted','ingestion.normalization_requested') AND previous_state='absent' AND new_state='accepted' AND reversal_of IS NULL)
 OR (revision_id IS NOT NULL AND action='ingestion.revision_observed' AND previous_state='absent' AND new_state='observed' AND reversal_of IS NULL)
 OR (processor_evaluation_id IS NOT NULL AND action='processor.controls_failed' AND previous_state='absent' AND new_state='control_failed' AND reversal_of IS NULL)),
 ADD UNIQUE(processor_evaluation_id);
ALTER TABLE outbox.outbox_event ADD CHECK(num_nonnulls(account_id,journal_id,batch_id,processor_derivation_id)=1),
 ADD CHECK(payload @> jsonb_build_object('bookId',book_id) AND
 ((account_id IS NOT NULL AND event_type='ledger.account_created' AND payload @> jsonb_build_object('accountId',account_id) AND command_key IS NOT NULL AND normalizer_version IS NULL)
 OR (journal_id IS NOT NULL AND event_type IN ('ledger.journal_posted','ledger.journal_reversed') AND payload @> jsonb_build_object('journalId',journal_id) AND command_key IS NOT NULL AND normalizer_version IS NULL)
 OR (batch_id IS NOT NULL AND event_type='ingestion.normalization_requested' AND normalizer_version IS NOT NULL AND payload @> jsonb_build_object('batchId',batch_id,'normalizerVersion',normalizer_version))
 OR (processor_derivation_id IS NOT NULL AND event_type='processor.interpreted' AND normalizer_version IS NULL AND payload @> jsonb_build_object('derivationId',processor_derivation_id)))),
 ADD UNIQUE(processor_derivation_id);
CREATE FUNCTION processor.guard_companion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE resource uuid; aid uuid; expected_book uuid;
BEGIN
 IF TG_TABLE_SCHEMA='audit' THEN
  resource:=(to_jsonb(NEW)->>'processor_evaluation_id')::uuid;
  IF resource IS NULL THEN RETURN NEW; END IF;
  SELECT source_account_id INTO STRICT aid FROM processor.evaluation WHERE id=resource;
 ELSE
  resource:=(to_jsonb(NEW)->>'processor_derivation_id')::uuid;
  IF resource IS NULL THEN RETURN NEW; END IF;
  SELECT source_account_id INTO STRICT aid FROM processor.derivation WHERE id=resource;
 END IF;
 SELECT book_id INTO STRICT expected_book FROM ingestion.source_account WHERE id=aid;
 IF expected_book<>NEW.book_id THEN RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='Cross-book processor companion'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER processor_audit_scope BEFORE INSERT ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION processor.guard_companion();
CREATE TRIGGER processor_outbox_scope BEFORE INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION processor.guard_companion();

CREATE FUNCTION processor.derive(rev uuid,nv text,iv text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE i ingestion.interpretation%ROWTYPE; r ingestion.revision%ROWTYPE; d processor.derivation%ROWTYPE;
 o jsonb; pid uuid; did uuid; book uuid; k text;
BEGIN
 IF iv<>'processor-v1' THEN RAISE EXCEPTION USING ERRCODE='P4002',MESSAGE='Unsupported processor interpreter'; END IF;
 SELECT * INTO STRICT r FROM ingestion.revision WHERE id=rev;
 -- Shared scope lock with ingestion makes derivation/current-revision decisions coherent.
 PERFORM 1 FROM ingestion.source_account WHERE id=r.source_account_id FOR UPDATE;
 SELECT * INTO STRICT i FROM ingestion.interpretation WHERE revision_id=rev AND normalizer_version=nv;
 IF i.state<>'NORMALIZED' OR r.fact_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P4002',MESSAGE='Successful identified normalized input required'; END IF;
 SELECT * INTO d FROM processor.derivation WHERE revision_id=rev AND normalizer_version=nv AND interpreter_version=iv;
 IF FOUND THEN
  SELECT payment_id INTO pid FROM processor.activity WHERE id=d.id;
  RETURN jsonb_build_object('id',d.id,'replayed',true,'kind',d.kind,'paymentId',pid);
 END IF;
 o:=i.result->'observation';
 k:=CASE o->>'type' WHEN 'movement' THEN 'activity' WHEN 'settlement' THEN 'settlement' END;
 INSERT INTO processor.derivation(revision_id,normalizer_version,interpreter_version,source_account_id,fact_id,kind)
 VALUES(rev,nv,iv,r.source_account_id,r.fact_id,k) RETURNING id INTO did;
 IF k='activity' THEN
  INSERT INTO processor.payment(source_account_id,external_payment_reference) VALUES(r.source_account_id,o->>'reference') ON CONFLICT DO NOTHING;
  SELECT id INTO STRICT pid FROM processor.payment WHERE source_account_id=r.source_account_id AND external_payment_reference=o->>'reference';
  k:=CASE o->>'subtype' WHEN 'capture' THEN 'PAYMENT_CAPTURE' WHEN 'fee' THEN 'PROCESSOR_FEE' WHEN 'refund' THEN 'REFUND' WHEN 'chargeback' THEN 'CHARGEBACK' END;
  INSERT INTO processor.activity(id,source_account_id,fact_id,payment_id,kind,contribution_minor,currency,parent_reference,occurred_at,sign_control)
  VALUES(did,r.source_account_id,r.fact_id,pid,k,i.amount_minor,i.currency,o->>'parentReference',i.occurred_at,
   CASE WHEN (k='PAYMENT_CAPTURE' AND i.amount_minor>0) OR (k='PROCESSOR_FEE' AND i.amount_minor<=0) OR (k IN ('REFUND','CHARGEBACK') AND i.amount_minor<0) THEN NULL ELSE 'INVALID_SIGN' END);
 ELSE
  INSERT INTO processor.settlement_batch(id,source_account_id,fact_id,currency,reported_net_minor,reported_at,transfer_reference,component_kind,declared_count)
  VALUES(did,r.source_account_id,r.fact_id,i.currency,i.amount_minor,i.occurred_at,o->>'transferReference',o->>'componentKind',jsonb_array_length(o->'componentIds'));
  INSERT INTO processor.membership(batch_id,ordinal,external_activity_id)
  SELECT did,ordinality::integer,value#>>'{}' FROM jsonb_array_elements(o->'componentIds') WITH ORDINALITY;
 END IF;
 SELECT book_id INTO STRICT book FROM ingestion.source_account WHERE id=r.source_account_id;
 INSERT INTO outbox.outbox_event(book_id,processor_derivation_id,event_type,aggregate_version,schema_version,payload)
 VALUES(book,did,'processor.interpreted',1,1,jsonb_build_object('bookId',book,'derivationId',did));
 RETURN jsonb_build_object('id',did,'replayed',false,'kind',CASE WHEN pid IS NULL THEN 'settlement' ELSE 'activity' END,'paymentId',pid);
END $$;

-- Stable helpers evaluate a single database snapshot. Received time never ranks revisions.
CREATE FUNCTION processor.payment_snapshot(pid uuid,nv text,iv text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE inputs jsonb; controls text[]:='{}'; captured numeric:=0; refunds numeric:=0; chargebacks numeric:=0; item record; parent record; state text; currencies integer; payment_currency text;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('factId',f.id,'revisionState',f.revision_state,'activeRevisionId',f.active_revision_id,
 'activityId',a.id,'kind',a.kind,'currency',a.currency,'amountMinor',a.contribution_minor::text,'parentReference',a.parent_reference,'externalId',f.external_id,'objectKind',f.object_kind,'signControl',a.sign_control) ORDER BY f.id),'[]') INTO inputs
 FROM ingestion.fact_status f
 LEFT JOIN processor.derivation d ON d.fact_id=f.id AND d.revision_id=f.active_revision_id AND d.normalizer_version=nv AND d.interpreter_version=iv
 LEFT JOIN processor.activity a ON a.id=d.id AND a.payment_id=pid
 WHERE f.id IN (SELECT fact_id FROM processor.activity WHERE payment_id=pid);
 FOR item IN SELECT * FROM jsonb_to_recordset(inputs) AS x("factId" uuid,"revisionState" text,"activityId" uuid,kind text,currency text,"amountMinor" text,"parentReference" text,"externalId" text,"objectKind" text,"signControl" text) LOOP
  IF item."revisionState"<>'UNAMBIGUOUS' THEN controls:=array_append(controls,'AMBIGUOUS_ACTIVITY'); CONTINUE; END IF;
  IF item."activityId" IS NULL THEN controls:=array_append(controls,'PENDING_ACTIVITY'); CONTINUE; END IF;
  IF item."signControl" IS NOT NULL THEN controls:=array_append(controls,'INVALID_SIGN'); CONTINUE; END IF;
  IF item.kind='PAYMENT_CAPTURE' THEN captured:=captured+item."amountMinor"::numeric; END IF;
  IF item.kind='REFUND' THEN refunds:=refunds-item."amountMinor"::numeric; END IF;
  IF item.kind='CHARGEBACK' THEN chargebacks:=chargebacks-item."amountMinor"::numeric; END IF;
  IF item.kind IN ('REFUND','CHARGEBACK') OR item."parentReference" IS NOT NULL THEN
   SELECT * INTO parent FROM jsonb_to_recordset(inputs) AS x("activityId" uuid,kind text,currency text,"externalId" text,"objectKind" text,"signControl" text,"amountMinor" text)
   WHERE x."externalId"=item."parentReference" AND x."objectKind"=item."objectKind" AND x.kind='PAYMENT_CAPTURE' AND x."activityId" IS NOT NULL AND x."signControl" IS NULL;
   IF NOT FOUND OR parent.currency<>item.currency THEN controls:=array_append(controls,'INVALID_PARENT'); END IF;
  END IF;
 END LOOP;
 SELECT count(DISTINCT x->>'currency'),min(x->>'currency') INTO currencies,payment_currency FROM jsonb_array_elements(inputs) x WHERE x->>'activityId' IS NOT NULL;
 IF currencies>1 THEN controls:=array_append(controls,'CROSS_CURRENCY_PAYMENT'); END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(inputs) c WHERE c->>'kind'='PAYMENT_CAPTURE' AND c->>'signControl' IS NULL AND
  (SELECT coalesce(sum(-(r->>'amountMinor')::numeric),0) FROM jsonb_array_elements(inputs) r WHERE r->>'kind'='REFUND' AND r->>'signControl' IS NULL AND r->>'parentReference'=c->>'externalId' AND r->>'objectKind'=c->>'objectKind')>(c->>'amountMinor')::numeric)
 THEN controls:=array_append(controls,'REFUND_EXCEEDS_CAPTURE'); END IF;
 SELECT coalesce(array_agg(DISTINCT c ORDER BY c),'{}') INTO controls FROM unnest(controls) c;
 state:=CASE WHEN cardinality(controls)>0 THEN 'under_review' WHEN chargebacks>0 THEN 'charged_back' WHEN captured=0 THEN 'observed' WHEN captured=refunds THEN 'refunded' WHEN refunds>0 THEN 'partially_refunded' ELSE 'captured' END;
 RETURN jsonb_build_object('input',jsonb_build_object('activities',inputs),'result',jsonb_build_object('controls',to_jsonb(controls),'lifecycle',state,
 'currency',CASE WHEN currencies=1 THEN payment_currency ELSE NULL END,'capturedMinor',CASE WHEN currencies>1 THEN NULL ELSE captured::text END,'refundedMinor',CASE WHEN currencies>1 THEN NULL ELSE refunds::text END,'validRefundMinor',CASE WHEN cardinality(controls)=0 THEN refunds::text ELSE '0' END,'chargebackMinor',CASE WHEN currencies>1 THEN NULL ELSE chargebacks::text END));
END $$;

CREATE FUNCTION processor.settlement_snapshot(bid uuid,nv text,iv text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE b processor.settlement_batch%ROWTYPE; controls text[]:='{}'; inputs jsonb; item record; net numeric:=0; complete boolean:=true; p jsonb; counted uuid[]:='{}';
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
   p:=processor.payment_snapshot(item."paymentId",nv,iv);
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

CREATE FUNCTION processor.evaluation_snapshot(k text,subject uuid,nv text,iv text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE snapshot jsonb;
BEGIN
 snapshot:=CASE WHEN k='payment' THEN processor.payment_snapshot(subject,nv,iv) ELSE processor.settlement_snapshot(subject,nv,iv) END;
 IF k='settlement' THEN
  snapshot:=jsonb_set(snapshot,'{input,payments}',coalesce((SELECT jsonb_agg(jsonb_build_object('paymentId',x.pid,'snapshot',processor.payment_snapshot(x.pid,nv,iv)) ORDER BY x.pid) FROM
   (SELECT DISTINCT (m->>'paymentId')::uuid AS pid FROM jsonb_array_elements(snapshot->'input'->'members') m WHERE m->>'paymentId' IS NOT NULL) x),'[]'));
 END IF;
 RETURN snapshot;
END $$;
CREATE FUNCTION processor.guard_evaluation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE snapshot jsonb;
BEGIN
 snapshot:=processor.evaluation_snapshot(CASE WHEN NEW.payment_id IS NULL THEN 'settlement' ELSE 'payment' END,coalesce(NEW.payment_id,NEW.batch_id),NEW.activity_normalizer_version,NEW.interpreter_version);
 IF snapshot->'input' IS DISTINCT FROM NEW.input OR snapshot->'result' IS DISTINCT FROM NEW.result THEN
  RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='Evaluation differs from pinned evidence';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_provenance BEFORE INSERT ON processor.evaluation FOR EACH ROW EXECUTE FUNCTION processor.guard_evaluation();
CREATE FUNCTION processor.guard_evaluation_activity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e processor.evaluation%ROWTYPE;
BEGIN
 SELECT * INTO STRICT e FROM processor.evaluation WHERE id=NEW.evaluation_id;
 IF e.creation_transaction<>pg_current_xact_id() OR NOT EXISTS(SELECT FROM processor.activity WHERE id=NEW.activity_id AND source_account_id=e.source_account_id)
 THEN RAISE EXCEPTION USING ERRCODE='P4003',MESSAGE='Evaluation activity scope or sealed population'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_activity_scope BEFORE INSERT ON processor.evaluation_activity FOR EACH ROW EXECUTE FUNCTION processor.guard_evaluation_activity();

CREATE FUNCTION processor.evaluate(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE subject uuid:=(p->>'subjectId')::uuid; aid uuid; book uuid; e processor.evaluation%ROWTYPE; snapshot jsonb; eid uuid;
 nv text:=p->>'activityNormalizerVersion'; iv text:=p->>'interpreterVersion'; ek text:=p->>'evaluationKey';
BEGIN
 IF iv<>'processor-v1' OR nv NOT IN ('synthetic-movement-v1','synthetic-movement-v2') OR p->>'kind' NOT IN ('payment','settlement') THEN RAISE EXCEPTION USING ERRCODE='P4002',MESSAGE='Unsupported evaluation policy'; END IF;
 IF p->>'kind'='payment' THEN SELECT source_account_id INTO STRICT aid FROM processor.payment WHERE id=subject;
 ELSE SELECT source_account_id INTO STRICT aid FROM processor.settlement_batch WHERE id=subject; END IF;
 PERFORM 1 FROM ingestion.source_account WHERE id=aid FOR UPDATE;
 SELECT * INTO e FROM processor.evaluation WHERE evaluation_key=ek AND (CASE WHEN p->>'kind'='payment' THEN payment_id=subject ELSE batch_id=subject END);
 IF FOUND THEN
  IF e.activity_normalizer_version<>nv OR e.interpreter_version<>iv THEN RAISE EXCEPTION USING ERRCODE='P4001',MESSAGE='Evaluation identity conflict'; END IF;
  RETURN jsonb_build_object('id',e.id,'replayed',true,'result',e.result);
 END IF;
 snapshot:=processor.evaluation_snapshot(p->>'kind',subject,nv,iv);
 INSERT INTO processor.evaluation(source_account_id,payment_id,batch_id,evaluation_key,activity_normalizer_version,interpreter_version,input,result)
 VALUES(aid,CASE WHEN p->>'kind'='payment' THEN subject ELSE NULL END,CASE WHEN p->>'kind'='settlement' THEN subject ELSE NULL END,ek,nv,iv,snapshot->'input',snapshot->'result') RETURNING id INTO eid;
 INSERT INTO processor.evaluation_activity(evaluation_id,activity_id)
 SELECT eid,a.id FROM processor.activity a WHERE a.id IN (
  SELECT (x->>'activityId')::uuid FROM jsonb_array_elements(coalesce(snapshot->'input'->'activities',snapshot->'input'->'members')) x
  UNION SELECT (a->>'activityId')::uuid FROM jsonb_array_elements(coalesce(snapshot->'input'->'payments','[]')) pp CROSS JOIN LATERAL jsonb_array_elements(pp->'snapshot'->'input'->'activities') a);
 IF jsonb_array_length(snapshot->'result'->'controls')>0 THEN
  SELECT book_id INTO STRICT book FROM ingestion.source_account WHERE id=aid;
  INSERT INTO audit.audit_event(book_id,processor_evaluation_id,action,actor_id,previous_state,new_state,reason,policy_version)
  VALUES(book,eid,'processor.controls_failed',p->>'actorId','absent','control_failed','Immutable processor-internal control evaluation',iv);
 END IF;
 RETURN jsonb_build_object('id',eid,'replayed',false,'result',snapshot->'result');
END $$;

CREATE FUNCTION processor.validate_derivation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF (NEW.kind='activity' AND NOT EXISTS(SELECT FROM processor.activity WHERE id=NEW.id))
 OR (NEW.kind='settlement' AND (NOT EXISTS(SELECT FROM processor.settlement_batch WHERE id=NEW.id)
 OR (SELECT declared_count FROM processor.settlement_batch WHERE id=NEW.id)<>(SELECT count(*) FROM processor.membership WHERE batch_id=NEW.id)))
 OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE processor_derivation_id=NEW.id)
 THEN RAISE EXCEPTION USING ERRCODE='P4004',MESSAGE='Incomplete processor derivation or missing intent'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER derivation_commit_guard AFTER INSERT ON processor.derivation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION processor.validate_derivation();
CREATE FUNCTION processor.validate_evaluation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF (SELECT coalesce(array_agg(activity_id ORDER BY activity_id),'{}'::uuid[]) FROM processor.evaluation_activity WHERE evaluation_id=NEW.id) IS DISTINCT FROM
 (SELECT coalesce(array_agg(aid ORDER BY aid),'{}'::uuid[]) FROM (SELECT DISTINCT (x->>'activityId')::uuid AS aid FROM jsonb_array_elements(coalesce(NEW.input->'activities',NEW.input->'members')) x WHERE x->>'activityId' IS NOT NULL
 UNION SELECT (a->>'activityId')::uuid FROM jsonb_array_elements(coalesce(NEW.input->'payments','[]')) pp CROSS JOIN LATERAL jsonb_array_elements(pp->'snapshot'->'input'->'activities') a WHERE a->>'activityId' IS NOT NULL) links)
 THEN RAISE EXCEPTION USING ERRCODE='P4004',MESSAGE='Incomplete evaluation activity population'; END IF;
 IF jsonb_array_length(NEW.result->'controls')>0 AND NOT EXISTS(SELECT FROM audit.audit_event WHERE processor_evaluation_id=NEW.id)
 THEN RAISE EXCEPTION USING ERRCODE='P4004',MESSAGE='Failed processor controls require atomic audit'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER evaluation_commit_guard AFTER INSERT ON processor.evaluation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION processor.validate_evaluation();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['interpreter_version','payment','derivation','activity','settlement_batch','membership','evaluation','evaluation_activity'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_processor_fact BEFORE UPDATE OR DELETE ON processor.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON processor.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
END $$;
CREATE VIEW processor.current_activity AS
 SELECT a.*,d.revision_id,d.normalizer_version,d.interpreter_version,f.revision_state,
 (f.active_revision_id=d.revision_id) AS source_unambiguous
 FROM processor.activity a JOIN processor.derivation d ON d.id=a.id JOIN ingestion.fact_status f ON f.id=a.fact_id;
REVOKE ALL ON ALL TABLES IN SCHEMA processor FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA processor FROM PUBLIC;
GRANT USAGE ON SCHEMA processor TO flow_processor_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA processor TO flow_processor_reader;
GRANT EXECUTE ON FUNCTION processor.derive(uuid,text,text),processor.evaluate(jsonb) TO flow_processor_writer;
RESET ROLE;
