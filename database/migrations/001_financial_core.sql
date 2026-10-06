-- Applied as one transaction by tools/migrations.ts. PostgreSQL 18, no extensions.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['flow_ledger_owner', 'flow_ledger_writer', 'flow_ledger_reader'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'Unsafe existing ledger group role: %', role_name;
    END IF;
  END LOOP;
END $$;

GRANT flow_ledger_reader TO flow_ledger_writer;

CREATE SCHEMA ledger AUTHORIZATION flow_ledger_owner;
CREATE SCHEMA audit AUTHORIZATION flow_ledger_owner;
CREATE SCHEMA outbox AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA ledger, audit, outbox FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;

CREATE TABLE ledger.currency_definition (
  code text PRIMARY KEY CHECK (code IN ('PHP', 'USD')),
  minor_unit_scale smallint NOT NULL CHECK (minor_unit_scale = 2),
  metadata_version integer NOT NULL CHECK (metadata_version = 1)
);
INSERT INTO ledger.currency_definition VALUES ('PHP', 2, 1), ('USD', 2, 1);

CREATE TABLE ledger.book (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 128),
  environment text NOT NULL CHECK (environment IN ('synthetic', 'test')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE ledger.ledger_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES ledger.book ON DELETE RESTRICT,
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 512),
  currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
  classification text NOT NULL CHECK (classification IN ('asset', 'liability', 'equity', 'income', 'expense')),
  normal_side text NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  state text NOT NULL DEFAULT 'open' CHECK (state = 'open'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (book_id, code),
  UNIQUE (book_id, id),
  UNIQUE (book_id, id, currency)
);

CREATE TABLE ledger.ledger_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES ledger.book ON DELETE RESTRICT,
  currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
  effect_namespace text NOT NULL CHECK (length(effect_namespace) BETWEEN 1 AND 512),
  business_effect_key text NOT NULL CHECK (length(business_effect_key) BETWEEN 1 AND 512),
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 512),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'constructing' CHECK (state IN ('constructing', 'posted')),
  effective_at timestamptz NOT NULL CHECK (isfinite(effective_at)),
  posted_at timestamptz,
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 512),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  reversal_of uuid,
  CHECK ((state = 'constructing' AND posted_at IS NULL) OR (state = 'posted' AND posted_at IS NOT NULL AND isfinite(posted_at))),
  CHECK (reversal_of IS NULL OR reversal_of <> id),
  UNIQUE (book_id, effect_namespace, business_effect_key),
  UNIQUE (book_id, id),
  UNIQUE (book_id, id, currency),
  UNIQUE (reversal_of),
  FOREIGN KEY (book_id, reversal_of, currency) REFERENCES ledger.ledger_transaction (book_id, id, currency) ON DELETE RESTRICT
);

CREATE TABLE ledger.ledger_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL,
  journal_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number BETWEEN 1 AND 1000),
  account_id uuid NOT NULL,
  currency text NOT NULL,
  side text NOT NULL CHECK (side IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  UNIQUE (journal_id, line_number),
  FOREIGN KEY (book_id, journal_id, currency) REFERENCES ledger.ledger_transaction (book_id, id, currency) ON DELETE RESTRICT,
  FOREIGN KEY (book_id, account_id, currency) REFERENCES ledger.ledger_account (book_id, id, currency) ON DELETE RESTRICT
);
CREATE INDEX ledger_entry_account_idx ON ledger.ledger_entry (account_id);

CREATE TABLE ledger.command_receipt (
  book_id uuid NOT NULL REFERENCES ledger.book ON DELETE RESTRICT,
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 512),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  journal_id uuid,
  account_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (book_id, command_key),
  CHECK (num_nonnulls(journal_id, account_id) = 1),
  FOREIGN KEY (book_id, journal_id) REFERENCES ledger.ledger_transaction (book_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (book_id, account_id) REFERENCES ledger.ledger_account (book_id, id) ON DELETE RESTRICT
);

