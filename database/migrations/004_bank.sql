-- Phase 5: bank claims and bank-internal controls only. No processor or ledger writes.
RESET ROLE;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['flow_bank_reader','flow_bank_writer'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r); END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe bank capability role'; END IF;
 END LOOP;
END $$;
GRANT flow_bank_reader TO flow_bank_writer;
GRANT flow_ingestion_reader TO flow_bank_reader;
CREATE SCHEMA bank AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA bank FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
INSERT INTO ingestion.normalizer_version VALUES
 ('synthetic-bank-entry-v1','Booked synthetic signed source flow; explicit bank magnitude/direction; optional UTC value date and source time; observation-only identity permitted'),
 ('synthetic-bank-statement-v1','Independent synthetic statement assertions; optional signed stocks/count/line identities/sequence; unknown is null');
-- Extend only typed shape checks. Historical movement/settlement contracts and guards remain intact.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='ingestion.interpretation'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%subtype%' OR pg_get_constraintdef(oid) LIKE '%amount_minor IS NOT NULL%') LOOP
  EXECUTE format('ALTER TABLE ingestion.interpretation DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE ingestion.interpretation ADD CHECK ((
 (state='FAILED' AND failure_code IS NOT NULL AND amount_minor IS NULL AND currency IS NULL AND occurred_at IS NULL AND direction IS NULL AND result=jsonb_build_object('state','FAILED','code',failure_code)) OR
 (state='NORMALIZED' AND failure_code IS NULL AND currency IS NOT NULL AND occurred_at IS NOT NULL AND result->>'state'='NORMALIZED' AND
 ((normalizer_version IN ('synthetic-movement-v1','synthetic-movement-v2','synthetic-settlement-v1','synthetic-bank-entry-v1') AND amount_minor IS NOT NULL AND direction IS NOT NULL
 AND result->'observation'->'amount'=jsonb_build_object('amountMinor',amount_minor::text,'currency',currency) AND result->'observation'->>'direction'=direction
 AND ((normalizer_version IN ('synthetic-movement-v1','synthetic-movement-v2') AND result->'observation'->>'type'='movement' AND result->'observation'->>'subtype' IN ('capture','fee','refund','chargeback'))
 OR (normalizer_version='synthetic-settlement-v1' AND result->'observation'->>'type'='settlement')
 OR (normalizer_version='synthetic-bank-entry-v1' AND result->'observation'->>'type'='bank-entry')))
 OR (normalizer_version='synthetic-bank-statement-v1' AND direction IS NULL AND result->'observation'->>'type'='bank-statement'
 AND result->'observation'->>'currency'=currency AND result->'observation'->'amount' IS NOT DISTINCT FROM
 (CASE WHEN amount_minor IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('amountMinor',amount_minor::text,'currency',currency) END))))) IS TRUE);
