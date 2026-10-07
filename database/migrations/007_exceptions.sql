-- Phase 8: operational cases never write reconciliation or accounting truth.
RESET ROLE;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['flow_exception_reader','flow_exception_writer'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r); END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe exception role'; END IF;
 END LOOP;
END $$;
GRANT flow_exception_reader TO flow_exception_writer;
CREATE SCHEMA exceptions AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA exceptions FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
CREATE TABLE exceptions.case_record(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mapping_id uuid NOT NULL REFERENCES reconciliation.account_mapping ON DELETE RESTRICT,
 item_id uuid NOT NULL REFERENCES reconciliation.item ON DELETE RESTRICT, original_run_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(mapping_id,item_id), FOREIGN KEY(original_run_id,item_id) REFERENCES reconciliation.outcome(run_id,item_id) ON DELETE RESTRICT
);
CREATE TABLE exceptions.event(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), case_id uuid NOT NULL REFERENCES exceptions.case_record ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0), command_key text NOT NULL CHECK(length(command_key) BETWEEN 1 AND 512), command jsonb NOT NULL,
 action text NOT NULL CHECK(action IN ('CREATED','OBSERVED','SUPERSEDE','START_REVIEW','AWAIT_EVIDENCE','RESUME_REVIEW','RESOLVE','REOPEN','CLASSIFY','ASSIGN','NOTE','ATTACH')),
 previous_state text NOT NULL CHECK(previous_state IN ('ABSENT','OPEN','UNDER_REVIEW','AWAITING_EVIDENCE','RESOLVED')),
 state text NOT NULL CHECK(state IN ('OPEN','UNDER_REVIEW','AWAITING_EVIDENCE','RESOLVED')),
 classification text NOT NULL CHECK(classification IN ('MISSING_BANK_MOVEMENT','EXTRA_BANK_MOVEMENT','AMOUNT_MISMATCH','AMBIGUOUS_MATCH','PROCESSOR_INCONSISTENCY','BANK_INCONSISTENCY','SOURCE_INCOMPLETENESS','SOURCE_REVISION_AMBIGUITY','DUPLICATE_EVIDENCE','TIMING_LATE_ARRIVAL','UNSUPPORTED_CASE','CURRENT_PROOF_INVALIDATED')),
 assignee_id text CHECK(length(assignee_id) BETWEEN 1 AND 512),
 resolution text CHECK(resolution IN ('SOURCE_CORRECTION_REQUIRED','PROCESSOR_FEE_CONFIRMED','TIMING_DIFFERENCE','DUPLICATE_SOURCE_RECORD','ACCEPTED_RISK','ACCOUNTING_ADJUSTMENT_REQUIRED','NOT_RECONCILED','UNSUPPORTED_SOURCE','OTHER','FIXED_AND_VERIFIED')),
 evidence_run_id uuid NOT NULL REFERENCES reconciliation.run ON DELETE RESTRICT,
 actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 512), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 4000),
 note text CHECK(length(note) BETWEEN 1 AND 4000), CHECK((action='NOTE')=(note IS NOT NULL)), CHECK((state='RESOLVED')=(resolution IS NOT NULL)),
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 UNIQUE(case_id,version), UNIQUE(case_id,command_key)
);
CREATE TABLE exceptions.occurrence(
 case_id uuid NOT NULL REFERENCES exceptions.case_record ON DELETE RESTRICT, run_id uuid NOT NULL, item_id uuid NOT NULL,
 event_id uuid NOT NULL REFERENCES exceptions.event ON DELETE RESTRICT, condition jsonb NOT NULL,
 classification text NOT NULL, currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 exposure_minor bigint CHECK(exposure_minor>=0), exposure_reason text NOT NULL,
 PRIMARY KEY(case_id,run_id), FOREIGN KEY(run_id,item_id) REFERENCES reconciliation.outcome(run_id,item_id) ON DELETE RESTRICT
);
CREATE TABLE exceptions.attachment(
 event_id uuid PRIMARY KEY REFERENCES exceptions.event ON DELETE RESTRICT,
 processor_activity_id uuid REFERENCES processor.activity ON DELETE RESTRICT,
 processor_settlement_id uuid REFERENCES processor.settlement_batch ON DELETE RESTRICT,
 bank_entry_id uuid REFERENCES bank.entry ON DELETE RESTRICT,
 reconciliation_run_id uuid REFERENCES reconciliation.run ON DELETE RESTRICT,
 match_group_id uuid REFERENCES reconciliation.match_group ON DELETE RESTRICT,
 processor_control_id uuid REFERENCES processor.evaluation ON DELETE RESTRICT,
 bank_control_id uuid REFERENCES bank.evaluation ON DELETE RESTRICT,
 source_record_id uuid REFERENCES ingestion.raw_record ON DELETE RESTRICT,
 CHECK(num_nonnulls(processor_activity_id,processor_settlement_id,bank_entry_id,reconciliation_run_id,match_group_id,processor_control_id,bank_control_id,source_record_id)=1)
);
CREATE VIEW exceptions.current_case AS
 SELECT c.*,e.id AS event_id,e.version,e.state,e.classification,e.assignee_id,e.resolution,e.evidence_run_id,
 e.created_at AS updated_at FROM exceptions.case_record c JOIN LATERAL(SELECT * FROM exceptions.event WHERE case_id=c.id ORDER BY version DESC LIMIT 1) e ON true;
