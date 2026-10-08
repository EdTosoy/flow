-- Phase 10: immediate registration of immutable intent; mutable operational metadata only.
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='flow_worker') THEN
  CREATE ROLE flow_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='flow_worker' AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe worker role'; END IF;
END $$;
CREATE SCHEMA worker AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA worker FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
CREATE TABLE worker.contract(
 event_type text NOT NULL, schema_version integer NOT NULL, aggregate_version integer NOT NULL,
 handler text, handler_version integer, PRIMARY KEY(event_type,schema_version,aggregate_version),
 CHECK((handler IS NULL)=(handler_version IS NULL))
);
INSERT INTO worker.contract VALUES
 ('ingestion.normalization_requested',1,1,'normalize-batch',1),
 ('ledger.account_created',1,1,NULL,NULL),('ledger.journal_posted',1,1,NULL,NULL),('ledger.journal_reversed',1,1,NULL,NULL),
 ('processor.interpreted',1,1,NULL,NULL),('bank.interpreted',1,1,NULL,NULL),
 ('reconciliation.completed',1,1,NULL,NULL),('reconciliation.decision',1,1,NULL,NULL),
 ('exception.created',1,1,NULL,NULL),('exception.updated',1,1,NULL,NULL),
 ('exception.resolved',1,1,NULL,NULL),('exception.reopened',1,1,NULL,NULL),('controls.completed',1,1,NULL,NULL);