CREATE FUNCTION bank.valid_money(m jsonb,c text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT m='null'::jsonb OR (jsonb_typeof(m)='object' AND m->>'currency'=c AND m->>'amountMinor' ~ '^(0|[1-9][0-9]*|-[1-9][0-9]*)$'
 AND length(m->>'amountMinor')<=20 AND (m->>'amountMinor')::numeric BETWEEN -9223372036854775808 AND 9223372036854775807
 AND m=jsonb_build_object('amountMinor',m->>'amountMinor','currency',c))
$$;
CREATE FUNCTION bank.valid_time(t text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT t ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' AND t !~ '^0000-' AND to_char(t::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=t
$$;
CREATE FUNCTION bank.guard_normalized() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r ingestion.raw_record%ROWTYPE; o jsonb:=NEW.result->'observation';
BEGIN
 SELECT * INTO STRICT r FROM ingestion.raw_record WHERE id=NEW.basis_raw_id AND revision_id=NEW.revision_id;
 IF NEW.result->>'state' IS DISTINCT FROM 'NORMALIZED' OR (SELECT count(*) FROM jsonb_object_keys(NEW.result))<>2
 OR (SELECT count(*) FROM jsonb_object_keys(o))<>12 OR o->'externalId' IS DISTINCT FROM (CASE WHEN r.external_id IS NULL THEN 'null'::jsonb ELSE to_jsonb(r.external_id) END)
 OR bank.valid_time(o->>'occurredAt') IS DISTINCT FROM true OR NEW.occurred_at IS DISTINCT FROM (o->>'occurredAt')::timestamptz
 THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Invalid normalized bank provenance/time'; END IF;
 IF NEW.normalizer_version='synthetic-bank-entry-v1' THEN
  IF r.object_kind<>'synthetic-bank-entry' OR o->>'type' IS DISTINCT FROM 'bank-entry' OR NEW.amount_minor=0 OR NEW.amount_minor=-9223372036854775808
  OR NOT (o ?& ARRAY['type','externalId','amount','occurredAt','direction','sourceOccurredAt','valueDate','bankReference','statementReference','lineIdentity','sequence','runningBalance'])
  OR o->'amount' IS DISTINCT FROM jsonb_build_object('amountMinor',NEW.amount_minor::text,'currency',NEW.currency)
  OR o->>'direction' IS DISTINCT FROM NEW.direction
  OR (o->>'sourceOccurredAt' IS NOT NULL AND bank.valid_time(o->>'sourceOccurredAt') IS DISTINCT FROM true)
  OR (o->>'valueDate' IS NOT NULL AND (o->>'valueDate' !~ '^\d{4}-\d{2}-\d{2}$' OR bank.valid_time((o->>'valueDate')||'T00:00:00.000Z') IS DISTINCT FROM true))
  OR EXISTS(SELECT FROM unnest(ARRAY['bankReference','statementReference','lineIdentity']) k WHERE o->k<>'null'::jsonb AND (jsonb_typeof(o->k)<>'string' OR length(o->>k) NOT BETWEEN 1 AND 512))
  OR (o->>'sequence' IS NOT NULL AND (jsonb_typeof(o->'sequence')<>'number' OR o->>'sequence' !~ '^(0|[1-9][0-9]*)$' OR (o->>'sequence')::numeric>2147483647))
  OR (o->>'statementReference' IS NULL AND (o->>'lineIdentity' IS NOT NULL OR o->>'sequence' IS NOT NULL))
  OR bank.valid_money(o->'runningBalance',NEW.currency) IS DISTINCT FROM true
  THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Invalid normalized bank entry'; END IF;
 ELSE
  IF r.object_kind<>'synthetic-bank-statement' OR r.external_id IS NULL OR o->>'type' IS DISTINCT FROM 'bank-statement'
  OR NOT (o ?& ARRAY['type','externalId','amount','currency','occurredAt','direction','period','opening','closing','expectedLineCount','lineIds','sequenceRange'])
  OR o->'direction' IS DISTINCT FROM 'null'::jsonb OR o->>'currency' IS DISTINCT FROM NEW.currency OR o->'amount' IS DISTINCT FROM o->'closing'
  OR bank.valid_money(o->'opening',NEW.currency) IS DISTINCT FROM true OR bank.valid_money(o->'closing',NEW.currency) IS DISTINCT FROM true
  OR (o->'period'<>'null'::jsonb AND (bank.valid_time(o->'period'->>'from') IS DISTINCT FROM true OR bank.valid_time(o->'period'->>'to') IS DISTINCT FROM true OR (SELECT count(*) FROM jsonb_object_keys(o->'period'))<>2))
  OR (o->>'expectedLineCount' IS NOT NULL AND (jsonb_typeof(o->'expectedLineCount')<>'number' OR o->>'expectedLineCount' !~ '^(0|[1-9][0-9]*)$' OR (o->>'expectedLineCount')::numeric>2147483647))
  OR (o->'lineIds'<>'null'::jsonb AND (jsonb_typeof(o->'lineIds')<>'array' OR jsonb_array_length(o->'lineIds')>10000 OR EXISTS(SELECT FROM jsonb_array_elements(o->'lineIds') x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 512)))
  OR (o->'sequenceRange'<>'null'::jsonb AND ((SELECT count(*) FROM jsonb_object_keys(o->'sequenceRange'))<>2 OR EXISTS(SELECT FROM unnest(ARRAY['from','to']) k WHERE jsonb_typeof(o->'sequenceRange'->k) IS DISTINCT FROM 'number' OR o->'sequenceRange'->>k !~ '^(0|[1-9][0-9]*)$' OR (o->'sequenceRange'->>k)::numeric>2147483647)))
  THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Invalid normalized bank statement'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- The dispatcher calls the new guard only for the new versions; old guards execute unchanged.
DROP TRIGGER interpretation_provenance ON ingestion.interpretation;
CREATE TRIGGER interpretation_provenance BEFORE INSERT ON ingestion.interpretation FOR EACH ROW
 WHEN (NEW.normalizer_version NOT IN ('synthetic-bank-entry-v1','synthetic-bank-statement-v1') OR NEW.state='FAILED') EXECUTE FUNCTION ingestion.guard_interpretation();
CREATE TRIGGER bank_interpretation_provenance BEFORE INSERT ON ingestion.interpretation FOR EACH ROW
 WHEN (NEW.normalizer_version IN ('synthetic-bank-entry-v1','synthetic-bank-statement-v1') AND NEW.state='NORMALIZED') EXECUTE FUNCTION bank.guard_normalized();
-- Keep completion semantics; only the new statement's nullable stock projection needs explicit currency.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('ingestion.complete_normalization(uuid,text,jsonb)'::regprocedure) INTO definition;
 definition:=replace(definition, 'o -> ''amount''::text ->> ''currency''::text', 'coalesce(o -> ''amount''::text ->> ''currency''::text, o ->> ''currency''::text)');
 -- pg_get_functiondef retains the original PL/pgSQL source spelling.
 definition:=replace(definition, 'o->''amount''->>''currency''', 'coalesce(o->''amount''->>''currency'',o->>''currency'')');
 EXECUTE definition;
END $$;

CREATE TABLE bank.interpreter_version(version text PRIMARY KEY,contract text NOT NULL);
INSERT INTO bank.interpreter_version VALUES('bank-v1','Booked bank claims, scoped observation identities, optional statement stocks, conservative revisions and immutable as-of controls');
CREATE TABLE bank.account (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_account_id uuid NOT NULL REFERENCES ingestion.source_account ON DELETE RESTRICT,
 currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 UNIQUE(source_account_id,currency), UNIQUE(id,source_account_id,currency)
);
CREATE TABLE bank.statement_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_account_id uuid NOT NULL REFERENCES ingestion.source_account ON DELETE RESTRICT,
 external_statement_reference text NOT NULL CHECK(length(external_statement_reference) BETWEEN 1 AND 512),
 UNIQUE(source_account_id,external_statement_reference), UNIQUE(id,source_account_id)
);
CREATE TABLE bank.derivation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL, normalizer_version text NOT NULL,
 interpreter_version text NOT NULL REFERENCES bank.interpreter_version ON DELETE RESTRICT,
 source_account_id uuid NOT NULL, fact_id uuid, account_id uuid NOT NULL, currency text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('entry','statement')), identity_kind text NOT NULL CHECK(identity_kind IN ('SOURCE_ID','OBSERVATION_ONLY')),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(revision_id,normalizer_version) REFERENCES ingestion.interpretation ON DELETE RESTRICT,
 FOREIGN KEY(revision_id,source_account_id) REFERENCES ingestion.revision(id,source_account_id) ON DELETE RESTRICT,
 FOREIGN KEY(fact_id,source_account_id) REFERENCES ingestion.source_fact(id,source_account_id) ON DELETE RESTRICT,
 FOREIGN KEY(account_id,source_account_id,currency) REFERENCES bank.account(id,source_account_id,currency) ON DELETE RESTRICT,
 CHECK((fact_id IS NULL)=(identity_kind='OBSERVATION_ONLY')), CHECK(kind='entry' OR fact_id IS NOT NULL),
 UNIQUE(revision_id,normalizer_version,interpreter_version), UNIQUE(id,source_account_id), UNIQUE(id,source_account_id,currency)
);
CREATE TABLE bank.entry (
 id uuid PRIMARY KEY, source_account_id uuid NOT NULL, currency text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0), direction text NOT NULL CHECK(direction IN ('CREDIT','DEBIT')),
 booked_at timestamptz NOT NULL CHECK(isfinite(booked_at)), source_occurred_at timestamptz CHECK(isfinite(source_occurred_at)), value_date date CHECK(isfinite(value_date)),
 bank_reference text CHECK(length(bank_reference) BETWEEN 1 AND 512),
 FOREIGN KEY(id,source_account_id,currency) REFERENCES bank.derivation(id,source_account_id,currency) ON DELETE RESTRICT,
 UNIQUE(id,source_account_id)
);
CREATE TABLE bank.statement (
 id uuid PRIMARY KEY, source_account_id uuid NOT NULL, currency text NOT NULL, group_id uuid NOT NULL,
 reported_at timestamptz NOT NULL CHECK(isfinite(reported_at)), period_from timestamptz CHECK(isfinite(period_from)), period_to timestamptz CHECK(isfinite(period_to)),
 expected_line_count integer CHECK(expected_line_count>=0), sequence_from integer CHECK(sequence_from>=0), sequence_to integer CHECK(sequence_to>=0),
 line_references_supplied boolean NOT NULL, declared_reference_count integer NOT NULL CHECK(declared_reference_count BETWEEN 0 AND 10000),
 CHECK((period_from IS NULL)=(period_to IS NULL)), CHECK((sequence_from IS NULL)=(sequence_to IS NULL)),
 FOREIGN KEY(id,source_account_id,currency) REFERENCES bank.derivation(id,source_account_id,currency) ON DELETE RESTRICT,
 FOREIGN KEY(group_id,source_account_id) REFERENCES bank.statement_group(id,source_account_id) ON DELETE RESTRICT,
 UNIQUE(id,source_account_id)
);
CREATE TABLE bank.membership (
 entry_id uuid PRIMARY KEY, source_account_id uuid NOT NULL, group_id uuid NOT NULL,
 line_identity text CHECK(length(line_identity) BETWEEN 1 AND 512), source_sequence integer CHECK(source_sequence>=0),
 FOREIGN KEY(entry_id,source_account_id) REFERENCES bank.entry(id,source_account_id) ON DELETE RESTRICT,
 FOREIGN KEY(group_id,source_account_id) REFERENCES bank.statement_group(id,source_account_id) ON DELETE RESTRICT
);
CREATE INDEX bank_membership_group_idx ON bank.membership(group_id);
CREATE TABLE bank.statement_reference (
 statement_id uuid NOT NULL REFERENCES bank.statement ON DELETE RESTRICT, ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 10000),
 line_identity text NOT NULL CHECK(length(line_identity) BETWEEN 1 AND 512), PRIMARY KEY(statement_id,ordinal)
);
CREATE TABLE bank.balance_observation (
 derivation_id uuid NOT NULL, source_account_id uuid NOT NULL, currency text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('OPENING','CLOSING','RUNNING')), amount_minor bigint NOT NULL,
 effective_at timestamptz CHECK(isfinite(effective_at)), PRIMARY KEY(derivation_id,kind),
 FOREIGN KEY(derivation_id,source_account_id,currency) REFERENCES bank.derivation(id,source_account_id,currency) ON DELETE RESTRICT
);
CREATE TABLE bank.evaluation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), statement_id uuid NOT NULL, source_account_id uuid NOT NULL,
 evaluation_key text NOT NULL CHECK(length(evaluation_key) BETWEEN 1 AND 512), interpreter_version text NOT NULL REFERENCES bank.interpreter_version ON DELETE RESTRICT,
 input jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 FOREIGN KEY(statement_id,source_account_id) REFERENCES bank.statement(id,source_account_id) ON DELETE RESTRICT,
 CHECK(jsonb_typeof(input)='object' AND jsonb_typeof(result)='object' AND jsonb_typeof(result->'controls')='array'),
 CHECK(result->>'completeness' IN ('UNKNOWN','PROVEN_COMPLETE','PROVEN_INCOMPLETE')),
 UNIQUE(statement_id,evaluation_key)
);
CREATE TABLE bank.evaluation_entry (
 evaluation_id uuid NOT NULL REFERENCES bank.evaluation ON DELETE RESTRICT, entry_id uuid NOT NULL REFERENCES bank.entry ON DELETE RESTRICT,
 PRIMARY KEY(evaluation_id,entry_id)
);

