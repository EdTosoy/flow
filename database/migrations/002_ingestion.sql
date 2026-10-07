-- Phase 3 only. Run by the existing transactional migration runner. PostgreSQL 18.
RESET ROLE;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['flow_ingestion_writer','flow_ingestion_reader'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe ingestion group role'; END IF;
  END LOOP;
END $$;
GRANT flow_ingestion_reader TO flow_ingestion_writer;
CREATE SCHEMA ingestion AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA ingestion FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;

CREATE TABLE ingestion.source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES ledger.book ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('synthetic','test')),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 512),
  UNIQUE(book_id,environment,provider), UNIQUE(id,book_id)
);
CREATE TABLE ingestion.source_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  book_id uuid NOT NULL,
  external_account_id text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 512),
  FOREIGN KEY(source_id,book_id) REFERENCES ingestion.source(id,book_id) ON DELETE RESTRICT,
  UNIQUE(source_id,external_account_id), UNIQUE(id,book_id)
);
CREATE TABLE ingestion.normalizer_version (
  version text PRIMARY KEY,
  contract text NOT NULL
);
INSERT INTO ingestion.normalizer_version VALUES
 ('synthetic-movement-v1','Strict UTF-8 synthetic movement JSON; canonical UTC milliseconds; Money v1'),
 ('synthetic-movement-v2','v1 plus explicit UTC seconds interpreted as zero milliseconds');