-- Offline provisioners configure future work; each item freezes its own retry/runtime policy.
CREATE TABLE worker.policy(
 id integer PRIMARY KEY CHECK(id=1), max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 100),
 base_delay_ms integer NOT NULL CHECK(base_delay_ms BETWEEN 1 AND 60000),
 max_delay_ms integer NOT NULL CHECK(max_delay_ms BETWEEN base_delay_ms AND 3600000),
 lease_ms integer NOT NULL CHECK(lease_ms BETWEEN 10 AND 3600000),
 timeout_ms integer NOT NULL CHECK(timeout_ms BETWEEN 1 AND lease_ms)
);
INSERT INTO worker.policy VALUES(1,5,100,30000,30000,10000);
CREATE TABLE worker.registration(
 event_id uuid PRIMARY KEY REFERENCES outbox.outbox_event ON DELETE RESTRICT,
 disposition text NOT NULL CHECK(disposition IN ('WORK_REQUIRED','NO_LOCAL_HANDLER')),
 handler text, handler_version integer, registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((disposition='WORK_REQUIRED' AND handler IS NOT NULL AND handler_version IS NOT NULL)
 OR (disposition='NO_LOCAL_HANDLER' AND handler IS NULL AND handler_version IS NULL))
);
CREATE TABLE worker.work_item(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL UNIQUE REFERENCES worker.registration ON DELETE RESTRICT,
 handler text NOT NULL, handler_version integer NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PROCESSING','SUCCEEDED','RETRYABLE','FAILED_TERMINAL')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 max_attempts integer NOT NULL, base_delay_ms integer NOT NULL, max_delay_ms integer NOT NULL,
 lease_ms integer NOT NULL, timeout_ms integer NOT NULL,
 next_attempt_at timestamptz, lease_token uuid, lease_owner text, lease_principal name,
 claimed_at timestamptz, lease_expires_at timestamptz,
 last_failure_class text CHECK(last_failure_class IN ('TRANSIENT','DOMAIN_REJECTION','POISON','UNSUPPORTED','TIMEOUT','LEASE_EXPIRED')),
 last_failure_code text CHECK(length(last_failure_code) BETWEEN 1 AND 128 AND last_failure_code ~ '^[A-Z0-9_]+$'),
 completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(max_attempts BETWEEN 1 AND 100 AND attempt_count<=max_attempts AND base_delay_ms BETWEEN 1 AND 60000 AND max_delay_ms BETWEEN base_delay_ms AND 3600000 AND lease_ms BETWEEN 10 AND 3600000 AND timeout_ms BETWEEN 1 AND lease_ms),
 CHECK((last_failure_class IS NULL)=(last_failure_code IS NULL)),
 CHECK((state='PROCESSING' AND num_nonnulls(lease_token,lease_owner,lease_principal,claimed_at,lease_expires_at)=5 AND attempt_count>0 AND lease_expires_at>claimed_at AND length(lease_owner) BETWEEN 1 AND 128)
 OR (state<>'PROCESSING' AND num_nonnulls(lease_token,lease_owner,lease_principal,claimed_at,lease_expires_at)=0)),
 CHECK((state='RETRYABLE')=(next_attempt_at IS NOT NULL)),
 CHECK((state IN ('SUCCEEDED','FAILED_TERMINAL'))=(completed_at IS NOT NULL)),
 CHECK(state<>'PENDING' OR (attempt_count=0 AND last_failure_class IS NULL)),
 CHECK(state NOT IN ('SUCCEEDED','FAILED_TERMINAL') OR attempt_count>0),
 CHECK(state<>'RETRYABLE' OR attempt_count<max_attempts),
 CHECK(state NOT IN ('RETRYABLE','FAILED_TERMINAL') OR last_failure_class IS NOT NULL),
 CHECK((next_attempt_at IS NULL OR isfinite(next_attempt_at)) AND (completed_at IS NULL OR isfinite(completed_at)) AND (lease_expires_at IS NULL OR isfinite(lease_expires_at)))
);
CREATE INDEX work_available ON worker.work_item(state,next_attempt_at,created_at,id) WHERE state IN ('PENDING','RETRYABLE');
CREATE INDEX work_expired ON worker.work_item(lease_expires_at,id) WHERE state='PROCESSING';
CREATE TABLE worker.attempt_event(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_id uuid NOT NULL REFERENCES worker.work_item ON DELETE RESTRICT,
 attempt integer NOT NULL CHECK(attempt>0), lease_token uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('STARTED','SUCCEEDED','FAILED','EXPIRED','FENCED')),
 failure_class text, failure_code text, owner text NOT NULL, database_principal name NOT NULL DEFAULT session_user,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind IN ('FAILED','EXPIRED'))=(failure_class IS NOT NULL)),
 CHECK((failure_class IS NULL)=(failure_code IS NULL)),
 CHECK(failure_class IS NULL OR failure_class IN ('TRANSIENT','DOMAIN_REJECTION','POISON','UNSUPPORTED','TIMEOUT','LEASE_EXPIRED')),
 CHECK(failure_code IS NULL OR (length(failure_code) BETWEEN 1 AND 128 AND failure_code ~ '^[A-Z0-9_]+$'))
);
CREATE UNIQUE INDEX one_start ON worker.attempt_event(work_id,attempt) WHERE kind='STARTED';
CREATE UNIQUE INDEX one_end ON worker.attempt_event(work_id,attempt) WHERE kind IN ('SUCCEEDED','FAILED','EXPIRED');
CREATE UNIQUE INDEX unique_lease ON worker.attempt_event(lease_token) WHERE kind='STARTED';
CREATE FUNCTION worker.register_intent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c worker.contract%ROWTYPE; h text; hv integer;
BEGIN
 SELECT * INTO c FROM worker.contract WHERE event_type=NEW.event_type AND schema_version=NEW.schema_version AND aggregate_version=NEW.aggregate_version;
 IF NOT FOUND THEN h:='unsupported'; hv:=1; ELSE h:=c.handler; hv:=c.handler_version; END IF;
 INSERT INTO worker.registration(event_id,disposition,handler,handler_version) VALUES(NEW.id,CASE WHEN h IS NULL THEN 'NO_LOCAL_HANDLER' ELSE 'WORK_REQUIRED' END,h,hv);
 IF h IS NOT NULL THEN
  INSERT INTO worker.work_item(event_id,handler,handler_version,max_attempts,base_delay_ms,max_delay_ms,lease_ms,timeout_ms)
  SELECT NEW.id,h,hv,max_attempts,base_delay_ms,max_delay_ms,lease_ms,timeout_ms FROM worker.policy WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P1000',MESSAGE='Worker policy missing'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER register_work AFTER INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION worker.register_intent();