-- Stable, exact immutable financial cause; run IDs are navigation, not condition identity.
CREATE FUNCTION exceptions.cause(rid uuid,iid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE m reconciliation.run_member%ROWTYPE; o reconciliation.outcome%ROWTYPE; r reconciliation.run%ROWTYPE;  cls text; amount numeric; exposure numeric; exwhy text; edges jsonb; grouped jsonb; condition jsonb;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid;
 SELECT * INTO STRICT m FROM reconciliation.run_member WHERE run_id=rid AND item_id=iid;
 SELECT * INTO STRICT o FROM reconciliation.outcome WHERE run_id=rid AND item_id=iid;
 IF r.state<>'COMPLETED' THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Cases require completed outcomes'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(c)-'run_id' ORDER BY c.processor_item_id,c.bank_item_id),'[]') INTO edges FROM reconciliation.candidate c WHERE run_id=rid AND (processor_item_id=iid OR bank_item_id=iid);
 SELECT coalesce(jsonb_agg(to_jsonb(c)-'run_id' ORDER BY c.group_key_hash,c.bank_item_id),'[]') INTO grouped FROM reconciliation.group_candidate c WHERE run_id=rid AND (bank_item_id=iid OR iid=ANY(processor_item_ids));
 IF o.outcome='MATCHED' THEN
  IF EXISTS(SELECT FROM reconciliation.active_allocation WHERE item_id=iid) THEN RETURN NULL; END IF;
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
-- Extend existing union constraints without rewriting a prior companion or weakening its branch.
ALTER TABLE audit.audit_event ADD COLUMN exception_event_id uuid UNIQUE REFERENCES exceptions.event ON DELETE RESTRICT;
ALTER TABLE outbox.outbox_event ADD COLUMN exception_event_id uuid UNIQUE REFERENCES exceptions.event ON DELETE RESTRICT;
DO $$ DECLARE t text; c record; expr text; branch text; BEGIN
 FOREACH t IN ARRAY ARRAY['audit.audit_event','outbox.outbox_event'] LOOP
  branch:=CASE WHEN t='audit.audit_event' THEN $branch$exception_event_id IS NOT NULL AND action='exception.decision' AND reversal_of IS NULL AND command_key IS NULL AND policy_version='exception-workflow-v1'$branch$ ELSE $branch$exception_event_id IS NOT NULL AND event_type IN ('exception.created','exception.resolved','exception.reopened','exception.updated') AND normalizer_version IS NULL AND command_key IS NULL AND aggregate_version=1 AND schema_version=1 AND payload=jsonb_build_object('bookId',book_id,'eventId',exception_event_id)$branch$ END;
  FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expr FROM pg_constraint WHERE conrelid=t::regclass AND contype='c' AND (pg_get_expr(conbin,conrelid) LIKE '%num_nonnulls%' OR pg_get_expr(conbin,conrelid) ~ '(action|previous_state|new_state|payload|event_type)') LOOP
   expr:=c.expr;
   EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',t,c.conname);
   EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK ((exception_event_id IS NULL AND (%s)) OR (%s))',t,c.conname,expr,branch);
  END LOOP;
 END LOOP;
END $$;
ALTER TABLE audit.audit_event ADD CHECK(exception_event_id IS NULL OR num_nonnulls(account_id,journal_id,batch_id,revision_id,processor_evaluation_id,bank_evaluation_id,reconciliation_decision_id)=0);
ALTER TABLE outbox.outbox_event ADD CHECK(exception_event_id IS NULL OR num_nonnulls(account_id,journal_id,batch_id,processor_derivation_id,bank_derivation_id,reconciliation_decision_id,reconciliation_run_id)=0);
CREATE FUNCTION exceptions.companions(eid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e exceptions.event%ROWTYPE; bk uuid;
BEGIN
 SELECT * INTO STRICT e FROM exceptions.event WHERE id=eid;
 SELECT m.book_id INTO STRICT bk FROM exceptions.case_record c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE c.id=e.case_id;
 INSERT INTO audit.audit_event(book_id,exception_event_id,action,actor_id,previous_state,new_state,reason,policy_version)
 VALUES(bk,e.id,'exception.decision',e.actor_id,e.previous_state,e.state,left(e.reason,512),'exception-workflow-v1');
 INSERT INTO outbox.outbox_event(book_id,exception_event_id,event_type,aggregate_version,schema_version,payload)
 VALUES(bk,e.id,CASE e.action WHEN 'CREATED' THEN 'exception.created' WHEN 'RESOLVE' THEN 'exception.resolved' WHEN 'REOPEN' THEN 'exception.reopened' ELSE 'exception.updated' END,1,1,jsonb_build_object('bookId',bk,'eventId',e.id));
END $$;
-- Same ordering as reconciliation: book, sorted sources, case. No reconciliation writes.
CREATE FUNCTION exceptions.lock_scope(mid uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE m reconciliation.account_mapping%ROWTYPE;
BEGIN
 SELECT * INTO STRICT m FROM reconciliation.account_mapping WHERE id=mid;
 PERFORM FROM ledger.book WHERE id=m.book_id FOR NO KEY UPDATE;
 PERFORM FROM ingestion.source_account WHERE id IN (m.processor_source_account_id,m.bank_source_account_id) ORDER BY id FOR UPDATE;
END $$;
CREATE FUNCTION exceptions.generate(p jsonb) RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; o record; c exceptions.case_record%ROWTYPE; prev exceptions.event%ROWTYPE; cause jsonb; prior jsonb; eid uuid; act text; result uuid[]:='{}';
BEGIN
 IF jsonb_typeof(p)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>2 OR coalesce(length(btrim(p->>'actorId')),0) NOT BETWEEN 1 AND 512 THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Invalid exception generation'; END IF;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=(p->>'runId')::uuid;
 IF r.state<>'COMPLETED' THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Incomplete run'; END IF;
 PERFORM exceptions.lock_scope(r.mapping_id);
 FOR o IN SELECT * FROM reconciliation.outcome WHERE run_id=r.id ORDER BY item_id LOOP
  SELECT * INTO c FROM exceptions.case_record WHERE mapping_id=r.mapping_id AND item_id=o.item_id FOR UPDATE;
  IF c.id IS NOT NULL AND EXISTS(SELECT FROM exceptions.occurrence WHERE case_id=c.id AND run_id=r.id) THEN result:=array_append(result,c.id); CONTINUE; END IF;
  cause:=exceptions.cause(r.id,o.item_id); IF cause IS NULL THEN CONTINUE; END IF;
  IF c.id IS NULL THEN
   INSERT INTO exceptions.case_record(mapping_id,item_id,original_run_id) VALUES(r.mapping_id,o.item_id,r.id) RETURNING * INTO c;
   prev:=NULL; act:='CREATED';
  ELSE
   SELECT * INTO STRICT prev FROM exceptions.event WHERE case_id=c.id ORDER BY version DESC LIMIT 1;
   -- Replaying previously seen financial conditions must not reopen a reviewed conclusion.
   SELECT condition INTO prior FROM exceptions.occurrence WHERE case_id=c.id AND condition=cause->'condition' LIMIT 1;
   act:=CASE WHEN prev.state='RESOLVED' AND prior IS NULL THEN 'REOPEN' ELSE 'OBSERVED' END;
  END IF;
  INSERT INTO exceptions.event(case_id,version,command_key,command,action,previous_state,state,classification,assignee_id,resolution,evidence_run_id,actor_id,reason)
  VALUES(c.id,coalesce(prev.version,0)+1,'outcome:'||r.id,jsonb_build_object('runId',r.id,'itemId',o.item_id),act,coalesce(prev.state,'ABSENT'),
   CASE WHEN act='CREATED' THEN 'OPEN' WHEN act='REOPEN' THEN 'UNDER_REVIEW' ELSE prev.state END,
   CASE WHEN act IN ('CREATED','REOPEN') THEN cause->>'classification' ELSE prev.classification END,prev.assignee_id,
   CASE WHEN act='OBSERVED' THEN prev.resolution END,r.id,p->>'actorId','Immutable reconciliation outcome observed; review remains separate from financial proof') RETURNING id INTO eid;
  INSERT INTO exceptions.occurrence(case_id,run_id,item_id,event_id,condition,classification,currency,exposure_minor,exposure_reason)
  VALUES(c.id,r.id,o.item_id,eid,cause->'condition',cause->>'classification',cause->>'currency',(cause->>'exposureMinor')::bigint,cause->>'exposureReason');
  PERFORM exceptions.companions(eid); result:=array_append(result,c.id);
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION exceptions.case_view(cid uuid,ver integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('id',c.id,'mappingId',c.mapping_id,'itemId',c.item_id,'originalRunId',c.original_run_id,'evidenceRunId',e.evidence_run_id,'version',e.version,'state',e.state,'classification',e.classification,'assigneeId',e.assignee_id,'resolution',e.resolution,
 'currency',m.currency,'side',i.side,'exposure',CASE WHEN occ.exposure_minor IS NOT NULL THEN jsonb_build_object('amountMinor',occ.exposure_minor::text,'currency',occ.currency) END,'exposureReason',coalesce(occ.exposure_reason,'VERIFIED_LATER_EVIDENCE'),
 'createdAt',c.created_at,'stateSince',(SELECT created_at FROM exceptions.event WHERE case_id=c.id AND version<=e.version AND state<>previous_state ORDER BY version DESC LIMIT 1),
 'firstReviewAt',(SELECT min(created_at) FROM exceptions.event WHERE case_id=c.id AND version<=e.version AND state='UNDER_REVIEW'),
 'resolvedAt',(SELECT created_at FROM exceptions.event WHERE case_id=c.id AND version<=e.version AND action IN ('RESOLVE','SUPERSEDE') ORDER BY version DESC LIMIT 1),
 'currentlyReconciled',EXISTS(SELECT FROM reconciliation.active_allocation WHERE item_id=c.item_id))
 FROM exceptions.case_record c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id JOIN reconciliation.item i ON i.id=c.item_id
 JOIN LATERAL(SELECT * FROM exceptions.event WHERE case_id=c.id AND (ver IS NULL OR version=ver) ORDER BY version DESC LIMIT 1) e ON true
 LEFT JOIN LATERAL(SELECT * FROM exceptions.occurrence WHERE case_id=c.id AND event_id IN(SELECT id FROM exceptions.event WHERE case_id=c.id AND version<=e.version) ORDER BY (SELECT version FROM exceptions.event WHERE id=event_id) DESC LIMIT 1) occ ON true WHERE c.id=cid
$$;
CREATE FUNCTION exceptions.apply(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c exceptions.case_record%ROWTYPE; prev exceptions.event%ROWTYPE; old exceptions.event%ROWTYPE; eid uuid; ns text; act text:=p->>'action'; er uuid; o reconciliation.outcome%ROWTYPE; kind text; target uuid;  cause jsonb;
BEGIN
 IF jsonb_typeof(p)<>'object' OR coalesce(length(btrim(p->>'actorId')),0) NOT BETWEEN 1 AND 512 OR coalesce(length(btrim(p->>'reason')),0) NOT BETWEEN 1 AND 4000 OR coalesce(length(btrim(p->>'commandKey')),0) NOT BETWEEN 1 AND 512 OR coalesce(p->>'expectedVersion','')!~'^[1-9][0-9]*$'
 OR p->>'commandKey' LIKE 'outcome:%'
 OR act NOT IN ('SUPERSEDE','START_REVIEW','AWAIT_EVIDENCE','RESUME_REVIEW','RESOLVE','REOPEN','CLASSIFY','ASSIGN','NOTE','ATTACH') OR act IS NULL
 OR (act='CLASSIFY')<>(p ? 'classification') OR (act='ASSIGN')<>(p ? 'assigneeId') OR (act='NOTE')<>(p ? 'note') OR (act='ATTACH')<>(p ? 'attachment') OR (act='RESOLVE')<>(p ? 'resolution')
 OR (act IN ('REOPEN','SUPERSEDE') OR coalesce(p->>'resolution'='FIXED_AND_VERIFIED',false))<>(p ? 'evidenceRunId')
 OR EXISTS(SELECT FROM jsonb_object_keys(p) k WHERE k NOT IN ('caseId','commandKey','expectedVersion','actorId','reason','action','classification','assigneeId','resolution','evidenceRunId','note','attachment'))
 THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Invalid exception command'; END IF;
 SELECT * INTO STRICT c FROM exceptions.case_record WHERE id=(p->>'caseId')::uuid;
 PERFORM exceptions.lock_scope(c.mapping_id);
 PERFORM FROM exceptions.case_record WHERE id=c.id FOR UPDATE;
 SELECT * INTO old FROM exceptions.event WHERE case_id=c.id AND command_key=p->>'commandKey';
 IF FOUND THEN
  IF old.command IS DISTINCT FROM p THEN RAISE EXCEPTION USING ERRCODE='P8001',MESSAGE='Exception command identity conflict'; END IF;
  RETURN exceptions.case_view(c.id,old.version);
 END IF;
 SELECT * INTO STRICT prev FROM exceptions.event WHERE case_id=c.id ORDER BY version DESC LIMIT 1;
 IF prev.version<>(p->>'expectedVersion')::integer THEN RAISE EXCEPTION USING ERRCODE='P8005',MESSAGE='Stale exception version'; END IF;
 ns:=CASE WHEN act='SUPERSEDE' AND prev.state='RESOLVED' THEN 'RESOLVED' WHEN act='START_REVIEW' AND prev.state='OPEN' THEN 'UNDER_REVIEW'
  WHEN act='AWAIT_EVIDENCE' AND prev.state='UNDER_REVIEW' THEN 'AWAITING_EVIDENCE'
  WHEN act='RESUME_REVIEW' AND prev.state='AWAITING_EVIDENCE' THEN 'UNDER_REVIEW'
  WHEN act='RESOLVE' AND prev.state='UNDER_REVIEW' THEN 'RESOLVED'
  WHEN act='REOPEN' AND prev.state='RESOLVED' THEN 'UNDER_REVIEW'
  WHEN act IN ('NOTE','ATTACH') OR (act IN ('CLASSIFY','ASSIGN') AND prev.state<>'RESOLVED') THEN prev.state END;
 IF ns IS NULL THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Illegal exception transition'; END IF;
 er:=coalesce((p->>'evidenceRunId')::uuid,prev.evidence_run_id);
 IF act IN ('REOPEN','SUPERSEDE') OR p->>'resolution'='FIXED_AND_VERIFIED' THEN
  SELECT o1.* INTO STRICT o FROM reconciliation.outcome o1 JOIN reconciliation.run r ON r.id=o1.run_id WHERE o1.run_id=er AND o1.item_id=c.item_id AND r.mapping_id=c.mapping_id AND r.state='COMPLETED';
  IF er=prev.evidence_run_id THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='A new run is required'; END IF;
  IF act='REOPEN' THEN
   cause:=exceptions.cause(er,c.item_id);
   IF cause IS NULL OR cause->'condition'=(SELECT condition FROM exceptions.occurrence WHERE case_id=c.id AND run_id=prev.evidence_run_id) THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Reopening requires changed unresolved evidence'; END IF;
  ELSIF o.outcome<>'MATCHED' OR NOT EXISTS(SELECT FROM reconciliation.active_allocation WHERE item_id=c.item_id AND group_id=o.group_id) THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Verified resolution requires fresh current allocation'; END IF;
 END IF;
 INSERT INTO exceptions.event(case_id,version,command_key,command,action,previous_state,state,classification,assignee_id,resolution,evidence_run_id,actor_id,reason,note)
 VALUES(c.id,prev.version+1,p->>'commandKey',p,act,prev.state,ns,coalesce(p->>'classification',prev.classification),
  CASE WHEN act='ASSIGN' THEN p->>'assigneeId' ELSE prev.assignee_id END,
  CASE WHEN act='SUPERSEDE' THEN 'FIXED_AND_VERIFIED' WHEN act='RESOLVE' THEN p->>'resolution' WHEN act='REOPEN' THEN NULL ELSE prev.resolution END,er,p->>'actorId',p->>'reason',p->>'note') RETURNING id INTO eid;
 IF act='REOPEN' AND NOT EXISTS(SELECT FROM exceptions.occurrence WHERE case_id=c.id AND run_id=er) THEN
  INSERT INTO exceptions.occurrence(case_id,run_id,item_id,event_id,condition,classification,currency,exposure_minor,exposure_reason)
  VALUES(c.id,er,c.item_id,eid,cause->'condition',cause->>'classification',cause->>'currency',(cause->>'exposureMinor')::bigint,cause->>'exposureReason');
 END IF;
 IF act='ATTACH' THEN
  kind:=p->'attachment'->>'kind'; target:=(p->'attachment'->>'id')::uuid;
  IF kind NOT IN ('PROCESSOR_ACTIVITY','PROCESSOR_SETTLEMENT','BANK_ENTRY','RECONCILIATION_RUN','MATCH_GROUP','PROCESSOR_CONTROL','BANK_CONTROL','SOURCE_RECORD') OR kind IS NULL OR (SELECT count(*) FROM jsonb_object_keys(p->'attachment'))<>2 THEN RAISE EXCEPTION USING ERRCODE='P8002',MESSAGE='Invalid evidence reference'; END IF;
  INSERT INTO exceptions.attachment VALUES(eid,CASE WHEN kind='PROCESSOR_ACTIVITY' THEN target END,CASE WHEN kind='PROCESSOR_SETTLEMENT' THEN target END,CASE WHEN kind='BANK_ENTRY' THEN target END,CASE WHEN kind='RECONCILIATION_RUN' THEN target END,CASE WHEN kind='MATCH_GROUP' THEN target END,CASE WHEN kind='PROCESSOR_CONTROL' THEN target END,CASE WHEN kind='BANK_CONTROL' THEN target END,CASE WHEN kind='SOURCE_RECORD' THEN target END);
 END IF;
 PERFORM exceptions.companions(eid);
 RETURN exceptions.case_view(c.id);
END $$;
CREATE FUNCTION exceptions.guard_case() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.creation_transaction<>pg_current_xact_id() OR NEW.created_at<>transaction_timestamp() OR NOT EXISTS(SELECT FROM reconciliation.run WHERE id=NEW.original_run_id AND mapping_id=NEW.mapping_id AND state='COMPLETED') OR exceptions.cause(NEW.original_run_id,NEW.item_id) IS NULL THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Invalid case origin'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER case_origin BEFORE INSERT ON exceptions.case_record FOR EACH ROW EXECUTE FUNCTION exceptions.guard_case();
CREATE FUNCTION exceptions.guard_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE c exceptions.case_record%ROWTYPE; prev exceptions.event%ROWTYPE; ns text; cause jsonb;
BEGIN
 SELECT * INTO STRICT c FROM exceptions.case_record WHERE id=NEW.case_id FOR UPDATE;
 SELECT * INTO prev FROM exceptions.event WHERE case_id=c.id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>coalesce(prev.version,0)+1 OR NEW.previous_state<>coalesce(prev.state,'ABSENT') OR NEW.creation_transaction<>pg_current_xact_id() OR NEW.created_at<>transaction_timestamp()
 OR NOT EXISTS(SELECT FROM reconciliation.run r JOIN reconciliation.outcome o ON o.run_id=r.id WHERE r.id=NEW.evidence_run_id AND o.item_id=c.item_id AND r.mapping_id=c.mapping_id AND r.state='COMPLETED')
 THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Invalid event chain or evidence'; END IF;
 IF NEW.action IN ('CREATED','OBSERVED') OR (NEW.action='REOPEN' AND NEW.command_key='outcome:'||NEW.evidence_run_id) THEN
  cause:=exceptions.cause(NEW.evidence_run_id,c.item_id);
  IF cause IS NULL OR NEW.command IS DISTINCT FROM jsonb_build_object('runId',NEW.evidence_run_id,'itemId',c.item_id) OR NEW.command_key<>'outcome:'||NEW.evidence_run_id
  OR (NEW.action='CREATED' AND (prev.id IS NOT NULL OR NEW.evidence_run_id<>c.original_run_id OR c.creation_transaction<>pg_current_xact_id()))
  OR (NEW.action='OBSERVED' AND (prev.id IS NULL OR (prev.state='RESOLVED' AND NOT EXISTS(SELECT FROM exceptions.occurrence WHERE case_id=c.id AND condition=cause->'condition'))))
  OR (NEW.action='REOPEN' AND (prev.state<>'RESOLVED' OR EXISTS(SELECT FROM exceptions.occurrence WHERE case_id=c.id AND condition=cause->'condition')))
  OR NEW.classification IS DISTINCT FROM (CASE WHEN NEW.action='OBSERVED' THEN prev.classification ELSE cause->>'classification' END)
  OR NEW.assignee_id IS DISTINCT FROM prev.assignee_id OR NEW.resolution IS DISTINCT FROM (CASE WHEN NEW.action='OBSERVED' THEN prev.resolution END)
  THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Invalid generated event'; END IF;
  ns:=CASE NEW.action WHEN 'CREATED' THEN 'OPEN' WHEN 'REOPEN' THEN 'UNDER_REVIEW' ELSE prev.state END;
 ELSE
  IF prev.id IS NULL OR NEW.command->>'caseId' IS DISTINCT FROM c.id::text OR NEW.command->>'commandKey' IS DISTINCT FROM NEW.command_key OR NEW.command->>'action' IS DISTINCT FROM NEW.action OR (NEW.command->>'expectedVersion')::integer IS DISTINCT FROM prev.version
  OR NEW.command->>'actorId' IS DISTINCT FROM NEW.actor_id OR NEW.command->>'reason' IS DISTINCT FROM NEW.reason OR NEW.note IS DISTINCT FROM NEW.command->>'note'
  OR NEW.classification IS DISTINCT FROM (CASE WHEN NEW.action='CLASSIFY' THEN NEW.command->>'classification' ELSE prev.classification END)
  OR NEW.assignee_id IS DISTINCT FROM (CASE WHEN NEW.action='ASSIGN' THEN NEW.command->>'assigneeId' ELSE prev.assignee_id END)
  OR NEW.resolution IS DISTINCT FROM (CASE WHEN NEW.action='SUPERSEDE' THEN 'FIXED_AND_VERIFIED' WHEN NEW.action='RESOLVE' THEN NEW.command->>'resolution' WHEN NEW.action='REOPEN' THEN NULL ELSE prev.resolution END)
  OR NEW.evidence_run_id IS DISTINCT FROM coalesce((NEW.command->>'evidenceRunId')::uuid,prev.evidence_run_id)
  THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Forged decision fields'; END IF;
  ns:=CASE WHEN NEW.action='SUPERSEDE' AND prev.state='RESOLVED' THEN 'RESOLVED' WHEN NEW.action='START_REVIEW' AND prev.state='OPEN' THEN 'UNDER_REVIEW' WHEN NEW.action='AWAIT_EVIDENCE' AND prev.state='UNDER_REVIEW' THEN 'AWAITING_EVIDENCE' WHEN NEW.action='RESUME_REVIEW' AND prev.state='AWAITING_EVIDENCE' THEN 'UNDER_REVIEW' WHEN NEW.action='RESOLVE' AND prev.state='UNDER_REVIEW' THEN 'RESOLVED' WHEN NEW.action='REOPEN' AND prev.state='RESOLVED' THEN 'UNDER_REVIEW' WHEN NEW.action IN ('NOTE','ATTACH') OR (NEW.action IN ('CLASSIFY','ASSIGN') AND prev.state<>'RESOLVED') THEN prev.state END;
  IF NEW.resolution='FIXED_AND_VERIFIED' AND NEW.action IN ('RESOLVE','SUPERSEDE') AND NOT EXISTS(SELECT FROM reconciliation.outcome o JOIN reconciliation.active_allocation a ON a.item_id=o.item_id AND a.group_id=o.group_id WHERE o.run_id=NEW.evidence_run_id AND o.item_id=c.item_id AND o.outcome='MATCHED' AND o.run_id<>prev.evidence_run_id) THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Resolution cannot assert reconciliation'; END IF;
  IF NEW.action='REOPEN' AND (NEW.evidence_run_id=prev.evidence_run_id OR exceptions.cause(NEW.evidence_run_id,c.item_id) IS NULL OR exceptions.cause(NEW.evidence_run_id,c.item_id)->'condition'=(SELECT condition FROM exceptions.occurrence WHERE case_id=c.id AND run_id=prev.evidence_run_id)) THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Reopening requires unresolved later proof'; END IF;
 END IF;
 IF ns IS NULL OR NEW.state<>ns THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Invalid exception state transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER event_chain BEFORE INSERT ON exceptions.event FOR EACH ROW EXECUTE FUNCTION exceptions.guard_event();
CREATE FUNCTION exceptions.guard_occurrence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE c exceptions.case_record%ROWTYPE; e exceptions.event%ROWTYPE; cause jsonb;
BEGIN
 SELECT * INTO STRICT c FROM exceptions.case_record WHERE id=NEW.case_id;
 SELECT * INTO STRICT e FROM exceptions.event WHERE id=NEW.event_id;
 cause:=exceptions.cause(NEW.run_id,NEW.item_id);
 IF NEW.item_id<>c.item_id OR e.case_id<>c.id OR e.evidence_run_id<>NEW.run_id OR e.creation_transaction<>pg_current_xact_id() OR cause IS NULL
 OR e.action NOT IN ('CREATED','OBSERVED','REOPEN')
 OR NEW.condition IS DISTINCT FROM cause->'condition' OR NEW.classification IS DISTINCT FROM cause->>'classification' OR NEW.currency IS DISTINCT FROM cause->>'currency' OR NEW.exposure_minor IS DISTINCT FROM (cause->>'exposureMinor')::bigint OR NEW.exposure_reason IS DISTINCT FROM cause->>'exposureReason'
 THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Forged exception exposure or evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER occurrence_proof BEFORE INSERT ON exceptions.occurrence FOR EACH ROW EXECUTE FUNCTION exceptions.guard_occurrence();
CREATE FUNCTION exceptions.guard_attachment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e exceptions.event%ROWTYPE; m reconciliation.account_mapping%ROWTYPE; src uuid; mid uuid; target uuid; kind text;
BEGIN
 SELECT * INTO STRICT e FROM exceptions.event WHERE id=NEW.event_id;
 SELECT mapping.* INTO STRICT m FROM exceptions.case_record c JOIN reconciliation.account_mapping mapping ON mapping.id=c.mapping_id WHERE c.id=e.case_id;
 kind:=e.command->'attachment'->>'kind'; target:=(e.command->'attachment'->>'id')::uuid;
 IF e.action<>'ATTACH' OR e.creation_transaction<>pg_current_xact_id() OR
  (CASE kind WHEN 'PROCESSOR_ACTIVITY' THEN NEW.processor_activity_id WHEN 'PROCESSOR_SETTLEMENT' THEN NEW.processor_settlement_id WHEN 'BANK_ENTRY' THEN NEW.bank_entry_id WHEN 'RECONCILIATION_RUN' THEN NEW.reconciliation_run_id WHEN 'MATCH_GROUP' THEN NEW.match_group_id WHEN 'PROCESSOR_CONTROL' THEN NEW.processor_control_id WHEN 'BANK_CONTROL' THEN NEW.bank_control_id WHEN 'SOURCE_RECORD' THEN NEW.source_record_id END) IS DISTINCT FROM target
 THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Invalid attachment decision'; END IF;
 IF NEW.processor_activity_id IS NOT NULL THEN SELECT source_account_id INTO STRICT src FROM processor.activity WHERE id=NEW.processor_activity_id;
 ELSIF NEW.processor_settlement_id IS NOT NULL THEN SELECT source_account_id INTO STRICT src FROM processor.settlement_batch WHERE id=NEW.processor_settlement_id;
 ELSIF NEW.bank_entry_id IS NOT NULL THEN SELECT source_account_id INTO STRICT src FROM bank.entry WHERE id=NEW.bank_entry_id;
 ELSIF NEW.processor_control_id IS NOT NULL THEN SELECT source_account_id INTO STRICT src FROM processor.evaluation WHERE id=NEW.processor_control_id;
 ELSIF NEW.bank_control_id IS NOT NULL THEN SELECT source_account_id INTO STRICT src FROM bank.evaluation WHERE id=NEW.bank_control_id;
 ELSIF NEW.source_record_id IS NOT NULL THEN SELECT source_account_id INTO STRICT src FROM ingestion.raw_record WHERE id=NEW.source_record_id;
 ELSE SELECT r.mapping_id INTO STRICT mid FROM reconciliation.run r WHERE r.id=coalesce(NEW.reconciliation_run_id,(SELECT run_id FROM reconciliation.match_group WHERE id=NEW.match_group_id)); END IF;
 IF (src IS NOT NULL AND src NOT IN (m.processor_source_account_id,m.bank_source_account_id)) OR (mid IS NOT NULL AND mid<>m.id)
 OR (NEW.processor_activity_id IS NOT NULL AND src<>m.processor_source_account_id) OR (NEW.processor_settlement_id IS NOT NULL AND src<>m.processor_source_account_id) OR (NEW.bank_entry_id IS NOT NULL AND src<>m.bank_source_account_id)
 THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Cross-scope attachment'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attachment_scope BEFORE INSERT ON exceptions.attachment FOR EACH ROW EXECUTE FUNCTION exceptions.guard_attachment();
CREATE FUNCTION exceptions.guard_companion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE e exceptions.event%ROWTYPE; bk uuid;
BEGIN
 IF NEW.exception_event_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT e FROM exceptions.event WHERE id=NEW.exception_event_id;
 SELECT m.book_id INTO STRICT bk FROM exceptions.case_record c JOIN reconciliation.account_mapping m ON m.id=c.mapping_id WHERE c.id=e.case_id;
 IF NEW.book_id<>bk OR e.creation_transaction<>pg_current_xact_id() OR NEW.created_at<>transaction_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Invalid exception companion scope'; END IF;
 IF TG_TABLE_SCHEMA='audit' THEN
  IF NEW.actor_id<>e.actor_id OR NEW.database_principal<>session_user OR NEW.previous_state<>e.previous_state OR NEW.new_state<>e.state OR NEW.reason<>left(e.reason,512) THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Invalid exception audit'; END IF;
 ELSE
  IF NEW.event_type<>(CASE e.action WHEN 'CREATED' THEN 'exception.created' WHEN 'RESOLVE' THEN 'exception.resolved' WHEN 'REOPEN' THEN 'exception.reopened' ELSE 'exception.updated' END) THEN RAISE EXCEPTION USING ERRCODE='P8003',MESSAGE='Invalid exception intent'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER exception_audit BEFORE INSERT ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION exceptions.guard_companion();
CREATE TRIGGER exception_outbox BEFORE INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION exceptions.guard_companion();
CREATE FUNCTION exceptions.validate_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM audit.audit_event WHERE exception_event_id=NEW.id) OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE exception_event_id=NEW.id)
 OR (NEW.action='ATTACH' AND NOT EXISTS(SELECT FROM exceptions.attachment WHERE event_id=NEW.id))
 OR (NEW.action IN ('CREATED','OBSERVED') AND NOT EXISTS(SELECT FROM exceptions.occurrence WHERE event_id=NEW.id))
 OR (NEW.action='REOPEN' AND NOT EXISTS(SELECT FROM exceptions.occurrence WHERE case_id=NEW.case_id AND run_id=NEW.evidence_run_id))
 THEN RAISE EXCEPTION USING ERRCODE='P8004',MESSAGE='Incomplete exception transaction'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER event_commit AFTER INSERT ON exceptions.event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION exceptions.validate_event();
CREATE FUNCTION exceptions.validate_case() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM exceptions.event WHERE case_id=NEW.id AND version=1 AND action='CREATED') THEN RAISE EXCEPTION USING ERRCODE='P8004',MESSAGE='Case requires attributable creation'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER case_commit AFTER INSERT ON exceptions.case_record DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION exceptions.validate_case();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['case_record','event','occurrence','attachment'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_exception BEFORE UPDATE OR DELETE ON exceptions.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON exceptions.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
END $$;
CREATE VIEW exceptions.operational_metrics AS
 SELECT c.id,c.mapping_id,c.state,c.classification,c.resolution,c.assignee_id,c.version,i.side,occ.currency,occ.exposure_minor,occ.exposure_reason,
 EXISTS(SELECT FROM reconciliation.active_allocation WHERE item_id=c.item_id) AS currently_reconciled,
 c.created_at,extract(epoch FROM statement_timestamp()-c.created_at) AS age_seconds,
 extract(epoch FROM statement_timestamp()-(SELECT created_at FROM exceptions.event WHERE case_id=c.id AND state<>previous_state ORDER BY version DESC LIMIT 1)) AS state_age_seconds,
 (SELECT extract(epoch FROM min(created_at)-c.created_at) FROM exceptions.event WHERE case_id=c.id AND state='UNDER_REVIEW') AS first_review_seconds,
 (SELECT extract(epoch FROM created_at-c.created_at) FROM exceptions.event WHERE case_id=c.id AND action IN ('RESOLVE','SUPERSEDE') ORDER BY version DESC LIMIT 1) AS resolution_seconds
 FROM exceptions.current_case c JOIN reconciliation.item i ON i.id=c.item_id JOIN LATERAL(SELECT * FROM exceptions.occurrence WHERE case_id=c.id ORDER BY (SELECT version FROM exceptions.event WHERE id=event_id) DESC LIMIT 1) occ ON true;
CREATE FUNCTION exceptions.summary(mid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
 'states',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.state) FROM(SELECT state,count(*)::integer AS count FROM exceptions.current_case WHERE mapping_id=mid GROUP BY state)x),'[]'),
 'classes',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.classification) FROM(SELECT classification,count(*)::integer AS count FROM exceptions.current_case WHERE mapping_id=mid GROUP BY classification)x),'[]'),
 'exposure',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.currency,x.side) FROM(SELECT currency,side,coalesce(sum(exposure_minor) FILTER(WHERE NOT currently_reconciled),0)::text AS "amountMinor",coalesce(sum(exposure_minor) FILTER(WHERE state='RESOLVED' AND resolution='ACCEPTED_RISK' AND NOT currently_reconciled),0)::text AS "acceptedRiskMinor",count(*) FILTER(WHERE exposure_minor IS NULL AND NOT currently_reconciled)::integer AS "unknownCount" FROM exceptions.operational_metrics WHERE mapping_id=mid GROUP BY currency,side)x),'[]'),
 'createdTotal',(SELECT count(*)::integer FROM exceptions.case_record WHERE mapping_id=mid),
 'resolvedTotal',(SELECT count(*)::integer FROM exceptions.event e JOIN exceptions.case_record c ON c.id=e.case_id WHERE c.mapping_id=mid AND e.action='RESOLVE'),
 'reopenedTotal',(SELECT count(*)::integer FROM exceptions.event e JOIN exceptions.case_record c ON c.id=e.case_id WHERE c.mapping_id=mid AND e.action='REOPEN'),
 'manualReconciliationTotal',0,
 'oldestOpenAgeSeconds',(SELECT max(age_seconds)::text FROM exceptions.operational_metrics WHERE mapping_id=mid AND state<>'RESOLVED'),
 'medianResolutionSeconds',(SELECT percentile_disc(0.5) WITHIN GROUP(ORDER BY resolution_seconds)::text FROM exceptions.operational_metrics WHERE mapping_id=mid AND resolution_seconds IS NOT NULL))
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA exceptions FROM PUBLIC;
GRANT USAGE ON SCHEMA exceptions TO flow_exception_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA exceptions TO flow_exception_reader;
GRANT EXECUTE ON FUNCTION exceptions.case_view(uuid,integer),exceptions.summary(uuid) TO flow_exception_reader;
GRANT EXECUTE ON FUNCTION exceptions.generate(jsonb),exceptions.apply(jsonb) TO flow_exception_writer;
RESET ROLE;