CREATE TABLE ingestion.batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES ingestion.source_account ON DELETE RESTRICT,
  batch_key text NOT NULL CHECK (length(batch_key) BETWEEN 1 AND 512),
  request_payload jsonb NOT NULL CHECK(jsonb_typeof(request_payload)='object'),
  request_checksum text NOT NULL CHECK(request_checksum=encode(sha256(convert_to(request_payload::text,'UTF8')),'hex')),
  artifact_bytes bytea,
  artifact_checksum text GENERATED ALWAYS AS (encode(sha256(artifact_bytes),'hex')) STORED,
  manifest_bytes bytea,
  manifest_checksum text GENERATED ALWAYS AS (encode(sha256(manifest_bytes),'hex')) STORED,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  acceptance_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
  window_from timestamptz, window_to timestamptz,
  expected_count integer CHECK(expected_count>=0),
  sequence_from integer CHECK(sequence_from>=0), sequence_to integer CHECK(sequence_to>=sequence_from),
  imported_count integer NOT NULL CHECK(imported_count BETWEEN 0 AND 10000),
  completeness text NOT NULL CHECK(completeness IN ('PROVEN_COMPLETE','PROVEN_INCOMPLETE','UNKNOWN')),
  state text NOT NULL DEFAULT 'ACCEPTED' CHECK(state='ACCEPTED'),
  preferred_version text NOT NULL DEFAULT 'synthetic-movement-v1' REFERENCES ingestion.normalizer_version ON DELETE RESTRICT,
  CHECK((window_from IS NULL AND window_to IS NULL) OR (window_from IS NOT NULL AND window_to IS NOT NULL AND isfinite(window_from) AND isfinite(window_to) AND window_to>=window_from)),
  CHECK((sequence_from IS NULL)=(sequence_to IS NULL)),
  UNIQUE(source_account_id,batch_key), UNIQUE(id,source_account_id)
);
CREATE TABLE ingestion.source_fact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES ingestion.source_account ON DELETE RESTRICT,
  object_kind text NOT NULL CHECK(length(object_kind) BETWEEN 1 AND 512),
  external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 512),
  UNIQUE(source_account_id,object_kind,external_id), UNIQUE(id,source_account_id)
);
CREATE TABLE ingestion.revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id uuid NOT NULL REFERENCES ingestion.source_account ON DELETE RESTRICT,
  fact_id uuid,
  source_revision text CHECK(length(source_revision) BETWEEN 1 AND 512),
  payload_bytes bytea NOT NULL CHECK(octet_length(payload_bytes)<=16777216),
  checksum text GENERATED ALWAYS AS (encode(sha256(payload_bytes),'hex')) STORED,
  FOREIGN KEY(fact_id,source_account_id) REFERENCES ingestion.source_fact(id,source_account_id) ON DELETE RESTRICT,
  -- Same explicit token with changed content is retained as conflicting evidence.
  UNIQUE(id,source_account_id), UNIQUE(id,source_account_id,checksum)
);
CREATE UNIQUE INDEX revision_semantic_identity ON ingestion.revision(fact_id,coalesce(source_revision,''),checksum) WHERE fact_id IS NOT NULL;
CREATE TABLE ingestion.raw_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  source_account_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  locator text NOT NULL CHECK(length(locator) BETWEEN 1 AND 512),
  object_kind text NOT NULL CHECK(length(object_kind) BETWEEN 1 AND 512),
  external_id text CHECK(length(external_id) BETWEEN 1 AND 512),
  source_revision text CHECK(length(source_revision) BETWEEN 1 AND 512),
  payload_bytes bytea NOT NULL CHECK(octet_length(payload_bytes)<=16777216),
  checksum text GENERATED ALWAYS AS (encode(sha256(payload_bytes),'hex')) STORED,
  source_sequence integer CHECK(source_sequence>=0),
  source_observed_at timestamptz CHECK(isfinite(source_observed_at)),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  receipt_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  FOREIGN KEY(batch_id,source_account_id) REFERENCES ingestion.batch(id,source_account_id) ON DELETE RESTRICT,
  FOREIGN KEY(revision_id,source_account_id,checksum) REFERENCES ingestion.revision(id,source_account_id,checksum) ON DELETE RESTRICT,
  UNIQUE(batch_id,locator), UNIQUE(id,revision_id)
);
CREATE INDEX raw_record_revision_idx ON ingestion.raw_record(revision_id);
CREATE TABLE ingestion.interpretation (
  revision_id uuid NOT NULL REFERENCES ingestion.revision ON DELETE RESTRICT,
  normalizer_version text NOT NULL REFERENCES ingestion.normalizer_version ON DELETE RESTRICT,
  basis_raw_id uuid NOT NULL,
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  result_checksum text NOT NULL CHECK(result_checksum=encode(sha256(convert_to(result::text,'UTF8')),'hex')),
  state text NOT NULL CHECK(state IN ('NORMALIZED','FAILED')),
  failure_code text CHECK(failure_code IN ('INVALID_ENCODING','INVALID_JSON','MISSING_IDENTITY','INVALID_STRUCTURE','INVALID_MONEY','INVALID_TIMESTAMP','IDENTITY_MISMATCH','UNSUPPORTED_KIND')),
  amount_minor bigint, currency text REFERENCES ledger.currency_definition ON DELETE RESTRICT,
  occurred_at timestamptz CHECK(isfinite(occurred_at)),
  direction text CHECK(direction IN ('inflow','outflow','zero')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(revision_id,normalizer_version),
  FOREIGN KEY(basis_raw_id,revision_id) REFERENCES ingestion.raw_record(id,revision_id) ON DELETE RESTRICT,
  CHECK((state='FAILED' AND failure_code IS NOT NULL AND amount_minor IS NULL AND currency IS NULL AND occurred_at IS NULL AND direction IS NULL)
     OR (state='NORMALIZED' AND failure_code IS NULL AND amount_minor IS NOT NULL AND currency IS NOT NULL AND occurred_at IS NOT NULL AND direction IS NOT NULL)),
  CHECK((state='FAILED' AND result=jsonb_build_object('state','FAILED','code',failure_code)) OR
    (state='NORMALIZED' AND result->>'state'='NORMALIZED' AND result->'observation'->'amount'=jsonb_build_object('amountMinor',amount_minor::text,'currency',currency)
      AND result->'observation'->>'direction'=direction AND result->'observation'->>'type'='movement'
      AND result->'observation'->>'subtype' IN ('capture','fee','refund','chargeback'))),
  CHECK(state='FAILED' OR direction=CASE WHEN amount_minor>0 THEN 'inflow' WHEN amount_minor<0 THEN 'outflow' ELSE 'zero' END)
);
CREATE TABLE ingestion.processing (
  raw_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  normalizer_version text NOT NULL REFERENCES ingestion.normalizer_version ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','NORMALIZED','FAILED')),
  completed_at timestamptz,
  PRIMARY KEY(raw_id,normalizer_version),
  FOREIGN KEY(raw_id,revision_id) REFERENCES ingestion.raw_record(id,revision_id) ON DELETE RESTRICT,
  CHECK((state='PENDING' AND completed_at IS NULL) OR (state<>'PENDING' AND completed_at IS NOT NULL AND isfinite(completed_at)))
);
CREATE INDEX processing_pending_idx ON ingestion.processing(normalizer_version,raw_id) WHERE state='PENDING';
CREATE TABLE ingestion.normalization_request (
  batch_id uuid NOT NULL REFERENCES ingestion.batch ON DELETE RESTRICT,
  normalizer_version text NOT NULL REFERENCES ingestion.normalizer_version ON DELETE RESTRICT,
  actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY(batch_id,normalizer_version)
);

-- Evolve the existing append-only audit/outbox facts, preserving all Phase 1 rows and guards.
ALTER TABLE audit.audit_event ADD COLUMN batch_id uuid REFERENCES ingestion.batch ON DELETE RESTRICT,
 ADD COLUMN revision_id uuid REFERENCES ingestion.revision ON DELETE RESTRICT;
ALTER TABLE audit.audit_event DROP CONSTRAINT audit_event_action_check,
 DROP CONSTRAINT audit_event_previous_state_check, DROP CONSTRAINT audit_event_new_state_check,
 DROP CONSTRAINT audit_event_check, DROP CONSTRAINT audit_event_check1;
ALTER TABLE audit.audit_event ALTER COLUMN command_key DROP NOT NULL;
ALTER TABLE audit.audit_event ADD CHECK(num_nonnulls(account_id,journal_id,batch_id,revision_id)=1),
 ADD CHECK((account_id IS NOT NULL AND action='ledger.account_created' AND previous_state='absent' AND new_state='open' AND reversal_of IS NULL AND command_key IS NOT NULL)
 OR (journal_id IS NOT NULL AND action IN ('ledger.journal_posted','ledger.journal_reversed') AND previous_state='absent' AND new_state='posted' AND command_key IS NOT NULL AND ((action='ledger.journal_reversed')=(reversal_of IS NOT NULL)))
 OR (batch_id IS NOT NULL AND action IN ('ingestion.batch_accepted','ingestion.normalization_requested') AND previous_state='absent' AND new_state='accepted' AND reversal_of IS NULL)
 OR (revision_id IS NOT NULL AND action='ingestion.revision_observed' AND previous_state='absent' AND new_state='observed' AND reversal_of IS NULL)),
 ADD UNIQUE(batch_id,action,policy_version), ADD UNIQUE(revision_id);
ALTER TABLE outbox.outbox_event ADD COLUMN batch_id uuid REFERENCES ingestion.batch ON DELETE RESTRICT,
 ADD COLUMN normalizer_version text REFERENCES ingestion.normalizer_version ON DELETE RESTRICT;
ALTER TABLE outbox.outbox_event DROP CONSTRAINT outbox_event_event_type_check,
 DROP CONSTRAINT outbox_event_check, DROP CONSTRAINT outbox_event_check1;
ALTER TABLE outbox.outbox_event ALTER COLUMN command_key DROP NOT NULL;
ALTER TABLE outbox.outbox_event ADD CHECK(num_nonnulls(account_id,journal_id,batch_id)=1),
 ADD CHECK(payload @> jsonb_build_object('bookId',book_id) AND
 ((account_id IS NOT NULL AND event_type='ledger.account_created' AND payload @> jsonb_build_object('accountId',account_id) AND command_key IS NOT NULL AND normalizer_version IS NULL)
 OR (journal_id IS NOT NULL AND event_type IN ('ledger.journal_posted','ledger.journal_reversed') AND payload @> jsonb_build_object('journalId',journal_id) AND command_key IS NOT NULL AND normalizer_version IS NULL)
 OR (batch_id IS NOT NULL AND event_type='ingestion.normalization_requested' AND normalizer_version IS NOT NULL AND payload @> jsonb_build_object('batchId',batch_id,'normalizerVersion',normalizer_version)))),
 ADD UNIQUE(batch_id,normalizer_version);

CREATE FUNCTION ingestion.guard_raw() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE rev ingestion.revision%ROWTYPE; f ingestion.source_fact%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT FROM ingestion.batch WHERE id=NEW.batch_id AND acceptance_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Accepted batch population is sealed'; END IF;
 SELECT * INTO STRICT rev FROM ingestion.revision WHERE id=NEW.revision_id;
 IF rev.payload_bytes<>NEW.payload_bytes OR rev.source_revision IS DISTINCT FROM NEW.source_revision THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Raw revision provenance mismatch'; END IF;
 IF rev.fact_id IS NOT NULL THEN
  SELECT * INTO STRICT f FROM ingestion.source_fact WHERE id=rev.fact_id;
  IF f.external_id IS DISTINCT FROM NEW.external_id OR f.object_kind<>NEW.object_kind THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Source identity mismatch'; END IF;
 ELSIF NEW.external_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Missing source fact'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER raw_provenance BEFORE INSERT ON ingestion.raw_record FOR EACH ROW EXECUTE FUNCTION ingestion.guard_raw();
CREATE FUNCTION ingestion.guard_processing() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE result_state text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Processing evidence cannot be deleted'; END IF;
 IF TG_OP='UPDATE' AND (OLD.state<>'PENDING' OR NEW.state='PENDING' OR (to_jsonb(NEW)-ARRAY['state','completed_at'])<>(to_jsonb(OLD)-ARRAY['state','completed_at'])) THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Illegal processing transition'; END IF;
 IF NEW.state<>'PENDING' THEN
  SELECT state INTO result_state FROM ingestion.interpretation WHERE revision_id=NEW.revision_id AND normalizer_version=NEW.normalizer_version;
  IF result_state IS DISTINCT FROM NEW.state THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Processing result missing'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER processing_transition BEFORE INSERT OR UPDATE OR DELETE ON ingestion.processing FOR EACH ROW EXECUTE FUNCTION ingestion.guard_processing();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['source','source_account','normalizer_version','batch','source_fact','revision','raw_record','interpretation','normalization_request'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON ingestion.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['source','source_account','normalizer_version','batch','source_fact','revision','raw_record','interpretation','normalization_request','processing'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ingestion.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
END $$;

CREATE FUNCTION ingestion.coverage(b uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN expected_count IS NULL AND sequence_from IS NULL THEN 'UNKNOWN'
 WHEN (expected_count IS NOT NULL AND expected_count<>(SELECT count(*) FROM ingestion.raw_record WHERE batch_id=b))
 OR (sequence_from IS NOT NULL AND (
   (SELECT count(*) FROM ingestion.raw_record WHERE batch_id=b) <> sequence_to::bigint-sequence_from+1
   OR (SELECT count(DISTINCT source_sequence) FROM ingestion.raw_record WHERE batch_id=b AND source_sequence BETWEEN sequence_from AND sequence_to) <> sequence_to::bigint-sequence_from+1))
 THEN 'PROVEN_INCOMPLETE' ELSE 'PROVEN_COMPLETE' END FROM ingestion.batch WHERE id=b
$$;
CREATE FUNCTION ingestion.validate_batch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE b ingestion.batch%ROWTYPE; bid uuid;
BEGIN
 bid:=NEW.id;
 SELECT * INTO STRICT b FROM ingestion.batch WHERE id=bid FOR UPDATE;
 IF b.imported_count<>(SELECT count(*) FROM ingestion.raw_record WHERE batch_id=bid)
 OR b.completeness<>ingestion.coverage(bid)
 OR EXISTS(SELECT FROM ingestion.raw_record r WHERE r.batch_id=bid AND NOT EXISTS(SELECT FROM ingestion.processing p WHERE p.raw_id=r.id AND p.normalizer_version=b.preferred_version))
 OR NOT EXISTS(SELECT FROM audit.audit_event a JOIN ingestion.source_account s ON s.book_id=a.book_id WHERE s.id=b.source_account_id AND a.batch_id=bid AND a.action='ingestion.batch_accepted')
 OR NOT EXISTS(SELECT FROM outbox.outbox_event o WHERE o.batch_id=bid AND o.normalizer_version=b.preferred_version)
 THEN RAISE EXCEPTION USING ERRCODE='P2004',MESSAGE='Batch completeness/provenance/intent invariant'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER batch_commit_guard AFTER INSERT ON ingestion.batch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ingestion.validate_batch();

CREATE FUNCTION ingestion.validate_request() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE expected_book uuid;
BEGIN
 SELECT s.book_id INTO STRICT expected_book FROM ingestion.batch b JOIN ingestion.source_account s ON s.id=b.source_account_id WHERE b.id=NEW.batch_id;
 IF (SELECT count(*) FROM ingestion.processing p JOIN ingestion.raw_record r ON r.id=p.raw_id WHERE r.batch_id=NEW.batch_id AND p.normalizer_version=NEW.normalizer_version)
 <> (SELECT imported_count FROM ingestion.batch WHERE id=NEW.batch_id)
 OR NOT EXISTS(SELECT FROM audit.audit_event a WHERE a.batch_id=NEW.batch_id AND a.book_id=expected_book AND a.action='ingestion.normalization_requested' AND a.policy_version=NEW.normalizer_version)
 OR NOT EXISTS(SELECT FROM outbox.outbox_event o WHERE o.batch_id=NEW.batch_id AND o.book_id=expected_book AND o.normalizer_version=NEW.normalizer_version)
 THEN RAISE EXCEPTION USING ERRCODE='P2004',MESSAGE='Normalization request lacks dispositions/audit/outbox'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER request_commit_guard AFTER INSERT ON ingestion.normalization_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ingestion.validate_request();
CREATE FUNCTION ingestion.guard_interpretation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r ingestion.raw_record%ROWTYPE; o jsonb:=NEW.result->'observation';
BEGIN
 SELECT * INTO STRICT r FROM ingestion.raw_record WHERE id=NEW.basis_raw_id AND revision_id=NEW.revision_id;
 IF NEW.state='NORMALIZED' AND (
   o IS NULL OR jsonb_typeof(o)<>'object' OR o->>'externalId' IS DISTINCT FROM r.external_id OR r.external_id IS NULL
   OR o->>'occurredAt' IS NULL OR o->>'occurredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
   OR to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM o->>'occurredAt'
   OR o->>'reference' IS NULL OR length(o->>'reference') NOT BETWEEN 1 AND 512
   OR NOT (o ? 'parentReference') OR (o->'parentReference'<>'null'::jsonb AND jsonb_typeof(o->'parentReference')<>'string')
   OR NEW.result->>'state' IS DISTINCT FROM NEW.state
   OR o->'amount' IS DISTINCT FROM jsonb_build_object('amountMinor',NEW.amount_minor::text,'currency',NEW.currency)
   OR o->>'type' IS DISTINCT FROM 'movement'
   OR o->>'subtype' IS NULL OR o->>'subtype' NOT IN ('capture','fee','refund','chargeback')
   OR o->>'direction' IS DISTINCT FROM NEW.direction
   OR (SELECT count(*) FROM jsonb_object_keys(o))<>8
   OR (SELECT count(*) FROM jsonb_object_keys(NEW.result))<>2
 ) THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Invalid normalized provenance/representation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER interpretation_provenance BEFORE INSERT ON ingestion.interpretation FOR EACH ROW EXECUTE FUNCTION ingestion.guard_interpretation();
CREATE FUNCTION ingestion.guard_companion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE expected_book uuid;
BEGIN
 IF NEW.batch_id IS NOT NULL THEN
  SELECT s.book_id INTO STRICT expected_book FROM ingestion.batch b JOIN ingestion.source_account s ON s.id=b.source_account_id WHERE b.id=NEW.batch_id;
 ELSIF TG_TABLE_SCHEMA='audit' AND (to_jsonb(NEW)->>'revision_id') IS NOT NULL THEN
  SELECT s.book_id INTO STRICT expected_book FROM ingestion.revision r JOIN ingestion.source_account s ON s.id=r.source_account_id WHERE r.id=(to_jsonb(NEW)->>'revision_id')::uuid;
 ELSE RETURN NEW;
 END IF;
 IF NEW.book_id<>expected_book THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Cross-book ingestion companion'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ingestion_audit_scope BEFORE INSERT ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION ingestion.guard_companion();
CREATE TRIGGER ingestion_outbox_scope BEFORE INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION ingestion.guard_companion();

CREATE FUNCTION ingestion.register_source(p jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE sid uuid; aid uuid;
BEGIN
 IF NOT EXISTS(SELECT FROM ledger.book WHERE id=(p->>'bookId')::uuid AND environment=p->>'environment') THEN RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='Book/environment mismatch'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('source:'||(p->>'bookId')||':'||(p->>'environment')||':'||(p->>'provider'),0));
 INSERT INTO ingestion.source(book_id,environment,provider) VALUES((p->>'bookId')::uuid,p->>'environment',p->>'provider') ON CONFLICT DO NOTHING;
 SELECT id INTO STRICT sid FROM ingestion.source WHERE book_id=(p->>'bookId')::uuid AND environment=p->>'environment' AND provider=p->>'provider';
 INSERT INTO ingestion.source_account(source_id,book_id,external_account_id) VALUES(sid,(p->>'bookId')::uuid,p->>'externalAccountId') ON CONFLICT DO NOTHING;
 SELECT id INTO STRICT aid FROM ingestion.source_account WHERE source_id=sid AND external_account_id=p->>'externalAccountId';
 RETURN aid;
END $$;
CREATE FUNCTION ingestion.request_normalization(b uuid,v text,actor text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE bid uuid; inserted integer;
BEGIN
 PERFORM 1 FROM ingestion.batch WHERE id=b FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='Batch not found'; END IF;
 SELECT s.book_id INTO STRICT bid FROM ingestion.batch x JOIN ingestion.source_account s ON x.source_account_id=s.id WHERE x.id=b;
 INSERT INTO ingestion.normalization_request VALUES(b,v,actor,transaction_timestamp()) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 INSERT INTO ingestion.processing(raw_id,revision_id,normalizer_version) SELECT id,revision_id,v FROM ingestion.raw_record WHERE batch_id=b ON CONFLICT DO NOTHING;
 IF inserted=1 THEN
  INSERT INTO audit.audit_event(book_id,batch_id,action,actor_id,previous_state,new_state,reason,policy_version) VALUES(bid,b,'ingestion.normalization_requested',actor,'absent','accepted','Explicit versioned normalization request',v);
  INSERT INTO outbox.outbox_event(book_id,batch_id,event_type,normalizer_version,aggregate_version,schema_version,payload) VALUES(bid,b,'ingestion.normalization_requested',v,1,1,jsonb_build_object('bookId',bid,'batchId',b,'normalizerVersion',v));
 END IF;
END $$;
CREATE FUNCTION ingestion.accept_batch(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE aid uuid:=(p->>'sourceAccountId')::uuid; bid uuid; book uuid; old ingestion.batch%ROWTYPE;
 r jsonb; fid uuid; rid uuid; bytes bytea; ch text; n integer; coverage text; fingerprint jsonb:=p-'actorId';
BEGIN
 -- Scope-local lock: serializes revision decisions and avoids unordered multi-fact deadlocks.
 PERFORM 1 FROM ingestion.source_account WHERE id=aid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='Source account not found'; END IF;
 SELECT * INTO old FROM ingestion.batch WHERE source_account_id=aid AND batch_key=p->>'batchKey';
 IF FOUND THEN
  IF old.request_payload<>fingerprint THEN RAISE EXCEPTION USING ERRCODE='P2001',MESSAGE='Batch identity conflict'; END IF;
  RETURN jsonb_build_object('id',old.id,'replayed',true);
 END IF;
 n:=jsonb_array_length(p->'records');
 IF n>10000 THEN RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='Batch exceeds Phase 3 limit'; END IF;
 SELECT book_id INTO STRICT book FROM ingestion.source_account WHERE id=aid;
 -- Calculate coverage from supplied independent evidence and physical locators/sequences.
 coverage:=CASE WHEN p->>'expectedCount' IS NULL AND p->'expectedSequence'->>'from' IS NULL THEN 'UNKNOWN'
 WHEN (p->>'expectedCount' IS NOT NULL AND (p->>'expectedCount')::integer<>n)
 OR (p->'expectedSequence'->>'from' IS NOT NULL AND (
 n<>(p->'expectedSequence'->>'to')::bigint-(p->'expectedSequence'->>'from')::bigint+1
 OR (SELECT count(DISTINCT (x->>'sequence')::integer) FROM jsonb_array_elements(p->'records') x WHERE (x->>'sequence')::integer BETWEEN (p->'expectedSequence'->>'from')::integer AND (p->'expectedSequence'->>'to')::integer)<>n))
 THEN 'PROVEN_INCOMPLETE' ELSE 'PROVEN_COMPLETE' END;
 INSERT INTO ingestion.batch(source_account_id,batch_key,request_payload,request_checksum,artifact_bytes,manifest_bytes,window_from,window_to,expected_count,sequence_from,sequence_to,imported_count,completeness)
 VALUES(aid,p->>'batchKey',fingerprint,encode(sha256(convert_to(fingerprint::text,'UTF8')),'hex'),decode(p->>'artifactHex','hex'),decode(p->>'manifestHex','hex'),(p->'window'->>'from')::timestamptz,(p->'window'->>'to')::timestamptz,(p->>'expectedCount')::integer,(p->'expectedSequence'->>'from')::integer,(p->'expectedSequence'->>'to')::integer,n,coverage) RETURNING id INTO bid;
 FOR r IN SELECT value FROM jsonb_array_elements(p->'records') LOOP
  bytes:=decode(r->>'bytesHex','hex'); ch:=encode(sha256(bytes),'hex'); fid:=NULL; rid:=NULL;
  IF r->>'externalId' IS NOT NULL THEN
   INSERT INTO ingestion.source_fact(source_account_id,object_kind,external_id) VALUES(aid,r->>'objectKind',r->>'externalId') ON CONFLICT DO NOTHING;
   SELECT id INTO STRICT fid FROM ingestion.source_fact WHERE source_account_id=aid AND object_kind=r->>'objectKind' AND external_id=r->>'externalId';
   SELECT id INTO rid FROM ingestion.revision WHERE fact_id=fid AND source_revision IS NOT DISTINCT FROM r->>'sourceRevision' AND checksum=ch;
  END IF;
  IF rid IS NULL THEN
   INSERT INTO ingestion.revision(source_account_id,fact_id,source_revision,payload_bytes) VALUES(aid,fid,r->>'sourceRevision',bytes) RETURNING id INTO rid;
   IF fid IS NOT NULL AND (SELECT count(*) FROM ingestion.revision WHERE fact_id=fid)>1 THEN
    INSERT INTO audit.audit_event(book_id,revision_id,action,actor_id,previous_state,new_state,reason,policy_version) VALUES(book,rid,'ingestion.revision_observed',p->>'actorId','absent','observed','Changed source evidence retained; active revision unresolved','ingestion-v1');
   END IF;
  ELSIF (SELECT payload_bytes FROM ingestion.revision WHERE id=rid)<>bytes THEN RAISE EXCEPTION USING ERRCODE='P2001',MESSAGE='Checksum collision'; END IF;
  INSERT INTO ingestion.raw_record(batch_id,source_account_id,revision_id,locator,object_kind,external_id,source_revision,payload_bytes,source_sequence,source_observed_at)
  VALUES(bid,aid,rid,r->>'locator',r->>'objectKind',r->>'externalId',r->>'sourceRevision',bytes,(r->>'sequence')::integer,(r->>'sourceObservedAt')::timestamptz);
 END LOOP;
 INSERT INTO audit.audit_event(book_id,batch_id,action,actor_id,previous_state,new_state,reason,policy_version) VALUES(book,bid,'ingestion.batch_accepted',p->>'actorId','absent','accepted','Immutable source acquisition accepted','ingestion-v1');
 PERFORM ingestion.request_normalization(bid,'synthetic-movement-v1',p->>'actorId');
 RETURN jsonb_build_object('id',bid,'replayed',false);
END $$;

CREATE FUNCTION ingestion.complete_normalization(raw uuid,v text,res jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r ingestion.raw_record%ROWTYPE; prior ingestion.interpretation%ROWTYPE; o jsonb:=res->'observation'; result_state text:=res->>'state';
BEGIN
 SELECT * INTO STRICT r FROM ingestion.raw_record WHERE id=raw;
 -- Revision lock also arbitrates different physical receipts for one fact/version.
 PERFORM 1 FROM ingestion.revision WHERE id=r.revision_id FOR UPDATE;
 IF NOT EXISTS(SELECT FROM ingestion.processing WHERE raw_id=raw AND normalizer_version=v) THEN RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='Normalization not requested'; END IF;
 SELECT * INTO prior FROM ingestion.interpretation WHERE revision_id=r.revision_id AND normalizer_version=v;
 IF FOUND THEN
  IF prior.result<>res THEN RAISE EXCEPTION USING ERRCODE='P2001',MESSAGE='Same normalizer version changed interpretation'; END IF;
 ELSE
  IF result_state='NORMALIZED' AND (o->>'externalId' IS DISTINCT FROM r.external_id OR o->>'occurredAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') THEN RAISE EXCEPTION USING ERRCODE='P2002',MESSAGE='Interpretation provenance/time mismatch'; END IF;
  INSERT INTO ingestion.interpretation(revision_id,normalizer_version,basis_raw_id,result,result_checksum,state,failure_code,amount_minor,currency,occurred_at,direction)
  VALUES(r.revision_id,v,raw,res,encode(sha256(convert_to(res::text,'UTF8')),'hex'),result_state,res->>'code',(o->'amount'->>'amountMinor')::bigint,o->'amount'->>'currency',(o->>'occurredAt')::timestamptz,o->>'direction');
 END IF;
 UPDATE ingestion.processing SET state=result_state,completed_at=transaction_timestamp() WHERE raw_id=raw AND normalizer_version=v AND processing.state='PENDING';
 RETURN res;
END $$;

CREATE VIEW ingestion.fact_status AS
 SELECT f.*, (SELECT r.revision_id FROM ingestion.raw_record r JOIN ingestion.revision v ON v.id=r.revision_id WHERE v.fact_id=f.id ORDER BY r.receipt_order DESC LIMIT 1) AS latest_received_revision_id,
 CASE WHEN (SELECT count(*) FROM ingestion.revision v WHERE v.fact_id=f.id)=1 THEN (SELECT v.id FROM ingestion.revision v WHERE v.fact_id=f.id) ELSE NULL END AS active_revision_id,
 CASE WHEN (SELECT count(*) FROM ingestion.revision v WHERE v.fact_id=f.id)>1 THEN 'REVIEW_REQUIRED' ELSE 'UNAMBIGUOUS' END AS revision_state,
 EXISTS(SELECT FROM ingestion.revision v WHERE v.fact_id=f.id AND v.source_revision IS NOT NULL GROUP BY v.source_revision HAVING count(*)>1) AS conflicting_source_token
 FROM ingestion.source_fact f;

REVOKE ALL ON ALL TABLES IN SCHEMA ingestion FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ingestion FROM PUBLIC;
GRANT USAGE ON SCHEMA ingestion TO flow_ingestion_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO flow_ingestion_reader;
GRANT EXECUTE ON FUNCTION ingestion.register_source(jsonb),ingestion.accept_batch(jsonb),ingestion.request_normalization(uuid,text,text),ingestion.complete_normalization(uuid,text,jsonb) TO flow_ingestion_writer;
GRANT USAGE ON SCHEMA audit,outbox TO flow_ingestion_reader;
GRANT SELECT ON audit.audit_event,outbox.outbox_event TO flow_ingestion_reader;
RESET ROLE;