-- Explicit v1 backfill: request rows replay their exact pinned normalizer; notifications have no local consumer.
INSERT INTO worker.registration(event_id,disposition,handler,handler_version)
 SELECT o.id,CASE WHEN c.event_type IS NULL OR c.handler IS NOT NULL THEN 'WORK_REQUIRED' ELSE 'NO_LOCAL_HANDLER' END,
 CASE WHEN c.event_type IS NULL THEN 'unsupported' ELSE c.handler END,CASE WHEN c.event_type IS NULL THEN 1 ELSE c.handler_version END
 FROM outbox.outbox_event o LEFT JOIN worker.contract c ON (c.event_type,c.schema_version,c.aggregate_version)=(o.event_type,o.schema_version,o.aggregate_version);
INSERT INTO worker.work_item(event_id,handler,handler_version,max_attempts,base_delay_ms,max_delay_ms,lease_ms,timeout_ms)
 SELECT r.event_id,r.handler,r.handler_version,p.max_attempts,p.base_delay_ms,p.max_delay_ms,p.lease_ms,p.timeout_ms
 FROM worker.registration r CROSS JOIN worker.policy p WHERE r.disposition='WORK_REQUIRED';
CREATE FUNCTION worker.validate_registration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r worker.registration%ROWTYPE;
BEGIN
 SELECT * INTO r FROM worker.registration WHERE event_id=NEW.id;
 IF NOT FOUND OR (r.disposition='WORK_REQUIRED' AND NOT EXISTS(SELECT FROM worker.work_item WHERE event_id=NEW.id AND handler=r.handler AND handler_version=r.handler_version)) THEN
  RAISE EXCEPTION USING ERRCODE='P1004',MESSAGE='Committed intent requires complete registration';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER intent_registration AFTER INSERT ON outbox.outbox_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION worker.validate_registration();
CREATE FUNCTION worker.guard_work() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Work cannot be deleted'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'PENDING' OR NOT EXISTS(SELECT FROM worker.registration r WHERE r.event_id=NEW.event_id AND r.disposition='WORK_REQUIRED' AND r.handler=NEW.handler AND r.handler_version=NEW.handler_version) THEN RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Invalid work registration'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','attempt_count','next_attempt_at','lease_token','lease_owner','lease_principal','claimed_at','lease_expires_at','last_failure_class','last_failure_code','completed_at'])<>(to_jsonb(OLD)-ARRAY['state','attempt_count','next_attempt_at','lease_token','lease_owner','lease_principal','claimed_at','lease_expires_at','last_failure_class','last_failure_code','completed_at'])
   OR OLD.state IN ('SUCCEEDED','FAILED_TERMINAL') THEN RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Immutable work identity or terminal state'; END IF;
  IF NEW.state='PROCESSING' THEN
   IF OLD.state NOT IN ('PENDING','RETRYABLE','PROCESSING') OR NEW.attempt_count<>OLD.attempt_count+1
    OR (OLD.state='PROCESSING' AND OLD.lease_expires_at>clock_timestamp())
    OR (OLD.state='RETRYABLE' AND OLD.next_attempt_at>clock_timestamp()) THEN RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Illegal claim'; END IF;
  ELSIF OLD.state<>'PROCESSING' OR NEW.state NOT IN ('SUCCEEDED','RETRYABLE','FAILED_TERMINAL') OR NEW.attempt_count<>OLD.attempt_count THEN
   RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Illegal work transition';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER work_transition BEFORE INSERT OR UPDATE OR DELETE ON worker.work_item FOR EACH ROW EXECUTE FUNCTION worker.guard_work();