CREATE FUNCTION bank.guard_derivation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i ingestion.interpretation%ROWTYPE; r ingestion.revision%ROWTYPE;
BEGIN
 SELECT * INTO STRICT i FROM ingestion.interpretation WHERE revision_id=NEW.revision_id AND normalizer_version=NEW.normalizer_version;
 SELECT * INTO STRICT r FROM ingestion.revision WHERE id=NEW.revision_id;
 IF i.state<>'NORMALIZED' OR r.fact_id IS DISTINCT FROM NEW.fact_id OR i.currency IS DISTINCT FROM NEW.currency
 OR NEW.kind IS DISTINCT FROM (CASE i.result->'observation'->>'type' WHEN 'bank-entry' THEN 'entry' WHEN 'bank-statement' THEN 'statement' END)
 THEN RAISE EXCEPTION USING ERRCODE='P5002',MESSAGE='Bank input provenance mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER derivation_provenance BEFORE INSERT ON bank.derivation FOR EACH ROW EXECUTE FUNCTION bank.guard_derivation();
CREATE FUNCTION bank.guard_projection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d bank.derivation%ROWTYPE; i ingestion.interpretation%ROWTYPE; o jsonb; valid boolean;
BEGIN
 SELECT * INTO STRICT d FROM bank.derivation WHERE id=NEW.id;
 SELECT * INTO STRICT i FROM ingestion.interpretation WHERE revision_id=d.revision_id AND normalizer_version=d.normalizer_version;
 o:=i.result->'observation';
 IF d.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION USING ERRCODE='P5003',MESSAGE='Bank population sealed'; END IF;
 IF TG_TABLE_NAME='entry' THEN
  valid:=d.kind='entry' AND NEW.amount_minor=abs(i.amount_minor) AND NEW.direction=(CASE WHEN i.amount_minor>0 THEN 'CREDIT' ELSE 'DEBIT' END)
  AND NEW.booked_at=i.occurred_at AND NEW.source_occurred_at IS NOT DISTINCT FROM (o->>'sourceOccurredAt')::timestamptz
  AND NEW.value_date IS NOT DISTINCT FROM (o->>'valueDate')::date AND NEW.bank_reference IS NOT DISTINCT FROM o->>'bankReference';
 ELSE
  valid:=d.kind='statement' AND NEW.reported_at=i.occurred_at AND NEW.period_from IS NOT DISTINCT FROM (o->'period'->>'from')::timestamptz
  AND NEW.period_to IS NOT DISTINCT FROM (o->'period'->>'to')::timestamptz AND NEW.expected_line_count IS NOT DISTINCT FROM (o->>'expectedLineCount')::integer
  AND NEW.sequence_from IS NOT DISTINCT FROM (o->'sequenceRange'->>'from')::integer AND NEW.sequence_to IS NOT DISTINCT FROM (o->'sequenceRange'->>'to')::integer
  AND NEW.line_references_supplied=(o->'lineIds'<>'null'::jsonb) AND NEW.declared_reference_count=(CASE WHEN o->'lineIds'='null'::jsonb THEN 0 ELSE jsonb_array_length(o->'lineIds') END)
  AND EXISTS(SELECT FROM bank.statement_group WHERE id=NEW.group_id AND external_statement_reference=o->>'externalId');
 END IF;
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='P5003',MESSAGE='Bank projection differs from normalized evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER entry_provenance BEFORE INSERT ON bank.entry FOR EACH ROW EXECUTE FUNCTION bank.guard_projection();
CREATE TRIGGER statement_provenance BEFORE INSERT ON bank.statement FOR EACH ROW EXECUTE FUNCTION bank.guard_projection();
CREATE FUNCTION bank.guard_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d bank.derivation%ROWTYPE; o jsonb; did uuid; valid boolean;
BEGIN
 did:=(CASE TG_TABLE_NAME WHEN 'membership' THEN to_jsonb(NEW)->>'entry_id' WHEN 'statement_reference' THEN to_jsonb(NEW)->>'statement_id' ELSE to_jsonb(NEW)->>'derivation_id' END)::uuid;
 SELECT * INTO STRICT d FROM bank.derivation WHERE id=did;
 SELECT result->'observation' INTO STRICT o FROM ingestion.interpretation WHERE revision_id=d.revision_id AND normalizer_version=d.normalizer_version;
 IF d.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION USING ERRCODE='P5003',MESSAGE='Bank child population sealed'; END IF;
 IF TG_TABLE_NAME='membership' THEN
  valid:=d.kind='entry' AND NEW.line_identity IS NOT DISTINCT FROM o->>'lineIdentity' AND NEW.source_sequence IS NOT DISTINCT FROM (o->>'sequence')::integer
  AND EXISTS(SELECT FROM bank.statement_group WHERE id=NEW.group_id AND external_statement_reference=o->>'statementReference');
 ELSIF TG_TABLE_NAME='statement_reference' THEN
  valid:=d.kind='statement' AND NEW.line_identity IS NOT DISTINCT FROM o->'lineIds'->>(NEW.ordinal-1);
 ELSE
  valid:=NEW.amount_minor IS NOT DISTINCT FROM (o->(CASE NEW.kind WHEN 'OPENING' THEN 'opening' WHEN 'CLOSING' THEN 'closing' ELSE 'runningBalance' END)->>'amountMinor')::bigint
  AND NEW.effective_at IS NOT DISTINCT FROM (CASE NEW.kind WHEN 'OPENING' THEN (o->'period'->>'from')::timestamptz WHEN 'CLOSING' THEN (o->'period'->>'to')::timestamptz ELSE (o->>'occurredAt')::timestamptz END)
  AND ((d.kind='entry' AND NEW.kind='RUNNING') OR (d.kind='statement' AND NEW.kind IN ('OPENING','CLOSING')));
 END IF;
 IF valid IS DISTINCT FROM true THEN RAISE EXCEPTION USING ERRCODE='P5003',MESSAGE='Bank child provenance mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_provenance BEFORE INSERT ON bank.membership FOR EACH ROW EXECUTE FUNCTION bank.guard_child();