CREATE TABLE audit.audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES ledger.book ON DELETE RESTRICT,
  account_id uuid,
  journal_id uuid,
  action text NOT NULL CHECK (action IN ('ledger.account_created', 'ledger.journal_posted', 'ledger.journal_reversed')),
  actor_id text NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  database_principal text NOT NULL DEFAULT session_user,
  previous_state text NOT NULL CHECK (previous_state = 'absent'),
  new_state text NOT NULL CHECK (new_state IN ('open', 'posted')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  command_key text NOT NULL,
  policy_version text NOT NULL,
  reversal_of uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (num_nonnulls(journal_id, account_id) = 1),
  UNIQUE (account_id),
  UNIQUE (journal_id),
  CHECK ((account_id IS NOT NULL AND action = 'ledger.account_created' AND new_state = 'open' AND reversal_of IS NULL)
    OR (journal_id IS NOT NULL AND action = 'ledger.journal_posted' AND new_state = 'posted' AND reversal_of IS NULL)
    OR (journal_id IS NOT NULL AND action = 'ledger.journal_reversed' AND new_state = 'posted' AND reversal_of IS NOT NULL)),
  FOREIGN KEY (book_id, account_id) REFERENCES ledger.ledger_account (book_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (book_id, journal_id) REFERENCES ledger.ledger_transaction (book_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (book_id, reversal_of) REFERENCES ledger.ledger_transaction (book_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (book_id, command_key) REFERENCES ledger.command_receipt (book_id, command_key) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE outbox.outbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES ledger.book ON DELETE RESTRICT,
  account_id uuid,
  journal_id uuid,
  event_type text NOT NULL CHECK (event_type IN ('ledger.account_created', 'ledger.journal_posted', 'ledger.journal_reversed')),
  aggregate_version integer NOT NULL CHECK (aggregate_version = 1),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  command_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (num_nonnulls(journal_id, account_id) = 1),
  UNIQUE (account_id, aggregate_version),
  UNIQUE (journal_id, aggregate_version),
  CHECK (payload @> jsonb_build_object('bookId',book_id) AND
    ((account_id IS NOT NULL AND event_type = 'ledger.account_created' AND payload @> jsonb_build_object('accountId',account_id))
    OR (journal_id IS NOT NULL AND event_type IN ('ledger.journal_posted','ledger.journal_reversed') AND payload @> jsonb_build_object('journalId',journal_id)))),
  FOREIGN KEY (book_id, account_id) REFERENCES ledger.ledger_account (book_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (book_id, journal_id) REFERENCES ledger.ledger_transaction (book_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (book_id, command_key) REFERENCES ledger.command_receipt (book_id, command_key) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION ledger.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Immutable financial history';
END $$;

CREATE FUNCTION ledger.guard_journal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'constructing' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Journal must be constructed before posting';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'constructing' OR NEW.state <> 'posted' OR
       (to_jsonb(NEW) - ARRAY['state', 'posted_at']) <> (to_jsonb(OLD) - ARRAY['state', 'posted_at']) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Journal is immutable except its initial posting transition';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Journal cannot be deleted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_write_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger.ledger_transaction
FOR EACH ROW EXECUTE FUNCTION ledger.guard_journal();

CREATE FUNCTION ledger.guard_entry_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE parent_state text;
BEGIN
  SELECT state INTO parent_state FROM ledger.ledger_transaction WHERE id = NEW.journal_id FOR UPDATE;
  IF parent_state IS DISTINCT FROM 'constructing' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Entries can only be inserted into an uncommitted constructing journal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entry_insert_guard BEFORE INSERT ON ledger.ledger_entry
FOR EACH ROW EXECUTE FUNCTION ledger.guard_entry_insert();

CREATE FUNCTION ledger.validate_journal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  jid uuid;
  j ledger.ledger_transaction%ROWTYPE;
  original ledger.ledger_transaction%ROWTYPE;
  entry_count bigint;
  difference numeric;
  expected_action text;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transaction' THEN jid := NEW.id; ELSE jid := NEW.journal_id; END IF;
  SELECT * INTO STRICT j FROM ledger.ledger_transaction WHERE id = jid FOR UPDATE;
  SELECT count(*), coalesce(sum(CASE side WHEN 'debit' THEN amount_minor::numeric ELSE -amount_minor::numeric END), 0)
    INTO entry_count, difference FROM ledger.ledger_entry WHERE journal_id = jid;
  IF j.state <> 'posted' OR entry_count < 2 OR entry_count > 1000 OR difference <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1004', MESSAGE = 'Committed journal must be posted, complete and balanced';
  END IF;
  expected_action := CASE WHEN j.reversal_of IS NULL THEN 'ledger.journal_posted' ELSE 'ledger.journal_reversed' END;
  IF NOT EXISTS (SELECT FROM audit.audit_event WHERE journal_id = jid AND action = expected_action
    AND actor_id = j.actor_id AND reason = j.reason AND command_key = j.command_key
    AND policy_version = j.policy_version AND reversal_of IS NOT DISTINCT FROM j.reversal_of AND new_state = 'posted') OR
    NOT EXISTS (SELECT FROM outbox.outbox_event WHERE journal_id = jid AND event_type = expected_action
      AND command_key = j.command_key AND payload @> jsonb_build_object('journalId',jid,'bookId',j.book_id,'currency',j.currency,'reversalOf',j.reversal_of)) OR
    NOT EXISTS (SELECT FROM ledger.command_receipt WHERE book_id = j.book_id AND command_key = j.command_key
      AND journal_id = jid AND request_hash = j.request_hash AND request_payload = j.request_payload) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1004', MESSAGE = 'Journal requires matching atomic audit, outbox and command receipt';
  END IF;
  IF j.reversal_of IS NOT NULL THEN
    SELECT * INTO STRICT original FROM ledger.ledger_transaction WHERE id = j.reversal_of;
    IF original.reversal_of IS NOT NULL OR original.state <> 'posted' OR j.effect_namespace <> 'ledger.reversal' OR j.business_effect_key <> original.id::text THEN
      RAISE EXCEPTION USING ERRCODE = 'P1005', MESSAGE = 'Only one full reversal of an original journal is supported';
    END IF;
    IF EXISTS (
      (SELECT account_id, currency, side, amount_minor FROM ledger.ledger_entry WHERE journal_id = jid
       EXCEPT ALL
       SELECT account_id, currency, CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END, amount_minor
       FROM ledger.ledger_entry WHERE journal_id = original.id)
      UNION ALL
      (SELECT account_id, currency, CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END, amount_minor
       FROM ledger.ledger_entry WHERE journal_id = original.id
       EXCEPT ALL
       SELECT account_id, currency, side, amount_minor FROM ledger.ledger_entry WHERE journal_id = jid)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1005', MESSAGE = 'Reversal entries must exactly invert original entries';
    END IF;
  ELSIF j.effect_namespace ~ '^ledger([.]|$)' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1005', MESSAGE = 'Reserved ledger effect namespace';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_commit_guard AFTER INSERT OR UPDATE ON ledger.ledger_transaction
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.validate_journal();
CREATE CONSTRAINT TRIGGER entry_commit_guard AFTER INSERT ON ledger.ledger_entry
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.validate_journal();

CREATE FUNCTION ledger.validate_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM audit.audit_event WHERE account_id = NEW.id AND action = 'ledger.account_created' AND new_state = 'open') OR
     NOT EXISTS (SELECT FROM outbox.outbox_event WHERE account_id = NEW.id AND event_type = 'ledger.account_created'
       AND payload @> jsonb_build_object('accountId',NEW.id,'bookId',NEW.book_id,'currency',NEW.currency)) OR
     NOT EXISTS (SELECT FROM ledger.command_receipt WHERE account_id = NEW.id AND request_hash = NEW.request_hash AND request_payload = NEW.request_payload) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1004', MESSAGE = 'Account creation requires atomic audit, outbox and command receipt';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_commit_guard AFTER INSERT ON ledger.ledger_account
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.validate_account();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ledger.currency_definition', 'ledger.book', 'ledger.ledger_account', 'ledger.ledger_entry',
    'ledger.command_receipt', 'audit.audit_event', 'outbox.outbox_event'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['ledger.currency_definition', 'ledger.book', 'ledger.ledger_account', 'ledger.ledger_transaction',
    'ledger.ledger_entry', 'ledger.command_receipt', 'audit.audit_event', 'outbox.outbox_event'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()', table_name);
  END LOOP;
END $$;

CREATE FUNCTION ledger.require_text(p jsonb, key text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE value text;
BEGIN
  value := p ->> key;
  IF jsonb_typeof(p -> key) IS DISTINCT FROM 'string' OR length(value) NOT BETWEEN 1 AND 512 OR btrim(value) <> value THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Missing or invalid bounded string field: ' || key;
  END IF;
  RETURN value;
END $$;

CREATE FUNCTION ledger.check_keys(p jsonb, keys text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (p - keys) <> '{}'::jsonb OR NOT p ?& keys THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Command fields must match the declared schema';
  END IF;
END $$;

CREATE FUNCTION ledger.fingerprint(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to(p::text, 'UTF8')), 'hex')
$$;

CREATE FUNCTION ledger.replay(p_book uuid, p_key text, p_payload jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE receipt ledger.command_receipt%ROWTYPE;
BEGIN
  -- Stable command alias lock is an aid; PK and semantic journal key remain final barriers.
  PERFORM pg_advisory_xact_lock(hashtextextended('flow-command/' || p_book::text || '/' || p_key, 0));
  SELECT * INTO receipt FROM ledger.command_receipt WHERE book_id = p_book AND command_key = p_key;
  IF FOUND THEN
    IF receipt.request_payload <> p_payload OR receipt.request_hash <> ledger.fingerprint(p_payload) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'Semantic idempotency key reused with conflicting command';
    END IF;
    RETURN coalesce(receipt.journal_id, receipt.account_id);
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION ledger.create_account(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  bid uuid; key text; actor text; reason_text text; payload jsonb; account ledger.ledger_account%ROWTYPE; result_id uuid;
BEGIN
  PERFORM ledger.check_keys(p, ARRAY['bookId','commandKey','actorId','reason','code','currency','classification','normalSide']);
  bid := ledger.require_text(p, 'bookId')::uuid;
  key := ledger.require_text(p, 'commandKey'); actor := ledger.require_text(p, 'actorId'); reason_text := ledger.require_text(p, 'reason');
  payload := jsonb_build_object('kind','create_account','fingerprintVersion',1,'bookId',bid::text,'code',ledger.require_text(p,'code'),
    'currency',ledger.require_text(p,'currency'),'classification',ledger.require_text(p,'classification'),
    'normalSide',ledger.require_text(p,'normalSide'),'reason',reason_text);
  result_id := ledger.replay(bid, key, payload);
  IF result_id IS NOT NULL THEN RETURN jsonb_build_object('id',result_id,'replayed',true); END IF;
  INSERT INTO ledger.ledger_account (book_id,code,currency,classification,normal_side,request_payload,request_hash)
    VALUES (bid,payload->>'code',payload->>'currency',payload->>'classification',payload->>'normalSide',payload,ledger.fingerprint(payload))
    ON CONFLICT (book_id,code) DO NOTHING RETURNING * INTO account;
  IF NOT FOUND THEN
    SELECT * INTO STRICT account FROM ledger.ledger_account WHERE book_id=bid AND code=payload->>'code';
    IF account.request_payload <> payload THEN RAISE EXCEPTION USING ERRCODE='P1001', MESSAGE='Account code reused with conflicting meaning'; END IF;
    INSERT INTO ledger.command_receipt VALUES (bid,key,payload,ledger.fingerprint(payload),NULL,account.id,transaction_timestamp());
    RETURN jsonb_build_object('id',account.id,'replayed',true);
  END IF;
  INSERT INTO ledger.command_receipt VALUES (bid,key,payload,ledger.fingerprint(payload),NULL,account.id,transaction_timestamp());
  INSERT INTO audit.audit_event (book_id,account_id,action,actor_id,previous_state,new_state,reason,command_key,policy_version)
    VALUES (bid,account.id,'ledger.account_created',actor,'absent','open',reason_text,key,'ledger-account-v1');
  INSERT INTO outbox.outbox_event (book_id,account_id,event_type,aggregate_version,schema_version,payload,command_key)
    VALUES (bid,account.id,'ledger.account_created',1,1,jsonb_build_object('accountId',account.id,'bookId',bid,'currency',account.currency),key);
  RETURN jsonb_build_object('id',account.id,'replayed',false);
END $$;

CREATE FUNCTION ledger.post_internal(p jsonb, original_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  bid uuid; key text; actor text; reason_text text; code text; effective timestamptz; normalized_entries jsonb;
  entry jsonb; magnitude text; payload jsonb; j ledger.ledger_transaction%ROWTYPE; result_id uuid; action_text text;
  account ledger.ledger_account%ROWTYPE; account_count integer;
BEGIN
  bid := ledger.require_text(p,'bookId')::uuid; key := ledger.require_text(p,'commandKey');
  actor := ledger.require_text(p,'actorId'); reason_text := ledger.require_text(p,'reason'); code := ledger.require_text(p,'currency');
  IF ledger.require_text(p,'effectiveAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Canonical UTC millisecond effectiveAt required';
  END IF;
  effective := (p->>'effectiveAt')::timestamptz;
  IF to_char(effective AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p->>'effectiveAt' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid effectiveAt';
  END IF;
  IF jsonb_typeof(p->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'entries') NOT BETWEEN 2 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Journal requires 2-1000 entries';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(p->'entries') LOOP
    PERFORM ledger.check_keys(entry,ARRAY['accountId','side','amountMinor']);
    PERFORM ledger.require_text(entry,'accountId')::uuid;
    IF ledger.require_text(entry,'side') NOT IN ('debit','credit') THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid entry side'; END IF;
    magnitude := ledger.require_text(entry,'amountMinor');
    IF length(magnitude)>19 OR magnitude !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Positive canonical integer string amount required'; END IF;
    PERFORM magnitude::bigint;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('accountId',(value->>'accountId')::uuid::text,'side',value->>'side','amountMinor',(value->>'amountMinor')::bigint::text)
      ORDER BY (value->>'accountId')::uuid,value->>'side',(value->>'amountMinor')::bigint)
    INTO normalized_entries FROM jsonb_array_elements(p->'entries');
  payload := jsonb_build_object('kind',CASE WHEN original_id IS NULL THEN 'post' ELSE 'reverse' END,'fingerprintVersion',1,
    'bookId',bid::text,'currency',code,'effectNamespace',ledger.require_text(p,'effectNamespace'),
    'businessEffectKey',ledger.require_text(p,'businessEffectKey'),'effectiveAt',p->>'effectiveAt',
    'policyVersion',ledger.require_text(p,'policyVersion'),'reason',reason_text,'entries',normalized_entries,'reversalOf',original_id);
  result_id := ledger.replay(bid,key,payload);
  IF result_id IS NOT NULL THEN RETURN jsonb_build_object('id',result_id,'replayed',true); END IF;
  INSERT INTO ledger.ledger_transaction (book_id,currency,effect_namespace,business_effect_key,command_key,request_payload,request_hash,effective_at,policy_version,actor_id,reason,reversal_of)
    VALUES (bid,code,payload->>'effectNamespace',payload->>'businessEffectKey',key,payload,ledger.fingerprint(payload),effective,payload->>'policyVersion',actor,reason_text,original_id)
    ON CONFLICT (book_id,effect_namespace,business_effect_key) DO NOTHING RETURNING * INTO j;
  IF NOT FOUND THEN
    SELECT * INTO STRICT j FROM ledger.ledger_transaction WHERE book_id=bid AND effect_namespace=payload->>'effectNamespace' AND business_effect_key=payload->>'businessEffectKey';
    IF j.request_payload <> payload OR j.request_hash <> ledger.fingerprint(payload) THEN
      RAISE EXCEPTION USING ERRCODE='P1001', MESSAGE='Business effect identity reused with conflicting command';
    END IF;
    INSERT INTO ledger.command_receipt VALUES (bid,key,payload,ledger.fingerprint(payload),j.id,NULL,transaction_timestamp());
    RETURN jsonb_build_object('id',j.id,'replayed',true);
  END IF;
  account_count := 0;
  FOR account IN SELECT a.* FROM ledger.ledger_account a
    WHERE a.id IN (SELECT (value->>'accountId')::uuid FROM jsonb_array_elements(normalized_entries)) ORDER BY a.id FOR SHARE LOOP
    IF account.book_id <> bid OR account.currency <> code OR account.state <> 'open' THEN
      RAISE EXCEPTION USING ERRCODE='P1002', MESSAGE='Account book, currency or state incompatible with journal';
    END IF;
    account_count := account_count + 1;
  END LOOP;
  IF account_count <> (SELECT count(DISTINCT value->>'accountId') FROM jsonb_array_elements(normalized_entries)) THEN
    RAISE EXCEPTION USING ERRCODE='P1002', MESSAGE='Account does not exist';
  END IF;
  INSERT INTO ledger.ledger_entry (book_id,journal_id,line_number,account_id,currency,side,amount_minor)
    SELECT bid,j.id,ordinality::integer,(value->>'accountId')::uuid,code,value->>'side',(value->>'amountMinor')::bigint
    FROM jsonb_array_elements(normalized_entries) WITH ORDINALITY;
  UPDATE ledger.ledger_transaction SET state='posted',posted_at=transaction_timestamp() WHERE id=j.id;
  INSERT INTO ledger.command_receipt VALUES (bid,key,payload,ledger.fingerprint(payload),j.id,NULL,transaction_timestamp());
  action_text := CASE WHEN original_id IS NULL THEN 'ledger.journal_posted' ELSE 'ledger.journal_reversed' END;
  INSERT INTO audit.audit_event (book_id,journal_id,action,actor_id,previous_state,new_state,reason,command_key,policy_version,reversal_of)
    VALUES (bid,j.id,action_text,actor,'absent','posted',reason_text,key,j.policy_version,original_id);
  INSERT INTO outbox.outbox_event (book_id,journal_id,event_type,aggregate_version,schema_version,payload,command_key)
    VALUES (bid,j.id,action_text,1,1,jsonb_build_object('journalId',j.id,'bookId',bid,'currency',code,'reversalOf',original_id),key);
  RETURN jsonb_build_object('id',j.id,'replayed',false);
END $$;

CREATE FUNCTION ledger.post_journal(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ledger.check_keys(p,ARRAY['bookId','commandKey','actorId','reason','effectNamespace','businessEffectKey','currency','effectiveAt','policyVersion','entries']);
  IF ledger.require_text(p,'effectNamespace') ~ '^ledger([.]|$)' THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Reserved effect namespace'; END IF;
  RETURN ledger.post_internal(p,NULL);
END $$;

CREATE FUNCTION ledger.reverse_journal(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE original ledger.ledger_transaction%ROWTYPE; entries jsonb; bid uuid;
BEGIN
  PERFORM ledger.check_keys(p,ARRAY['bookId','commandKey','actorId','reason','originalJournalId','effectiveAt','policyVersion']);
  bid := ledger.require_text(p,'bookId')::uuid;
  -- Same command-first order as posting; original is immutable and its row serializes competing reversals.
  PERFORM pg_advisory_xact_lock(hashtextextended('flow-command/' || bid::text || '/' || ledger.require_text(p,'commandKey'),0));
  SELECT * INTO original FROM ledger.ledger_transaction WHERE book_id=bid AND id=ledger.require_text(p,'originalJournalId')::uuid FOR UPDATE;
  IF NOT FOUND OR original.state <> 'posted' THEN RAISE EXCEPTION USING ERRCODE='P1002', MESSAGE='Original posted journal not found'; END IF;
  IF original.reversal_of IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P1005', MESSAGE='Reversal-of-reversal is deferred'; END IF;
  SELECT jsonb_agg(jsonb_build_object('accountId',account_id,'side',CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END,'amountMinor',amount_minor::text))
    INTO entries FROM ledger.ledger_entry WHERE journal_id=original.id;
  RETURN ledger.post_internal((p - 'originalJournalId') || jsonb_build_object('effectNamespace','ledger.reversal','businessEffectKey',original.id::text,'currency',original.currency,'entries',entries),original.id);
END $$;

CREATE FUNCTION ledger.read_journal(jid uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT jsonb_build_object('id',j.id,'bookId',j.book_id,'currency',j.currency,'state',j.state,'reversalOf',j.reversal_of,
    'entries',(SELECT jsonb_agg(jsonb_build_object('accountId',e.account_id,'side',e.side,'amountMinor',e.amount_minor::text) ORDER BY e.line_number)
      FROM ledger.ledger_entry e WHERE e.journal_id=j.id))
  FROM ledger.ledger_transaction j WHERE j.id=jid AND j.state='posted'
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA ledger, audit, outbox FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA ledger, audit, outbox TO flow_ledger_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA ledger, audit, outbox TO flow_ledger_reader;
GRANT EXECUTE ON FUNCTION ledger.read_journal(uuid) TO flow_ledger_reader;
GRANT EXECUTE ON FUNCTION ledger.create_account(jsonb), ledger.post_journal(jsonb), ledger.reverse_journal(jsonb) TO flow_ledger_writer;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;