CREATE FUNCTION worker.validate_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE w worker.work_item%ROWTYPE;
BEGIN
 SELECT * INTO w FROM worker.work_item WHERE id=NEW.id;
 IF w.attempt_count<>(SELECT count(*) FROM worker.attempt_event WHERE work_id=w.id AND kind='STARTED')
 OR (w.attempt_count-(CASE WHEN w.state='PROCESSING' THEN 1 ELSE 0 END))<>(SELECT count(*) FROM worker.attempt_event WHERE work_id=w.id AND kind IN ('SUCCEEDED','FAILED','EXPIRED'))
 OR (w.state='PROCESSING' AND NOT EXISTS(SELECT FROM worker.attempt_event WHERE work_id=w.id AND attempt=w.attempt_count AND lease_token=w.lease_token AND kind='STARTED'))
 OR (w.state IN ('SUCCEEDED','RETRYABLE','FAILED_TERMINAL') AND NOT EXISTS(SELECT FROM worker.attempt_event WHERE work_id=w.id AND attempt=w.attempt_count AND kind=CASE WHEN w.state='SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END OR work_id=w.id AND attempt=w.attempt_count AND kind='EXPIRED' AND w.state='FAILED_TERMINAL'))
 THEN RAISE EXCEPTION USING ERRCODE='P1004',MESSAGE='Incomplete work attempt history'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER work_history AFTER INSERT OR UPDATE ON worker.work_item DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION worker.validate_history();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['contract','registration','attempt_event'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON worker.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['contract','registration','attempt_event','work_item','policy'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON worker.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
END $$;
CREATE FUNCTION worker.claim(owner_id text, scope_book uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w worker.work_item%ROWTYPE; token uuid; now_at timestamptz; i integer;
BEGIN
 IF owner_id IS NULL OR length(owner_id) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid worker identity'; END IF;
 FOR i IN 1..32 LOOP
  now_at:=clock_timestamp();
  SELECT x.* INTO w FROM worker.work_item x JOIN outbox.outbox_event o ON o.id=x.event_id
   WHERE (scope_book IS NULL OR o.book_id=scope_book) AND (x.state='PENDING' OR (x.state='RETRYABLE' AND x.next_attempt_at<=now_at) OR (x.state='PROCESSING' AND x.lease_expires_at<=now_at))
   ORDER BY coalesce(x.next_attempt_at,x.lease_expires_at,x.created_at),x.created_at,x.id LIMIT 1 FOR UPDATE OF x SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF w.state='PROCESSING' THEN
   INSERT INTO worker.attempt_event(work_id,attempt,lease_token,kind,failure_class,failure_code,owner) VALUES(w.id,w.attempt_count,w.lease_token,'EXPIRED','LEASE_EXPIRED','LEASE_EXPIRED',w.lease_owner);
   IF w.attempt_count>=w.max_attempts THEN
    UPDATE worker.work_item SET state='FAILED_TERMINAL',last_failure_class='LEASE_EXPIRED',last_failure_code='LEASE_EXPIRED',completed_at=clock_timestamp(),lease_token=NULL,lease_owner=NULL,lease_principal=NULL,claimed_at=NULL,lease_expires_at=NULL WHERE id=w.id;
    CONTINUE;
   END IF;
  END IF;
  token:=gen_random_uuid(); now_at:=clock_timestamp();
  UPDATE worker.work_item SET state='PROCESSING',attempt_count=attempt_count+1,next_attempt_at=NULL,lease_token=token,lease_owner=owner_id,lease_principal=session_user,claimed_at=now_at,lease_expires_at=now_at+(lease_ms::text||' milliseconds')::interval,
    last_failure_class=CASE WHEN w.state='PROCESSING' THEN 'LEASE_EXPIRED' ELSE last_failure_class END,last_failure_code=CASE WHEN w.state='PROCESSING' THEN 'LEASE_EXPIRED' ELSE last_failure_code END
   WHERE id=w.id RETURNING * INTO w;
  INSERT INTO worker.attempt_event(work_id,attempt,lease_token,kind,owner) VALUES(w.id,w.attempt_count,token,'STARTED',owner_id);
  RETURN (SELECT jsonb_build_object('id',w.id,'eventId',w.event_id,'handler',w.handler,'handlerVersion',w.handler_version,'attempt',w.attempt_count,'token',token,'owner',owner_id,'timeoutMs',w.timeout_ms,'eventType',o.event_type,'schemaVersion',o.schema_version,'aggregateVersion',o.aggregate_version,'bookId',o.book_id,'batchId',o.batch_id,'normalizerVersion',o.normalizer_version,'payload',o.payload) FROM outbox.outbox_event o WHERE o.id=w.event_id);
 END LOOP;
 RETURN NULL;
END $$;
-- Called under a work-row lock; a reclaim cannot pass this boundary during the domain COMMIT.
CREATE FUNCTION worker.owns(w worker.work_item, token uuid) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(w.state='PROCESSING' AND w.lease_token=token AND w.lease_principal=session_user AND w.lease_expires_at>clock_timestamp(),false)
$$;
CREATE FUNCTION worker.complete_normalization(wid uuid,token uuid,raw uuid,res jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w worker.work_item%ROWTYPE; o outbox.outbox_event%ROWTYPE;
BEGIN
 SELECT * INTO STRICT w FROM worker.work_item WHERE id=wid FOR UPDATE;
 IF NOT worker.owns(w,token) THEN RETURN false; END IF;
 SELECT * INTO STRICT o FROM outbox.outbox_event WHERE id=w.event_id;
 IF w.handler<>'normalize-batch' OR w.handler_version<>1 OR o.event_type<>'ingestion.normalization_requested' OR o.schema_version<>1 OR o.aggregate_version<>1
 OR NOT EXISTS(SELECT FROM ingestion.raw_record WHERE id=raw AND batch_id=o.batch_id) THEN RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Work/domain scope mismatch'; END IF;
 PERFORM ingestion.complete_normalization(raw,o.normalizer_version,res);
 RETURN true;
END $$;
CREATE FUNCTION worker.finish(wid uuid,token uuid,fclass text DEFAULT NULL,fcode text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w worker.work_item%ROWTYPE; started worker.attempt_event%ROWTYPE; success boolean:=fclass IS NULL; terminal boolean; delay_ms bigint;
BEGIN
 IF (fclass IS NULL)<>(fcode IS NULL) OR (fclass IS NOT NULL AND fclass NOT IN ('TRANSIENT','DOMAIN_REJECTION','POISON','UNSUPPORTED','TIMEOUT')) OR (fcode IS NOT NULL AND (length(fcode) NOT BETWEEN 1 AND 128 OR fcode !~ '^[A-Z0-9_]+$')) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid failure classification'; END IF;
 SELECT * INTO STRICT w FROM worker.work_item WHERE id=wid FOR UPDATE;
 -- Stable token resolves a successful completion whose COMMIT acknowledgement was lost.
 IF EXISTS(SELECT FROM worker.attempt_event WHERE work_id=wid AND lease_token=token AND database_principal=session_user AND ((kind='SUCCEEDED' AND success) OR (kind='FAILED' AND NOT success AND failure_class=fclass AND failure_code=fcode))) THEN RETURN true; END IF;
 IF NOT worker.owns(w,token) THEN
  SELECT * INTO started FROM worker.attempt_event WHERE work_id=wid AND lease_token=token AND kind='STARTED' AND database_principal=session_user;
  IF FOUND THEN INSERT INTO worker.attempt_event(work_id,attempt,lease_token,kind,owner) VALUES(wid,started.attempt,token,'FENCED',started.owner); END IF;
  RETURN false;
 END IF;
 IF success AND (w.handler<>'normalize-batch' OR EXISTS(SELECT FROM ingestion.processing p JOIN ingestion.raw_record r ON r.id=p.raw_id JOIN outbox.outbox_event o ON o.batch_id=r.batch_id AND o.normalizer_version=p.normalizer_version WHERE o.id=w.event_id AND p.state='PENDING')) THEN RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Handler work incomplete'; END IF;
 terminal:=NOT success AND (fclass IN ('DOMAIN_REJECTION','POISON','UNSUPPORTED') OR w.attempt_count>=w.max_attempts);
 delay_ms:=least(w.max_delay_ms::bigint,w.base_delay_ms::bigint*(1::bigint<<least(w.attempt_count-1,30)));
 INSERT INTO worker.attempt_event(work_id,attempt,lease_token,kind,failure_class,failure_code,owner) VALUES(wid,w.attempt_count,token,CASE WHEN success THEN 'SUCCEEDED' ELSE 'FAILED' END,fclass,fcode,w.lease_owner);
 UPDATE worker.work_item SET state=CASE WHEN success THEN 'SUCCEEDED' WHEN terminal THEN 'FAILED_TERMINAL' ELSE 'RETRYABLE' END,
  next_attempt_at=CASE WHEN NOT success AND NOT terminal THEN clock_timestamp()+(delay_ms::text||' milliseconds')::interval END,
  completed_at=CASE WHEN success OR terminal THEN clock_timestamp() END,
  last_failure_class=coalesce(fclass,last_failure_class),last_failure_code=coalesce(fcode,last_failure_code),
  lease_token=NULL,lease_owner=NULL,lease_principal=NULL,claimed_at=NULL,lease_expires_at=NULL WHERE id=wid;
 RETURN true;
END $$;
CREATE VIEW worker.metrics AS SELECT
 count(*) FILTER(WHERE state='PENDING') AS pending_work_total,
 count(*) FILTER(WHERE state='PROCESSING') AS processing_work_total,
 count(*) FILTER(WHERE state='RETRYABLE') AS retryable_work_total,
 count(*) FILTER(WHERE state='FAILED_TERMINAL') AS terminal_failed_work_total,
 count(*) FILTER(WHERE state='SUCCEEDED') AS handler_success_total,
 max(clock_timestamp()-created_at) FILTER(WHERE state='PENDING') AS oldest_pending_age,
 count(*) FILTER(WHERE state='PROCESSING' AND lease_expires_at<=clock_timestamp()) AS expired_lease_total,
 (SELECT count(*) FROM worker.attempt_event WHERE kind='EXPIRED') AS lease_expiration_total,
 (SELECT count(*) FROM worker.attempt_event WHERE kind='FENCED') AS stale_worker_fence_total,
 (SELECT count(*) FROM worker.attempt_event WHERE kind='FAILED') AS handler_failure_total,
 sum(greatest(attempt_count-1,0)) AS retry_count FROM worker.work_item;
CREATE VIEW worker.status AS SELECT w.*,o.book_id,o.event_type,o.schema_version,o.aggregate_version FROM worker.work_item w JOIN outbox.outbox_event o ON o.id=w.event_id;
REVOKE ALL ON ALL TABLES IN SCHEMA worker FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA worker FROM PUBLIC;
GRANT USAGE ON SCHEMA worker,ingestion TO flow_worker;
GRANT SELECT ON worker.registration,worker.work_item,worker.attempt_event,worker.metrics,worker.status,ingestion.raw_record,ingestion.processing TO flow_worker;
GRANT EXECUTE ON FUNCTION worker.claim(text,uuid),worker.finish(uuid,uuid,text,text),worker.complete_normalization(uuid,uuid,uuid,jsonb) TO flow_worker;
RESET ROLE;