CREATE TRIGGER reference_provenance BEFORE INSERT ON bank.statement_reference FOR EACH ROW EXECUTE FUNCTION bank.guard_child();
CREATE TRIGGER balance_provenance BEFORE INSERT ON bank.balance_observation FOR EACH ROW EXECUTE FUNCTION bank.guard_child();

ALTER TABLE audit.audit_event ADD COLUMN bank_evaluation_id uuid REFERENCES bank.evaluation ON DELETE RESTRICT;
ALTER TABLE outbox.outbox_event ADD COLUMN bank_derivation_id uuid REFERENCES bank.derivation ON DELETE RESTRICT;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='audit.audit_event'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%num_nonnulls%' OR pg_get_constraintdef(oid) LIKE '%ingestion.batch_accepted%') LOOP
  EXECUTE format('ALTER TABLE audit.audit_event DROP CONSTRAINT %I',c.conname);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='outbox.outbox_event'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%num_nonnulls%' OR pg_get_constraintdef(oid) LIKE '%ingestion.normalization_requested%') LOOP
  EXECUTE format('ALTER TABLE outbox.outbox_event DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE audit.audit_event ADD CHECK(num_nonnulls(account_id,journal_id,batch_id,revision_id,processor_evaluation_id,bank_evaluation_id)=1),
 ADD CHECK((account_id IS NOT NULL AND action='ledger.account_created' AND previous_state='absent' AND new_state='open' AND reversal_of IS NULL AND command_key IS NOT NULL)
 OR (journal_id IS NOT NULL AND action IN ('ledger.journal_posted','ledger.journal_reversed') AND previous_state='absent' AND new_state='posted' AND command_key IS NOT NULL AND ((action='ledger.journal_reversed')=(reversal_of IS NOT NULL)))
 OR (batch_id IS NOT NULL AND action IN ('ingestion.batch_accepted','ingestion.normalization_requested') AND previous_state='absent' AND new_state='accepted' AND reversal_of IS NULL)
 OR (revision_id IS NOT NULL AND action='ingestion.revision_observed' AND previous_state='absent' AND new_state='observed' AND reversal_of IS NULL)
 OR (processor_evaluation_id IS NOT NULL AND action='processor.controls_failed' AND previous_state='absent' AND new_state='control_failed' AND reversal_of IS NULL)
 OR (bank_evaluation_id IS NOT NULL AND action='bank.controls_failed' AND previous_state='absent' AND new_state='control_failed' AND reversal_of IS NULL)),
 ADD UNIQUE(bank_evaluation_id);
ALTER TABLE outbox.outbox_event ADD CHECK(num_nonnulls(account_id,journal_id,batch_id,processor_derivation_id,bank_derivation_id)=1),
 ADD CHECK(payload @> jsonb_build_object('bookId',book_id) AND
 ((account_id IS NOT NULL AND event_type='ledger.account_created' AND payload @> jsonb_build_object('accountId',account_id) AND command_key IS NOT NULL AND normalizer_version IS NULL)
 OR (journal_id IS NOT NULL AND event_type IN ('ledger.journal_posted','ledger.journal_reversed') AND payload @> jsonb_build_object('journalId',journal_id) AND command_key IS NOT NULL AND normalizer_version IS NULL)
 OR (batch_id IS NOT NULL AND event_type='ingestion.normalization_requested' AND normalizer_version IS NOT NULL AND payload @> jsonb_build_object('batchId',batch_id,'normalizerVersion',normalizer_version))
 OR (processor_derivation_id IS NOT NULL AND event_type='processor.interpreted' AND normalizer_version IS NULL AND payload @> jsonb_build_object('derivationId',processor_derivation_id))
 OR (bank_derivation_id IS NOT NULL AND event_type='bank.interpreted' AND normalizer_version IS NULL AND payload @> jsonb_build_object('derivationId',bank_derivation_id)))),
 ADD UNIQUE(bank_derivation_id);
CREATE FUNCTION bank.guard_companion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE resource uuid; aid uuid; expected_book uuid;
BEGIN
 IF TG_TABLE_SCHEMA='audit' THEN
  resource:=(to_jsonb(NEW)->>'bank_evaluation_id')::uuid;
  IF resource IS NULL THEN RETURN NEW; END IF;
  SELECT source_account_id INTO STRICT aid FROM bank.evaluation WHERE id=resource;
 ELSE
  resource:=(to_jsonb(NEW)->>'bank_derivation_id')::uuid;
  IF resource IS NULL THEN RETURN NEW; END IF;
  SELECT source_account_id INTO STRICT aid FROM bank.derivation WHERE id=resource;
 END IF;
 SELECT book_id INTO STRICT expected_book FROM ingestion.source_account WHERE id=aid;
 IF expected_book<>NEW.book_id THEN RAISE EXCEPTION USING ERRCODE='P5003',MESSAGE='Cross-book bank companion'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_audit_scope BEFORE INSERT ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION bank.guard_companion();
CREATE TRIGGER bank_outbox_scope BEFORE INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION bank.guard_companion();

CREATE FUNCTION bank.derive(rev uuid,nv text,iv text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r ingestion.revision%ROWTYPE; i ingestion.interpretation%ROWTYPE; d bank.derivation%ROWTYPE;
 o jsonb; aid uuid; gid uuid; did uuid; book uuid; k text;
BEGIN
 IF iv IS DISTINCT FROM 'bank-v1' OR nv IS NULL OR nv NOT IN ('synthetic-bank-entry-v1','synthetic-bank-statement-v1') THEN RAISE EXCEPTION USING ERRCODE='P5002',MESSAGE='Unsupported bank policy'; END IF;
 SELECT * INTO STRICT r FROM ingestion.revision WHERE id=rev;
 PERFORM 1 FROM ingestion.source_account WHERE id=r.source_account_id FOR UPDATE;
 SELECT * INTO STRICT i FROM ingestion.interpretation WHERE revision_id=rev AND normalizer_version=nv;
 IF i.state<>'NORMALIZED' THEN RAISE EXCEPTION USING ERRCODE='P5002',MESSAGE='Normalized bank input required'; END IF;
 SELECT * INTO d FROM bank.derivation WHERE revision_id=rev AND normalizer_version=nv AND interpreter_version=iv;
 IF FOUND THEN RETURN jsonb_build_object('id',d.id,'replayed',true,'kind',d.kind,'accountId',d.account_id); END IF;
 o:=i.result->'observation'; k:=CASE o->>'type' WHEN 'bank-entry' THEN 'entry' WHEN 'bank-statement' THEN 'statement' END;
 INSERT INTO bank.account(source_account_id,currency) VALUES(r.source_account_id,i.currency) ON CONFLICT DO NOTHING;
 SELECT id INTO STRICT aid FROM bank.account WHERE source_account_id=r.source_account_id AND currency=i.currency;
 INSERT INTO bank.derivation(revision_id,normalizer_version,interpreter_version,source_account_id,fact_id,account_id,currency,kind,identity_kind)
 VALUES(rev,nv,iv,r.source_account_id,r.fact_id,aid,i.currency,k,CASE WHEN r.fact_id IS NULL THEN 'OBSERVATION_ONLY' ELSE 'SOURCE_ID' END) RETURNING id INTO did;
 IF k='entry' THEN
  INSERT INTO bank.entry(id,source_account_id,currency,amount_minor,direction,booked_at,source_occurred_at,value_date,bank_reference)
  VALUES(did,r.source_account_id,i.currency,abs(i.amount_minor),CASE WHEN i.amount_minor>0 THEN 'CREDIT' ELSE 'DEBIT' END,i.occurred_at,(o->>'sourceOccurredAt')::timestamptz,(o->>'valueDate')::date,o->>'bankReference');
 END IF;
 IF k='statement' OR o->>'statementReference' IS NOT NULL THEN
  INSERT INTO bank.statement_group(source_account_id,external_statement_reference) VALUES(r.source_account_id,CASE WHEN k='statement' THEN o->>'externalId' ELSE o->>'statementReference' END) ON CONFLICT DO NOTHING;
  SELECT id INTO STRICT gid FROM bank.statement_group WHERE source_account_id=r.source_account_id AND external_statement_reference=(CASE WHEN k='statement' THEN o->>'externalId' ELSE o->>'statementReference' END);
  IF k='entry' THEN
   INSERT INTO bank.membership VALUES(did,r.source_account_id,gid,o->>'lineIdentity',(o->>'sequence')::integer);
  ELSE
   INSERT INTO bank.statement(id,source_account_id,currency,group_id,reported_at,period_from,period_to,expected_line_count,sequence_from,sequence_to,line_references_supplied,declared_reference_count)
   VALUES(did,r.source_account_id,i.currency,gid,i.occurred_at,(o->'period'->>'from')::timestamptz,(o->'period'->>'to')::timestamptz,(o->>'expectedLineCount')::integer,(o->'sequenceRange'->>'from')::integer,(o->'sequenceRange'->>'to')::integer,o->'lineIds'<>'null'::jsonb,CASE WHEN o->'lineIds'='null'::jsonb THEN 0 ELSE jsonb_array_length(o->'lineIds') END);
   INSERT INTO bank.statement_reference SELECT did,ordinality::integer,value#>>'{}' FROM jsonb_array_elements(CASE WHEN o->'lineIds'='null'::jsonb THEN '[]'::jsonb ELSE o->'lineIds' END) WITH ORDINALITY;
  END IF;
 END IF;
 INSERT INTO bank.balance_observation(derivation_id,source_account_id,currency,kind,amount_minor,effective_at)
 SELECT did,r.source_account_id,i.currency,x.kind,(o->x.field->>'amountMinor')::bigint,x.effective_at FROM
 (VALUES('OPENING','opening',(o->'period'->>'from')::timestamptz),('CLOSING','closing',(o->'period'->>'to')::timestamptz),('RUNNING','runningBalance',i.occurred_at)) x(kind,field,effective_at)
 WHERE o->x.field IS NOT NULL AND o->x.field<>'null'::jsonb;
 SELECT book_id INTO STRICT book FROM ingestion.source_account WHERE id=r.source_account_id;
 INSERT INTO outbox.outbox_event(book_id,bank_derivation_id,event_type,aggregate_version,schema_version,payload)
 VALUES(book,did,'bank.interpreted',1,1,jsonb_build_object('bookId',book,'derivationId',did));
 RETURN jsonb_build_object('id',did,'replayed',false,'kind',k,'accountId',aid);
END $$;

CREATE FUNCTION bank.statement_snapshot(sid uuid,iv text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE s bank.statement%ROWTYPE; sd bank.derivation%ROWTYPE; inputs jsonb; refs jsonb; item record; controls text[]:='{}';
 credits numeric:=0; debits numeric:=0; opening numeric; closing numeric; n integer; complete boolean:=true; coverage text:='UNKNOWN'; independent boolean; coverage_ok boolean:=true;
BEGIN
 SELECT * INTO STRICT s FROM bank.statement WHERE id=sid;
 SELECT * INTO STRICT sd FROM bank.derivation WHERE id=sid;
 -- One logical source identity per row. Unidentified evidence is never deduplicated by amount/date/reference.
 SELECT coalesce(jsonb_agg(jsonb_build_object('identity',pop.identity,'factId',f.id,'revisionState',coalesce(f.revision_state,'OBSERVATION_ONLY'),'activeRevisionId',f.active_revision_id,
 'entryId',e.id,'currency',e.currency,'amountMinor',e.amount_minor::text,'direction',e.direction,'bookedAt',to_char(e.booked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'lineIdentity',m.line_identity,'sequence',m.source_sequence,'historicalEntryIds',pop.history,
 'conflictingGroups',coalesce((SELECT jsonb_agg(DISTINCT other.group_id ORDER BY other.group_id) FROM bank.membership other JOIN bank.derivation od ON od.id=other.entry_id
 WHERE od.interpreter_version=iv AND od.normalizer_version='synthetic-bank-entry-v1' AND od.fact_id=pop.fact_id AND other.group_id<>s.group_id),'[]')) ORDER BY pop.identity),'[]') INTO inputs
 FROM (SELECT coalesce(d.fact_id,d.revision_id) AS identity,d.fact_id,
 min(d.id::text)::uuid AS unidentified_id,jsonb_agg(d.id ORDER BY d.id) AS history
 FROM bank.membership pm JOIN bank.derivation d ON d.id=pm.entry_id
 WHERE pm.group_id=s.group_id AND d.interpreter_version=iv AND d.normalizer_version='synthetic-bank-entry-v1'
 GROUP BY coalesce(d.fact_id,d.revision_id),d.fact_id) pop
 LEFT JOIN ingestion.fact_status f ON f.id=pop.fact_id
 LEFT JOIN bank.derivation chosen ON chosen.interpreter_version=iv AND chosen.normalizer_version='synthetic-bank-entry-v1'
 AND ((pop.fact_id IS NOT NULL AND chosen.fact_id=pop.fact_id AND chosen.revision_id=f.active_revision_id) OR (pop.fact_id IS NULL AND chosen.id=pop.unidentified_id))
 LEFT JOIN bank.entry e ON e.id=chosen.id
 LEFT JOIN bank.membership m ON m.entry_id=e.id AND m.group_id=s.group_id;
 SELECT coalesce(jsonb_agg(line_identity ORDER BY ordinal),'[]') INTO refs FROM bank.statement_reference WHERE statement_id=sid;
 n:=jsonb_array_length(inputs);
 independent:=s.expected_line_count IS NOT NULL OR s.sequence_from IS NOT NULL OR s.line_references_supplied;
 IF (SELECT revision_state FROM ingestion.fact_status WHERE id=sd.fact_id)<>'UNAMBIGUOUS' THEN controls:=array_append(controls,'AMBIGUOUS_STATEMENT'); complete:=false; END IF;
 IF s.period_from>s.period_to OR s.sequence_from>s.sequence_to THEN controls:=array_append(controls,'INVALID_STATEMENT_ORDERING'); complete:=false; END IF;
 IF s.expected_line_count IS NOT NULL AND s.expected_line_count<>n THEN controls:=array_append(controls,'LINE_COUNT_MISMATCH'); coverage_ok:=false; END IF;
 IF s.line_references_supplied THEN
  IF EXISTS(SELECT FROM bank.statement_reference WHERE statement_id=sid GROUP BY line_identity HAVING count(*)>1) THEN controls:=array_append(controls,'DUPLICATE_SOURCE_LINE_REFERENCE'); coverage_ok:=false; END IF;
  IF EXISTS(SELECT FROM bank.statement_reference ref WHERE ref.statement_id=sid AND NOT EXISTS(SELECT FROM jsonb_array_elements(inputs) x WHERE x->>'lineIdentity'=ref.line_identity)) THEN controls:=array_append(controls,'MISSING_REFERENCED_LINE'); coverage_ok:=false; END IF;
  IF n<>s.declared_reference_count OR EXISTS(SELECT FROM jsonb_array_elements(inputs) x WHERE NOT EXISTS(SELECT FROM bank.statement_reference ref WHERE ref.statement_id=sid AND ref.line_identity=x->>'lineIdentity')) THEN controls:=array_append(controls,'LINE_REFERENCE_COVERAGE'); coverage_ok:=false; END IF;
 END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(inputs) x WHERE x->>'lineIdentity' IS NOT NULL GROUP BY x->>'lineIdentity' HAVING count(*)>1) THEN controls:=array_append(controls,'DUPLICATE_LINE_IDENTITY'); complete:=false; coverage_ok:=false; END IF;
 IF s.sequence_from IS NOT NULL AND (n<>s.sequence_to::bigint-s.sequence_from+1 OR
 (SELECT count(DISTINCT (x->>'sequence')::integer) FROM jsonb_array_elements(inputs) x WHERE (x->>'sequence')::integer BETWEEN s.sequence_from AND s.sequence_to)<>s.sequence_to::bigint-s.sequence_from+1)
 THEN controls:=array_append(controls,'SEQUENCE_COVERAGE_FAILED'); coverage_ok:=false; END IF;
 FOR item IN SELECT * FROM jsonb_to_recordset(inputs) x("entryId" uuid,"revisionState" text,currency text,"amountMinor" text,direction text,"bookedAt" timestamptz,"conflictingGroups" jsonb) LOOP
  IF item."revisionState"='OBSERVATION_ONLY' THEN controls:=array_append(controls,'UNVERIFIED_ENTRY_IDENTITY'); complete:=false;
  ELSIF item."revisionState"<>'UNAMBIGUOUS' THEN controls:=array_append(controls,'AMBIGUOUS_ENTRY'); complete:=false; coverage_ok:=false; END IF;
  IF item."entryId" IS NULL THEN controls:=array_append(controls,'PENDING_ENTRY'); complete:=false; coverage_ok:=false;
  ELSIF item.currency<>s.currency THEN controls:=array_append(controls,'CROSS_CURRENCY_MEMBERSHIP'); complete:=false;
  ELSE
   IF item.direction='CREDIT' THEN credits:=credits+item."amountMinor"::numeric; ELSE debits:=debits+item."amountMinor"::numeric; END IF;
   IF s.period_from IS NOT NULL AND (item."bookedAt"<s.period_from OR item."bookedAt">s.period_to) THEN controls:=array_append(controls,'ENTRY_OUTSIDE_STATEMENT_PERIOD'); END IF;
  END IF;
  IF jsonb_array_length(item."conflictingGroups")>0 THEN controls:=array_append(controls,'CONFLICTING_STATEMENT_ASSOCIATION'); complete:=false; END IF;
 END LOOP;
 IF independent THEN coverage:=CASE WHEN coverage_ok THEN 'PROVEN_COMPLETE' ELSE 'PROVEN_INCOMPLETE' END; END IF;
 SELECT amount_minor INTO opening FROM bank.balance_observation WHERE derivation_id=sid AND kind='OPENING';
 SELECT amount_minor INTO closing FROM bank.balance_observation WHERE derivation_id=sid AND kind='CLOSING';
 -- Missing coverage is never treated as a complete statement sum, even if arithmetic happens to match.
 complete:=complete AND coverage='PROVEN_COMPLETE';
 IF complete AND opening IS NOT NULL AND closing IS NOT NULL AND opening+credits-debits<>closing THEN controls:=array_append(controls,'CLOSING_BALANCE_MISMATCH'); END IF;
 SELECT coalesce(array_agg(DISTINCT c ORDER BY c),'{}') INTO controls FROM unnest(controls) c;
 RETURN jsonb_build_object('input',jsonb_build_object('statementId',sid,'statementRevisionState',(SELECT revision_state FROM ingestion.fact_status WHERE id=sd.fact_id),'entries',inputs,'lineReferences',refs),
 'result',jsonb_build_object('controls',to_jsonb(controls),'currency',s.currency,'completeness',coverage,'receivedLineCount',n,'expectedLineCount',s.expected_line_count,
 'openingMinor',opening::text,'reportedClosingMinor',closing::text,'calculatedClosingMinor',CASE WHEN complete AND opening IS NOT NULL THEN (opening+credits-debits)::text ELSE NULL END,
 'knownMovementNetMinor',(credits-debits)::text,'creditsMinor',credits::text,'debitsMinor',debits::text,
 'arithmeticStatus',CASE WHEN NOT complete OR opening IS NULL OR closing IS NULL THEN 'UNVERIFIED' WHEN opening+credits-debits=closing THEN 'PASS' ELSE 'FAIL' END));
END $$;
CREATE FUNCTION bank.guard_evaluation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE snapshot jsonb;
BEGIN
 snapshot:=bank.statement_snapshot(NEW.statement_id,NEW.interpreter_version);
 IF snapshot->'input' IS DISTINCT FROM NEW.input OR snapshot->'result' IS DISTINCT FROM NEW.result THEN RAISE EXCEPTION USING ERRCODE='P5003',MESSAGE='Bank evaluation differs from pinned evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_provenance BEFORE INSERT ON bank.evaluation FOR EACH ROW EXECUTE FUNCTION bank.guard_evaluation();
CREATE FUNCTION bank.guard_evaluation_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e bank.evaluation%ROWTYPE;
BEGIN
 SELECT * INTO STRICT e FROM bank.evaluation WHERE id=NEW.evaluation_id;
 IF e.creation_transaction<>pg_current_xact_id() OR NOT EXISTS(SELECT FROM bank.entry WHERE id=NEW.entry_id AND source_account_id=e.source_account_id) THEN RAISE EXCEPTION USING ERRCODE='P5003',MESSAGE='Bank evaluation entry scope or seal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_entry_provenance BEFORE INSERT ON bank.evaluation_entry FOR EACH ROW EXECUTE FUNCTION bank.guard_evaluation_entry();
CREATE FUNCTION bank.evaluate(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE sid uuid:=(p->>'statementId')::uuid; aid uuid; book uuid; prior bank.evaluation%ROWTYPE; snapshot jsonb; eid uuid; iv text:=p->>'interpreterVersion';
BEGIN
 IF iv IS DISTINCT FROM 'bank-v1' THEN RAISE EXCEPTION USING ERRCODE='P5002',MESSAGE='Unsupported bank evaluation policy'; END IF;
 SELECT source_account_id INTO STRICT aid FROM bank.statement WHERE id=sid;
 PERFORM 1 FROM ingestion.source_account WHERE id=aid FOR UPDATE;
 SELECT * INTO prior FROM bank.evaluation WHERE statement_id=sid AND evaluation_key=p->>'evaluationKey';
 IF FOUND THEN
  IF prior.interpreter_version<>iv THEN RAISE EXCEPTION USING ERRCODE='P5001',MESSAGE='Bank evaluation identity conflict'; END IF;
  RETURN jsonb_build_object('id',prior.id,'replayed',true,'result',prior.result);
 END IF;
 snapshot:=bank.statement_snapshot(sid,iv);
 INSERT INTO bank.evaluation(statement_id,source_account_id,evaluation_key,interpreter_version,input,result)
 VALUES(sid,aid,p->>'evaluationKey',iv,snapshot->'input',snapshot->'result') RETURNING id INTO eid;
 INSERT INTO bank.evaluation_entry SELECT eid,(x->>'entryId')::uuid FROM jsonb_array_elements(snapshot->'input'->'entries') x WHERE x->>'entryId' IS NOT NULL;
 IF jsonb_array_length(snapshot->'result'->'controls')>0 THEN
  SELECT book_id INTO STRICT book FROM ingestion.source_account WHERE id=aid;
  INSERT INTO audit.audit_event(book_id,bank_evaluation_id,action,actor_id,previous_state,new_state,reason,policy_version)
  VALUES(book,eid,'bank.controls_failed',p->>'actorId','absent','control_failed','Immutable bank-internal control evaluation',iv);
 END IF;
 RETURN jsonb_build_object('id',eid,'replayed',false,'result',snapshot->'result');
END $$;
CREATE FUNCTION bank.validate_derivation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE o jsonb; expected_balances integer;
BEGIN
 SELECT result->'observation' INTO STRICT o FROM ingestion.interpretation WHERE revision_id=NEW.revision_id AND normalizer_version=NEW.normalizer_version;
 SELECT count(*) INTO expected_balances FROM unnest(ARRAY['opening','closing','runningBalance']) k WHERE o->k IS NOT NULL AND o->k<>'null'::jsonb;
 IF (NEW.kind='entry' AND (NOT EXISTS(SELECT FROM bank.entry WHERE id=NEW.id) OR
 (o->>'statementReference' IS NOT NULL) IS DISTINCT FROM EXISTS(SELECT FROM bank.membership WHERE entry_id=NEW.id)))
 OR (NEW.kind='statement' AND (NOT EXISTS(SELECT FROM bank.statement WHERE id=NEW.id) OR
 (SELECT declared_reference_count FROM bank.statement WHERE id=NEW.id)<>(SELECT count(*) FROM bank.statement_reference WHERE statement_id=NEW.id)))
 OR expected_balances<>(SELECT count(*) FROM bank.balance_observation WHERE derivation_id=NEW.id)
 OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE bank_derivation_id=NEW.id)
 THEN RAISE EXCEPTION USING ERRCODE='P5004',MESSAGE='Incomplete bank derivation or intent'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER derivation_commit_guard AFTER INSERT ON bank.derivation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank.validate_derivation();
CREATE FUNCTION bank.validate_evaluation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF (SELECT coalesce(array_agg(entry_id ORDER BY entry_id),'{}'::uuid[]) FROM bank.evaluation_entry WHERE evaluation_id=NEW.id) IS DISTINCT FROM
 (SELECT coalesce(array_agg((x->>'entryId')::uuid ORDER BY (x->>'entryId')::uuid),'{}'::uuid[]) FROM jsonb_array_elements(NEW.input->'entries') x WHERE x->>'entryId' IS NOT NULL)
 OR (jsonb_array_length(NEW.result->'controls')>0 AND NOT EXISTS(SELECT FROM audit.audit_event WHERE bank_evaluation_id=NEW.id))
 THEN RAISE EXCEPTION USING ERRCODE='P5004',MESSAGE='Incomplete bank evaluation links or audit'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER evaluation_commit_guard AFTER INSERT ON bank.evaluation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank.validate_evaluation();
CREATE VIEW bank.current_entry AS
 SELECT e.*,d.account_id,d.revision_id,d.normalizer_version,d.interpreter_version,d.identity_kind,d.fact_id,
 coalesce(f.revision_state,'OBSERVATION_ONLY') AS revision_state,
 CASE WHEN f.id IS NULL THEN false ELSE f.active_revision_id=d.revision_id END AS source_unambiguous
 FROM bank.entry e JOIN bank.derivation d ON d.id=e.id LEFT JOIN ingestion.fact_status f ON f.id=d.fact_id;
CREATE FUNCTION bank.summary(aid uuid,iv text) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('entries',(SELECT count(*) FROM bank.current_entry WHERE source_account_id=aid AND interpreter_version=iv),
 'ambiguousEntries',(SELECT count(DISTINCT fact_id) FROM bank.current_entry WHERE source_account_id=aid AND interpreter_version=iv AND revision_state='REVIEW_REQUIRED'),
 'observationOnlyEntries',(SELECT count(*) FROM bank.current_entry WHERE source_account_id=aid AND interpreter_version=iv AND identity_kind='OBSERVATION_ONLY'),
 'totals',coalesce((SELECT jsonb_agg(jsonb_build_object('currency',currency,'creditsMinor',credits::text,'debitsMinor',debits::text) ORDER BY currency) FROM
 (SELECT currency,coalesce(sum(amount_minor::numeric) FILTER(WHERE direction='CREDIT'),0) AS credits,coalesce(sum(amount_minor::numeric) FILTER(WHERE direction='DEBIT'),0) AS debits
 FROM bank.current_entry WHERE source_account_id=aid AND interpreter_version=iv AND source_unambiguous GROUP BY currency) totals),'[]'))
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['interpreter_version','account','statement_group','derivation','entry','statement','membership','statement_reference','balance_observation','evaluation','evaluation_entry'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_bank_fact BEFORE UPDATE OR DELETE ON bank.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON bank.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA bank FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bank FROM PUBLIC;
GRANT USAGE ON SCHEMA bank TO flow_bank_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA bank TO flow_bank_reader;
GRANT EXECUTE ON FUNCTION bank.derive(uuid,text,text),bank.evaluate(jsonb) TO flow_bank_writer;
GRANT EXECUTE ON FUNCTION bank.summary(uuid,text) TO flow_bank_reader;
RESET ROLE;
