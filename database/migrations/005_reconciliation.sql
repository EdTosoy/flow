-- Phase 6: exact whole-item 1:1 settlement-bank proof, PostgreSQL 18.
RESET ROLE;
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['flow_reconciliation_reader','flow_reconciliation_writer'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r); END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname=r AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe reconciliation role'; END IF;
 END LOOP;
END $$;
GRANT flow_reconciliation_reader TO flow_reconciliation_writer;
CREATE SCHEMA reconciliation AUTHORIZATION flow_ledger_owner;
REVOKE ALL ON SCHEMA reconciliation FROM PUBLIC;
SET LOCAL ROLE flow_ledger_owner;
CREATE TABLE reconciliation.rule_version(version text PRIMARY KEY,contract text NOT NULL);
INSERT INTO reconciliation.rule_version VALUES('settlement-bank-exact-v1','Synthetic exact transfer reference, mapped scope, exact signed net/currency, booked UTC [report,report+72h]; mutual unique candidate, all intrinsic controls clear; whole-item 1:1 only');
-- Offline, explicit synthetic mapping configuration; no runtime auto-discovery or credential storage.
CREATE TABLE reconciliation.account_mapping(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), book_id uuid NOT NULL REFERENCES ledger.book ON DELETE RESTRICT,
 processor_source_account_id uuid NOT NULL, bank_source_account_id uuid NOT NULL,
 currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 reference_contract text NOT NULL CHECK(reference_contract='synthetic-transfer-reference-v1'),
 FOREIGN KEY(processor_source_account_id,book_id) REFERENCES ingestion.source_account(id,book_id) ON DELETE RESTRICT,
 FOREIGN KEY(bank_source_account_id,book_id) REFERENCES ingestion.source_account(id,book_id) ON DELETE RESTRICT,
 CHECK(processor_source_account_id<>bank_source_account_id),
 UNIQUE(processor_source_account_id,currency), UNIQUE(bank_source_account_id,currency)
);
CREATE TABLE reconciliation.item(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), side text NOT NULL CHECK(side IN ('PROCESSOR','BANK')),
 source_fact_id uuid UNIQUE REFERENCES ingestion.source_fact ON DELETE RESTRICT,
 observation_revision_id uuid UNIQUE REFERENCES ingestion.revision ON DELETE RESTRICT,
 CHECK(num_nonnulls(source_fact_id,observation_revision_id)=1), CHECK(side='BANK' OR source_fact_id IS NOT NULL)
);
CREATE TABLE reconciliation.run(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mapping_id uuid NOT NULL REFERENCES reconciliation.account_mapping ON DELETE RESTRICT,
 run_key text NOT NULL CHECK(length(run_key) BETWEEN 1 AND 512), rule_version text NOT NULL REFERENCES reconciliation.rule_version ON DELETE RESTRICT,
 command jsonb NOT NULL, actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 512),
 window_from timestamptz NOT NULL CHECK(isfinite(window_from)), window_to timestamptz NOT NULL CHECK(isfinite(window_to)), effective_at timestamptz NOT NULL CHECK(isfinite(effective_at)), CHECK(window_from<window_to),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','SEALED','RUNNING','COMPLETED')),
 started_at timestamptz NOT NULL DEFAULT transaction_timestamp(), sealed_at timestamptz, completed_at timestamptz,
 seal_transaction xid8, plan_transaction xid8, manifest jsonb,
 UNIQUE(mapping_id,run_key), CHECK((state='DRAFT')=(manifest IS NULL)), CHECK((state='DRAFT')=(seal_transaction IS NULL)), CHECK((state='DRAFT')=(sealed_at IS NULL)), CHECK((state IN ('DRAFT','SEALED'))=(plan_transaction IS NULL)), CHECK((state='COMPLETED')=(completed_at IS NOT NULL))
);
CREATE TABLE reconciliation.run_member(
 run_id uuid NOT NULL REFERENCES reconciliation.run ON DELETE RESTRICT, item_id uuid NOT NULL REFERENCES reconciliation.item ON DELETE RESTRICT,
 side text NOT NULL CHECK(side IN ('PROCESSOR','BANK')), snapshot jsonb NOT NULL,
 processor_batch_id uuid REFERENCES processor.settlement_batch ON DELETE RESTRICT,
 bank_entry_id uuid REFERENCES bank.entry ON DELETE RESTRICT,
 PRIMARY KEY(run_id,item_id), CHECK(num_nonnulls(processor_batch_id,bank_entry_id)<=1),
 CHECK((side='PROCESSOR' AND bank_entry_id IS NULL) OR (side='BANK' AND processor_batch_id IS NULL))
);
CREATE TABLE reconciliation.candidate(
 run_id uuid NOT NULL, processor_item_id uuid NOT NULL, bank_item_id uuid NOT NULL, evidence jsonb NOT NULL,
 PRIMARY KEY(run_id,processor_item_id,bank_item_id),
 FOREIGN KEY(run_id,processor_item_id) REFERENCES reconciliation.run_member ON DELETE RESTRICT,
 FOREIGN KEY(run_id,bank_item_id) REFERENCES reconciliation.run_member ON DELETE RESTRICT
);
CREATE TABLE reconciliation.outcome_plan(
 run_id uuid NOT NULL, item_id uuid NOT NULL, outcome text NOT NULL CHECK(outcome IN ('MATCHED','UNMATCHED','AMBIGUOUS','INELIGIBLE')),
 counterpart_id uuid, reason text NOT NULL, PRIMARY KEY(run_id,item_id),
 FOREIGN KEY(run_id,item_id) REFERENCES reconciliation.run_member ON DELETE RESTRICT,
 FOREIGN KEY(run_id,counterpart_id) REFERENCES reconciliation.run_member ON DELETE RESTRICT,
 CHECK((outcome='MATCHED')=(counterpart_id IS NOT NULL))
);
CREATE TABLE reconciliation.match_group(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES reconciliation.run ON DELETE RESTRICT,
 relationship_scope text NOT NULL DEFAULT 'settlement_bank' CHECK(relationship_scope='settlement_bank'),
 rule_version text NOT NULL REFERENCES reconciliation.rule_version ON DELETE RESTRICT,
 shape text NOT NULL DEFAULT '1:1' CHECK(shape='1:1'), currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 signed_amount_minor bigint NOT NULL CHECK(signed_amount_minor<>0), evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(), UNIQUE(id,run_id)
);
CREATE UNIQUE INDEX match_semantic_pair ON reconciliation.match_group(run_id,(evidence->>'processorEvidenceId'),(evidence->>'bankEvidenceId'));
CREATE TABLE reconciliation.match_group_member(
 group_id uuid NOT NULL, run_id uuid NOT NULL, item_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('PROCESSOR_SETTLEMENT','BANK_MOVEMENT')),
 signed_amount_minor bigint NOT NULL, currency text NOT NULL REFERENCES ledger.currency_definition ON DELETE RESTRICT,
 PRIMARY KEY(group_id,item_id), UNIQUE(run_id,item_id),
 FOREIGN KEY(group_id,run_id) REFERENCES reconciliation.match_group(id,run_id) ON DELETE RESTRICT,
 FOREIGN KEY(run_id,item_id) REFERENCES reconciliation.run_member ON DELETE RESTRICT
);
CREATE TABLE reconciliation.outcome(
 run_id uuid NOT NULL, item_id uuid NOT NULL, outcome text NOT NULL CHECK(outcome IN ('MATCHED','UNMATCHED','AMBIGUOUS','INELIGIBLE')),
 reason text NOT NULL, group_id uuid, PRIMARY KEY(run_id,item_id),
 FOREIGN KEY(run_id,item_id) REFERENCES reconciliation.outcome_plan ON DELETE RESTRICT,
 FOREIGN KEY(group_id,run_id) REFERENCES reconciliation.match_group(id,run_id) ON DELETE RESTRICT,
 CHECK((outcome='MATCHED')=(group_id IS NOT NULL))
);
CREATE TABLE reconciliation.allocation_decision(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL REFERENCES reconciliation.match_group ON DELETE RESTRICT,
 caused_by_run_id uuid NOT NULL REFERENCES reconciliation.run ON DELETE RESTRICT,
 decision text NOT NULL CHECK(decision IN ('ACTIVE','STALE','CONFLICT','SUPERSEDED','INVALIDATED')),
 successor_group_id uuid REFERENCES reconciliation.match_group ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(), creation_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK((decision='SUPERSEDED')=(successor_group_id IS NOT NULL)), CHECK(successor_group_id IS DISTINCT FROM group_id)
);
CREATE UNIQUE INDEX allocation_initial ON reconciliation.allocation_decision(group_id) WHERE decision IN ('ACTIVE','STALE','CONFLICT');
CREATE UNIQUE INDEX allocation_terminal ON reconciliation.allocation_decision(group_id) WHERE decision IN ('SUPERSEDED','INVALIDATED');
CREATE TABLE reconciliation.current_allocation(
 item_id uuid PRIMARY KEY REFERENCES reconciliation.item ON DELETE RESTRICT,
 relationship_scope text NOT NULL DEFAULT 'settlement_bank' CHECK(relationship_scope='settlement_bank'),
 group_id uuid NOT NULL, FOREIGN KEY(group_id,item_id) REFERENCES reconciliation.match_group_member(group_id,item_id) ON DELETE RESTRICT
);

-- Read one consistent statement snapshot. Historical variants stay visible; none is ranked by arrival.
CREATE FUNCTION reconciliation.bank_controls(eid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE inputs jsonb:='[]'; controls text[]:='{}'; item record; snap jsonb;
BEGIN
 FOR item IN SELECT DISTINCT m.group_id FROM bank.membership m JOIN bank.derivation d ON d.id=m.entry_id
 WHERE d.interpreter_version='bank-v1' AND d.normalizer_version='synthetic-bank-entry-v1'
 AND (d.id=eid OR d.fact_id=(SELECT fact_id FROM bank.derivation WHERE id=eid)) ORDER BY m.group_id LOOP
  IF NOT EXISTS(SELECT FROM bank.statement WHERE group_id=item.group_id) THEN controls:=array_append(controls,'MISSING_STATEMENT_REPORT'); END IF;
  FOR snap IN SELECT bank.statement_snapshot(s.id,'bank-v1') FROM bank.statement s JOIN bank.derivation d ON d.id=s.id
   WHERE s.group_id=item.group_id AND d.interpreter_version='bank-v1' AND d.normalizer_version='synthetic-bank-statement-v1' ORDER BY s.id LOOP
   snap:=snap||jsonb_build_object('receiptControls',reconciliation.receipt_controls((SELECT revision_id FROM bank.derivation WHERE id=(snap->'input'->>'statementId')::uuid)));
   controls:=controls||ARRAY(SELECT jsonb_array_elements_text(snap->'receiptControls'->'controls'));
   inputs:=inputs||jsonb_build_array(snap);
   controls:=controls||ARRAY(SELECT jsonb_array_elements_text(snap->'result'->'controls'));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('inputs',inputs,'controls',to_jsonb(ARRAY(SELECT DISTINCT c FROM unnest(controls) c ORDER BY c)));
END $$;
CREATE FUNCTION reconciliation.receipt_controls(rev uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('batches',coalesce(jsonb_agg(DISTINCT jsonb_build_object('batchId',b.id,'coverage',b.completeness)),'[]'),
 'controls',CASE WHEN coalesce(bool_or(b.completeness='PROVEN_INCOMPLETE'),false) THEN '["SOURCE_INCOMPLETE"]'::jsonb ELSE '[]'::jsonb END)
 FROM ingestion.raw_record r JOIN ingestion.batch b ON b.id=r.batch_id WHERE r.revision_id=rev
$$;
CREATE FUNCTION reconciliation.population(mid uuid,lo timestamptz,hi timestamptz)
 RETURNS TABLE(identity uuid,side text,snapshot jsonb) LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE mapping reconciliation.account_mapping%ROWTYPE; pop record; selected record; history jsonb; ctrl jsonb; receipt jsonb; reasons text[];
BEGIN
 SELECT * INTO STRICT mapping FROM reconciliation.account_mapping WHERE id=mid;
 FOR pop IN SELECT DISTINCT d.fact_id FROM processor.derivation d JOIN processor.settlement_batch s ON s.id=d.id
  WHERE s.source_account_id=mapping.processor_source_account_id AND s.currency=mapping.currency AND s.reported_at>=lo AND s.reported_at<hi
  AND d.normalizer_version='synthetic-settlement-v1' AND d.interpreter_version='processor-v1' LOOP
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'revisionId',d.revision_id,'currency',s.currency,'amountMinor',s.reported_net_minor::text,'reference',s.transfer_reference,
   'time',to_char(s.reported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY s.id),'[]') INTO history
   FROM processor.settlement_batch s JOIN processor.derivation d ON d.id=s.id WHERE d.fact_id=pop.fact_id AND d.normalizer_version='synthetic-settlement-v1' AND d.interpreter_version='processor-v1';
  SELECT f.revision_state,f.active_revision_id,d.id,s.currency,s.reported_net_minor::text AS amount,s.transfer_reference AS reference,s.reported_at AS time INTO selected
   FROM ingestion.fact_status f LEFT JOIN processor.derivation d ON d.fact_id=f.id AND d.revision_id=f.active_revision_id AND d.normalizer_version='synthetic-settlement-v1' AND d.interpreter_version='processor-v1'
   LEFT JOIN processor.settlement_batch s ON s.id=d.id WHERE f.id=pop.fact_id;
  reasons:='{}'; ctrl:=NULL; receipt:=NULL;
  IF selected.revision_state<>'UNAMBIGUOUS' THEN reasons:=array_append(reasons,'AMBIGUOUS_REVISION');
  ELSIF selected.id IS NULL THEN reasons:=array_append(reasons,'PENDING_INTERPRETATION');
  ELSE
   ctrl:=processor.evaluation_snapshot('settlement',selected.id,'synthetic-movement-v1','processor-v1');
   receipt:=reconciliation.receipt_controls(selected.active_revision_id)||jsonb_build_object('components',coalesce((SELECT jsonb_agg(reconciliation.receipt_controls((x->>'activeRevisionId')::uuid) ORDER BY x->>'ordinal') FROM jsonb_array_elements(ctrl->'input'->'members') x),'[]'));
   reasons:=reasons||ARRAY(SELECT jsonb_array_elements_text(component->'controls') FROM jsonb_array_elements(receipt->'components') component);
   reasons:=reasons||ARRAY(SELECT jsonb_array_elements_text(ctrl->'result'->'controls'))||ARRAY(SELECT jsonb_array_elements_text(receipt->'controls'));
   IF selected.amount='0' THEN reasons:=array_append(reasons,'ZERO_SETTLEMENT'); END IF;
   IF selected.currency<>mapping.currency OR selected.time<lo OR selected.time>=hi THEN reasons:=array_append(reasons,'SELECTED_EVIDENCE_OUTSIDE_SCOPE'); END IF;
  END IF;
  identity:=pop.fact_id; side:='PROCESSOR';
  snapshot:=jsonb_build_object('origin',identity,'side',side,'sourceAccountId',mapping.processor_source_account_id,'sourceState',selected.revision_state,
   'selectedId',selected.id,'revisionId',selected.active_revision_id,'normalizerVersion','synthetic-settlement-v1','interpreterVersion','processor-v1',
   'currency',selected.currency,'amountMinor',selected.amount,'reference',selected.reference,'time',CASE WHEN selected.time IS NOT NULL THEN to_char(selected.time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
   'variants',history,'domainControls',ctrl,'receiptControls',receipt,'reasons',to_jsonb(reasons),'eligible',cardinality(reasons)=0);
  RETURN NEXT;
 END LOOP;
 FOR pop IN SELECT DISTINCT coalesce(d.fact_id,d.revision_id) AS origin,d.fact_id FROM bank.derivation d JOIN bank.entry e ON e.id=d.id
  WHERE e.source_account_id=mapping.bank_source_account_id AND e.currency=mapping.currency AND e.booked_at>=lo AND e.booked_at<hi
  AND d.normalizer_version='synthetic-bank-entry-v1' AND d.interpreter_version='bank-v1' LOOP
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'revisionId',d.revision_id,'currency',e.currency,'amountMinor',(CASE WHEN e.direction='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END)::text,
   'reference',e.bank_reference,'time',to_char(e.booked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'valueDate',e.value_date::text,'sourceOccurredAt',to_char(e.source_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY e.id),'[]') INTO history
   FROM bank.entry e JOIN bank.derivation d ON d.id=e.id WHERE coalesce(d.fact_id,d.revision_id)=pop.origin AND d.normalizer_version='synthetic-bank-entry-v1' AND d.interpreter_version='bank-v1';
  SELECT f.revision_state,coalesce(f.active_revision_id,CASE WHEN pop.fact_id IS NULL THEN pop.origin END) AS active_revision_id,d.id,e.currency,
   (CASE WHEN e.direction='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END)::text AS amount,e.bank_reference AS reference,e.booked_at AS time,e.value_date::text AS value_date INTO selected
   FROM (SELECT 1) anchor LEFT JOIN ingestion.fact_status f ON f.id=pop.fact_id LEFT JOIN bank.derivation d ON d.revision_id=coalesce(f.active_revision_id,CASE WHEN pop.fact_id IS NULL THEN pop.origin END)
   AND d.normalizer_version='synthetic-bank-entry-v1' AND d.interpreter_version='bank-v1' LEFT JOIN bank.entry e ON e.id=d.id;
  reasons:='{}'; ctrl:=NULL; receipt:=NULL;
  IF pop.fact_id IS NULL THEN reasons:=array_append(reasons,'OBSERVATION_ONLY');
  ELSIF selected.revision_state<>'UNAMBIGUOUS' THEN reasons:=array_append(reasons,'AMBIGUOUS_REVISION'); END IF;
  IF selected.id IS NULL THEN reasons:=array_append(reasons,'PENDING_INTERPRETATION');
  ELSE
   ctrl:=reconciliation.bank_controls(selected.id); receipt:=reconciliation.receipt_controls(selected.active_revision_id);
   reasons:=reasons||ARRAY(SELECT jsonb_array_elements_text(ctrl->'controls'))||ARRAY(SELECT jsonb_array_elements_text(receipt->'controls'));
   IF selected.reference IS NULL THEN reasons:=array_append(reasons,'REFERENCE_REQUIRED'); END IF;
   IF selected.currency<>mapping.currency OR selected.time<lo OR selected.time>=hi THEN reasons:=array_append(reasons,'SELECTED_EVIDENCE_OUTSIDE_SCOPE'); END IF;
  END IF;
  identity:=pop.origin; side:='BANK';
  snapshot:=jsonb_build_object('origin',identity,'side',side,'sourceAccountId',mapping.bank_source_account_id,'sourceState',coalesce(selected.revision_state,'OBSERVATION_ONLY'),
   'selectedId',selected.id,'revisionId',selected.active_revision_id,'normalizerVersion','synthetic-bank-entry-v1','interpreterVersion','bank-v1',
   'currency',selected.currency,'amountMinor',selected.amount,'reference',selected.reference,'time',CASE WHEN selected.time IS NOT NULL THEN to_char(selected.time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
   'valueDate',selected.value_date,'variants',history,'domainControls',ctrl,'receiptControls',receipt,'reasons',to_jsonb(reasons),'eligible',cardinality(reasons)=0);
  RETURN NEXT;
 END LOOP;
END $$;
-- Candidate identity: ANY preserved variant can expose a competing reference; ambiguity never selects one.
CREATE FUNCTION reconciliation.is_candidate(p jsonb,b jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT FROM jsonb_array_elements(p->'variants') pv CROSS JOIN jsonb_array_elements(b->'variants') bv
 WHERE pv->>'reference'=bv->>'reference' AND pv->>'currency'=bv->>'currency' AND (bv->>'time')::timestamptz BETWEEN (pv->>'time')::timestamptz AND (pv->>'time')::timestamptz+interval '72 hours')
$$;
CREATE FUNCTION reconciliation.proof(p jsonb,b jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('currencyExact',coalesce(p->>'currency'=b->>'currency',false),'amountExact',coalesce(p->>'amountMinor'=b->>'amountMinor',false),
 'directionCompatible',coalesce(sign((p->>'amountMinor')::numeric)=sign((b->>'amountMinor')::numeric) AND (p->>'amountMinor')::numeric<>0,false),
 'referenceExact',coalesce(p->>'reference'=b->>'reference',false),'bookingWindowValid',coalesce((b->>'time')::timestamptz BETWEEN (p->>'time')::timestamptz AND (p->>'time')::timestamptz+interval '72 hours',false),
 'processorEligible',(p->>'eligible')::boolean,'bankEligible',(b->>'eligible')::boolean,'accountMappingValid',true,
 'processorEvidenceId',p->'selectedId','bankEvidenceId',b->'selectedId','processorReportedAt',p->'time','bankBookedAt',b->'time','bankValueDate',b->'valueDate',
 'reference',p->'reference','currency',p->'currency','signedAmountMinor',p->'amountMinor','windowPolicy','elapsed-UTC-booked-0-to-72h-v1')
$$;
CREATE FUNCTION reconciliation.proof_passes(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce((e->>'currencyExact')::boolean AND (e->>'amountExact')::boolean AND (e->>'directionCompatible')::boolean AND (e->>'referenceExact')::boolean AND (e->>'bookingWindowValid')::boolean AND (e->>'processorEligible')::boolean AND (e->>'bankEligible')::boolean AND (e->>'accountMappingValid')::boolean,false)
$$;

ALTER TABLE audit.audit_event ADD COLUMN reconciliation_decision_id uuid REFERENCES reconciliation.allocation_decision ON DELETE RESTRICT;
ALTER TABLE outbox.outbox_event ADD COLUMN reconciliation_decision_id uuid REFERENCES reconciliation.allocation_decision ON DELETE RESTRICT, ADD COLUMN reconciliation_run_id uuid REFERENCES reconciliation.run ON DELETE RESTRICT;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='audit.audit_event'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%num_nonnulls%' OR pg_get_constraintdef(oid) LIKE '%ingestion.batch_accepted%') LOOP
  EXECUTE format('ALTER TABLE audit.audit_event DROP CONSTRAINT %I',c.conname);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='outbox.outbox_event'::regclass AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%num_nonnulls%' OR pg_get_constraintdef(oid) LIKE '%ingestion.normalization_requested%') LOOP
  EXECUTE format('ALTER TABLE outbox.outbox_event DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE audit.audit_event ADD CHECK(num_nonnulls(account_id,journal_id,batch_id,revision_id,processor_evaluation_id,bank_evaluation_id,reconciliation_decision_id)=1),
 ADD CHECK((account_id IS NOT NULL AND action='ledger.account_created' AND previous_state='absent' AND new_state='open' AND reversal_of IS NULL AND command_key IS NOT NULL)
 OR (journal_id IS NOT NULL AND action IN ('ledger.journal_posted','ledger.journal_reversed') AND previous_state='absent' AND new_state='posted' AND command_key IS NOT NULL AND ((action='ledger.journal_reversed')=(reversal_of IS NOT NULL)))
 OR (batch_id IS NOT NULL AND action IN ('ingestion.batch_accepted','ingestion.normalization_requested') AND previous_state='absent' AND new_state='accepted' AND reversal_of IS NULL)
 OR (revision_id IS NOT NULL AND action='ingestion.revision_observed' AND previous_state='absent' AND new_state='observed' AND reversal_of IS NULL)
 OR (processor_evaluation_id IS NOT NULL AND action='processor.controls_failed' AND previous_state='absent' AND new_state='control_failed' AND reversal_of IS NULL)
 OR (bank_evaluation_id IS NOT NULL AND action='bank.controls_failed' AND previous_state='absent' AND new_state='control_failed' AND reversal_of IS NULL)
 OR (reconciliation_decision_id IS NOT NULL AND action='reconciliation.decision' AND previous_state='absent' AND new_state='recorded' AND reversal_of IS NULL)),
 ADD UNIQUE(reconciliation_decision_id);
ALTER TABLE outbox.outbox_event ADD CHECK(num_nonnulls(account_id,journal_id,batch_id,processor_derivation_id,bank_derivation_id,reconciliation_decision_id,reconciliation_run_id)=1),
 ADD CHECK(payload @> jsonb_build_object('bookId',book_id) AND
 ((account_id IS NOT NULL AND event_type='ledger.account_created' AND payload @> jsonb_build_object('accountId',account_id) AND command_key IS NOT NULL AND normalizer_version IS NULL)
 OR (journal_id IS NOT NULL AND event_type IN ('ledger.journal_posted','ledger.journal_reversed') AND payload @> jsonb_build_object('journalId',journal_id) AND command_key IS NOT NULL AND normalizer_version IS NULL)
 OR (batch_id IS NOT NULL AND event_type='ingestion.normalization_requested' AND normalizer_version IS NOT NULL AND payload @> jsonb_build_object('batchId',batch_id,'normalizerVersion',normalizer_version))
 OR (processor_derivation_id IS NOT NULL AND event_type='processor.interpreted' AND normalizer_version IS NULL AND payload @> jsonb_build_object('derivationId',processor_derivation_id))
 OR (bank_derivation_id IS NOT NULL AND event_type='bank.interpreted' AND normalizer_version IS NULL AND payload @> jsonb_build_object('derivationId',bank_derivation_id))
 OR (reconciliation_decision_id IS NOT NULL AND event_type='reconciliation.decision' AND normalizer_version IS NULL AND payload @> jsonb_build_object('decisionId',reconciliation_decision_id))
 OR (reconciliation_run_id IS NOT NULL AND event_type='reconciliation.completed' AND normalizer_version IS NULL AND payload @> jsonb_build_object('runId',reconciliation_run_id)))),
 ADD UNIQUE(reconciliation_decision_id), ADD UNIQUE(reconciliation_run_id);
CREATE FUNCTION reconciliation.record_decision(gid uuid,rid uuid,d text,successor uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE event_id uuid; bk uuid; actor text;
BEGIN
 SELECT m.book_id,r.actor_id INTO STRICT bk,actor FROM reconciliation.run r JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE r.id=rid;
 INSERT INTO reconciliation.allocation_decision(group_id,caused_by_run_id,decision,successor_group_id) VALUES(gid,rid,d,successor) RETURNING id INTO event_id;
 INSERT INTO audit.audit_event(book_id,reconciliation_decision_id,action,actor_id,previous_state,new_state,reason,policy_version)
 VALUES(bk,event_id,'reconciliation.decision',actor,'absent','recorded',d||' settlement-bank proof; immutable decision links run and group','settlement-bank-exact-v1');
 INSERT INTO outbox.outbox_event(book_id,reconciliation_decision_id,event_type,aggregate_version,schema_version,payload)
 VALUES(bk,event_id,'reconciliation.decision',1,1,jsonb_build_object('bookId',bk,'decisionId',event_id));
END $$;
CREATE FUNCTION reconciliation.create_run(p jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE mapping reconciliation.account_mapping%ROWTYPE; r reconciliation.run%ROWTYPE; cmd jsonb:=p-'actorId';
BEGIN
 IF p->>'ruleVersion'<>'settlement-bank-exact-v1' OR NOT bank.valid_time(p->>'from') OR NOT bank.valid_time(p->>'to') OR NOT bank.valid_time(p->>'effectiveAt') OR (p->>'from')::timestamptz>=(p->>'to')::timestamptz OR length(p->>'actorId') NOT BETWEEN 1 AND 512 OR length(p->>'runKey') NOT BETWEEN 1 AND 512 OR (SELECT count(*) FROM jsonb_object_keys(p))<>7 THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Unsupported run command'; END IF;
 SELECT * INTO STRICT mapping FROM reconciliation.account_mapping WHERE id=(p->>'mappingId')::uuid;
 PERFORM FROM ledger.book WHERE id=mapping.book_id FOR NO KEY UPDATE;
 SELECT * INTO r FROM reconciliation.run WHERE mapping_id=mapping.id AND run_key=p->>'runKey';
 IF FOUND THEN
  IF r.command IS DISTINCT FROM cmd THEN RAISE EXCEPTION USING ERRCODE='P6001',MESSAGE='Run identity conflict'; END IF;
  RETURN r.id;
 END IF;
 INSERT INTO reconciliation.run(mapping_id,run_key,rule_version,command,actor_id,window_from,window_to,effective_at)
 VALUES(mapping.id,p->>'runKey',p->>'ruleVersion',cmd,p->>'actorId',(p->>'from')::timestamptz,(p->>'to')::timestamptz,(p->>'effectiveAt')::timestamptz) RETURNING id INTO r.id;
 RETURN r.id;
END $$;
CREATE FUNCTION reconciliation.seal(rid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; row record; iid uuid; frozen jsonb; frozen_manifest jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Freeze requires repeatable read'; END IF;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid FOR UPDATE;
 IF r.state<>'DRAFT' THEN RETURN; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.side,x.identity),'[]') INTO frozen FROM reconciliation.population(r.mapping_id,r.window_from,r.window_to) x;
 IF jsonb_array_length(frozen)>2000 THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Bounded run population exceeded'; END IF;
 frozen_manifest:=jsonb_build_object('populationHash',encode(sha256(convert_to(frozen::text,'UTF8')),'hex'),
  'processorCount',(SELECT count(*) FROM jsonb_array_elements(frozen) x WHERE x->>'side'='PROCESSOR'),
  'bankCount',(SELECT count(*) FROM jsonb_array_elements(frozen) x WHERE x->>'side'='BANK'),
  'sourceCoverage','UNKNOWN','population',frozen);
 UPDATE reconciliation.run SET state='SEALED',manifest=frozen_manifest,sealed_at=transaction_timestamp(),seal_transaction=pg_current_xact_id() WHERE id=rid;
 FOR row IN SELECT (x->>'identity')::uuid AS origin,x->>'side' AS side,x->'snapshot' AS snapshot FROM jsonb_array_elements(frozen) x LOOP
  IF row.snapshot->>'sourceState'='OBSERVATION_ONLY' THEN
   INSERT INTO reconciliation.item(side,observation_revision_id) VALUES(row.side,row.origin) ON CONFLICT(observation_revision_id) DO NOTHING;
   SELECT id INTO STRICT iid FROM reconciliation.item WHERE observation_revision_id=row.origin;
  ELSE
   INSERT INTO reconciliation.item(side,source_fact_id) VALUES(row.side,row.origin) ON CONFLICT(source_fact_id) DO NOTHING;
   SELECT id INTO STRICT iid FROM reconciliation.item WHERE source_fact_id=row.origin;
  END IF;
  INSERT INTO reconciliation.run_member(run_id,item_id,side,snapshot,processor_batch_id,bank_entry_id)
  VALUES(rid,iid,row.side,row.snapshot,CASE WHEN row.side='PROCESSOR' THEN (row.snapshot->>'selectedId')::uuid END,CASE WHEN row.side='BANK' THEN (row.snapshot->>'selectedId')::uuid END);
 END LOOP;
END $$;
CREATE FUNCTION reconciliation.planned(rid uuid) RETURNS TABLE(item_id uuid,outcome text,counterpart_id uuid,reason text) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH degrees AS(SELECT m.item_id,m.snapshot,count(c.*) AS degree,min(CASE WHEN m.side='PROCESSOR' THEN c.bank_item_id::text ELSE c.processor_item_id::text END)::uuid AS other
 FROM reconciliation.run_member m LEFT JOIN reconciliation.candidate c ON c.run_id=m.run_id AND (c.processor_item_id=m.item_id OR c.bank_item_id=m.item_id) WHERE m.run_id=rid GROUP BY m.item_id,m.snapshot),
 classified AS(SELECT d.*,o.degree AS other_degree,c.evidence FROM degrees d LEFT JOIN degrees o ON o.item_id=d.other
 LEFT JOIN reconciliation.candidate c ON c.run_id=rid AND ((c.processor_item_id=d.item_id AND c.bank_item_id=d.other) OR (c.bank_item_id=d.item_id AND c.processor_item_id=d.other)))
 SELECT item_id,CASE WHEN NOT (snapshot->>'eligible')::boolean THEN 'INELIGIBLE' WHEN degree>1 OR other_degree>1 THEN 'AMBIGUOUS' WHEN degree=1 AND reconciliation.proof_passes(evidence) THEN 'MATCHED' ELSE 'UNMATCHED' END,
 CASE WHEN (snapshot->>'eligible')::boolean AND degree=1 AND other_degree=1 AND reconciliation.proof_passes(evidence) THEN other END,
 CASE WHEN NOT (snapshot->>'eligible')::boolean THEN (snapshot->'reasons')::text WHEN degree>1 OR other_degree>1 THEN 'NON_UNIQUE_REFERENCE_CANDIDATES' WHEN degree=1 AND reconciliation.proof_passes(evidence) THEN 'EXACT_REFERENCE_PROOF' WHEN degree=1 THEN 'RULE_CHECK_FAILED' ELSE 'NO_REFERENCE_CANDIDATE' END
 FROM classified
$$;
CREATE FUNCTION reconciliation.plan(rid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid FOR UPDATE;
 IF r.state IN ('RUNNING','COMPLETED') THEN RETURN; END IF;
 IF r.state<>'SEALED' THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Unsealed run'; END IF;
 UPDATE reconciliation.run SET state='RUNNING',plan_transaction=pg_current_xact_id() WHERE id=rid;
 INSERT INTO reconciliation.candidate SELECT rid,p.item_id,b.item_id,reconciliation.proof(p.snapshot,b.snapshot)
 FROM reconciliation.run_member p CROSS JOIN reconciliation.run_member b WHERE p.run_id=rid AND b.run_id=rid AND p.side='PROCESSOR' AND b.side='BANK' AND reconciliation.is_candidate(p.snapshot,b.snapshot);
 INSERT INTO reconciliation.outcome_plan SELECT rid,item_id,outcome,counterpart_id,reason FROM reconciliation.planned(rid);
END $$;
-- Reevaluate the precise historical pair and mutual uniqueness against current runtime-visible evidence.
CREATE FUNCTION reconciliation.valid_against(gid uuid,fresh jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; b jsonb; oldp jsonb; oldb jsonb;
BEGIN
 SELECT rm.snapshot INTO STRICT oldp FROM reconciliation.match_group_member gm JOIN reconciliation.run_member rm ON rm.run_id=gm.run_id AND rm.item_id=gm.item_id WHERE gm.group_id=gid AND gm.role='PROCESSOR_SETTLEMENT';
 SELECT rm.snapshot INTO STRICT oldb FROM reconciliation.match_group_member gm JOIN reconciliation.run_member rm ON rm.run_id=gm.run_id AND rm.item_id=gm.item_id WHERE gm.group_id=gid AND gm.role='BANK_MOVEMENT';
 SELECT x->'snapshot' INTO p FROM jsonb_array_elements(fresh) x WHERE x->>'identity'=oldp->>'origin' AND x->>'side'='PROCESSOR';
 SELECT x->'snapshot' INTO b FROM jsonb_array_elements(fresh) x WHERE x->>'identity'=oldb->>'origin' AND x->>'side'='BANK';
 IF p IS NULL OR b IS NULL OR p->>'selectedId' IS DISTINCT FROM oldp->>'selectedId' OR b->>'selectedId' IS DISTINCT FROM oldb->>'selectedId' OR p->'domainControls' IS DISTINCT FROM oldp->'domainControls' OR b->'domainControls' IS DISTINCT FROM oldb->'domainControls' OR NOT reconciliation.proof_passes(reconciliation.proof(p,b)) THEN RETURN false; END IF;
 RETURN (SELECT count(*) FROM jsonb_array_elements(fresh) x WHERE x->>'side'='BANK' AND reconciliation.is_candidate(p,x->'snapshot'))=1
 AND (SELECT count(*) FROM jsonb_array_elements(fresh) x WHERE x->>'side'='PROCESSOR' AND reconciliation.is_candidate(x->'snapshot',b))=1;
END $$;
CREATE FUNCTION reconciliation.current_valid(gid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT reconciliation.valid_against(gid,(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM reconciliation.population(r.mapping_id,r.window_from,r.window_to) x))
 FROM reconciliation.match_group g JOIN reconciliation.run r ON r.id=g.run_id WHERE g.id=gid
$$;
CREATE FUNCTION reconciliation.advance(rid uuid,lim integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; mapping reconciliation.account_mapping%ROWTYPE; planned record; pm reconciliation.run_member%ROWTYPE; bm reconciliation.run_member%ROWTYPE; gid uuid; old_group uuid; fresh jsonb; n integer:=0; conflict boolean;
BEGIN
 IF lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Invalid progress bound'; END IF;
 SELECT m.* INTO STRICT mapping FROM reconciliation.run rr JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE rr.id=rid;
 -- Uniform ordering for all current-state changes, including overlapping runs. No ledger posting.
 PERFORM FROM ledger.book WHERE id=mapping.book_id FOR NO KEY UPDATE;
 PERFORM FROM ingestion.source_account WHERE id IN (mapping.processor_source_account_id,mapping.bank_source_account_id) ORDER BY id FOR UPDATE;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid FOR UPDATE;
 IF r.state='COMPLETED' THEN RETURN 0; END IF;
 IF r.state<>'RUNNING' THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Unplanned run'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO fresh FROM reconciliation.population(r.mapping_id,r.window_from,r.window_to) x;
 -- Discover and retire invalid reservations without rewriting their historical match or run.
 FOR old_group IN SELECT DISTINCT a.group_id FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id JOIN reconciliation.run oldr ON oldr.id=g.run_id WHERE oldr.mapping_id=r.mapping_id LOOP
  IF NOT reconciliation.current_valid(old_group) THEN
   PERFORM reconciliation.record_decision(old_group,rid,'INVALIDATED');
   DELETE FROM reconciliation.current_allocation WHERE group_id=old_group;
  END IF;
 END LOOP;
 FOR planned IN SELECT op.* FROM reconciliation.outcome_plan op WHERE op.run_id=rid AND NOT EXISTS(SELECT FROM reconciliation.outcome o WHERE o.run_id=rid AND o.item_id=op.item_id) ORDER BY op.item_id LIMIT lim LOOP
  IF EXISTS(SELECT FROM reconciliation.outcome WHERE run_id=rid AND item_id=planned.item_id) THEN CONTINUE; END IF;
  IF planned.outcome='MATCHED' THEN
   SELECT * INTO STRICT pm FROM reconciliation.run_member WHERE run_id=rid AND item_id IN(planned.item_id,planned.counterpart_id) AND side='PROCESSOR';
   SELECT * INTO STRICT bm FROM reconciliation.run_member WHERE run_id=rid AND item_id IN(planned.item_id,planned.counterpart_id) AND side='BANK';
   INSERT INTO reconciliation.match_group(run_id,rule_version,currency,signed_amount_minor,evidence)
   SELECT rid,r.rule_version,pm.snapshot->>'currency',(pm.snapshot->>'amountMinor')::bigint,
    evidence||jsonb_build_object('ruleVersion',r.rule_version,'mappingId',mapping.id,'processorSnapshot',pm.snapshot,'bankSnapshot',bm.snapshot,'mutualUnique',true,'populationHash',r.manifest->'populationHash')
   FROM reconciliation.candidate WHERE run_id=rid AND processor_item_id=pm.item_id AND bank_item_id=bm.item_id RETURNING id INTO gid;
   INSERT INTO reconciliation.match_group_member VALUES(gid,rid,pm.item_id,'PROCESSOR_SETTLEMENT',(pm.snapshot->>'amountMinor')::bigint,pm.snapshot->>'currency'),(gid,rid,bm.item_id,'BANK_MOVEMENT',(bm.snapshot->>'amountMinor')::bigint,bm.snapshot->>'currency');
   INSERT INTO reconciliation.outcome SELECT rid,op.item_id,op.outcome,op.reason,gid FROM reconciliation.outcome_plan op WHERE op.run_id=rid AND op.item_id IN(pm.item_id,bm.item_id);
   IF NOT reconciliation.valid_against(gid,fresh) THEN PERFORM reconciliation.record_decision(gid,rid,'STALE');
   ELSE
    conflict:=EXISTS(SELECT FROM reconciliation.current_allocation a WHERE a.item_id IN(pm.item_id,bm.item_id) AND NOT
     (EXISTS(SELECT FROM reconciliation.match_group_member gm WHERE gm.group_id=a.group_id AND gm.item_id=pm.item_id) AND EXISTS(SELECT FROM reconciliation.match_group_member gm WHERE gm.group_id=a.group_id AND gm.item_id=bm.item_id)));
    IF conflict THEN PERFORM reconciliation.record_decision(gid,rid,'CONFLICT');
    ELSE
     FOR old_group IN SELECT DISTINCT group_id FROM reconciliation.current_allocation WHERE item_id IN(pm.item_id,bm.item_id) LOOP
      PERFORM reconciliation.record_decision(old_group,rid,'SUPERSEDED',gid);
      DELETE FROM reconciliation.current_allocation WHERE group_id=old_group;
     END LOOP;
     PERFORM reconciliation.record_decision(gid,rid,'ACTIVE');
     INSERT INTO reconciliation.current_allocation VALUES(pm.item_id,'settlement_bank',gid),(bm.item_id,'settlement_bank',gid);
    END IF;
   END IF;
   n:=n+2;
  ELSE
   INSERT INTO reconciliation.outcome VALUES(rid,planned.item_id,planned.outcome,planned.reason,NULL); n:=n+1;
  END IF;
 END LOOP;
 RETURN n;
END $$;
CREATE FUNCTION reconciliation.complete(rid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; bk uuid;
BEGIN
 SELECT m.book_id INTO STRICT bk FROM reconciliation.run rr JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE rr.id=rid;
 PERFORM FROM ledger.book WHERE id=bk FOR NO KEY UPDATE;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid FOR UPDATE;
 IF r.state='COMPLETED' THEN RETURN; END IF;
 IF r.state<>'RUNNING' OR (SELECT count(*) FROM reconciliation.outcome WHERE run_id=rid)<>(SELECT count(*) FROM reconciliation.run_member WHERE run_id=rid) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete outcome coverage'; END IF;
 UPDATE reconciliation.run SET state='COMPLETED',completed_at=transaction_timestamp() WHERE id=rid;
 SELECT book_id INTO bk FROM reconciliation.account_mapping WHERE id=r.mapping_id;
 INSERT INTO outbox.outbox_event(book_id,reconciliation_run_id,event_type,aggregate_version,schema_version,payload) VALUES(bk,rid,'reconciliation.completed',1,1,jsonb_build_object('bookId',bk,'runId',rid));
END $$;
CREATE VIEW reconciliation.current_group AS
 SELECT g.id,g.run_id,CASE WHEN terminal.decision IS NOT NULL THEN terminal.decision
 WHEN initial.decision='ACTIVE' THEN CASE WHEN reconciliation.current_valid(g.id) THEN 'ACTIVE' ELSE 'INVALIDATED' END
 ELSE initial.decision END AS status
 FROM reconciliation.match_group g LEFT JOIN reconciliation.allocation_decision initial ON initial.group_id=g.id AND initial.decision IN ('ACTIVE','STALE','CONFLICT')
 LEFT JOIN reconciliation.allocation_decision terminal ON terminal.group_id=g.id AND terminal.decision IN ('SUPERSEDED','INVALIDATED');
CREATE VIEW reconciliation.active_allocation AS
 SELECT a.* FROM reconciliation.current_allocation a JOIN reconciliation.current_group g ON g.id=a.group_id WHERE g.status='ACTIVE';
CREATE FUNCTION reconciliation.summary(rid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('id',r.id,'state',r.state,'processorPopulation',coalesce((r.manifest->>'processorCount')::integer,0),'bankPopulation',coalesce((r.manifest->>'bankCount')::integer,0),
 'candidateCount',(SELECT count(*) FROM reconciliation.candidate WHERE run_id=rid),'matchedGroups',(SELECT count(*) FROM reconciliation.match_group WHERE run_id=rid),
 'outcomes',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.side,x.outcome) FROM (SELECT m.side,o.outcome,count(*)::integer AS count FROM reconciliation.outcome o JOIN reconciliation.run_member m USING(run_id,item_id) WHERE o.run_id=rid GROUP BY m.side,o.outcome) x),'[]'),
 'values',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.currency,x.side,x.outcome) FROM (SELECT m.snapshot->>'currency' AS currency,m.side,o.outcome,sum((m.snapshot->>'amountMinor')::numeric)::text AS "amountMinor" FROM reconciliation.outcome o JOIN reconciliation.run_member m USING(run_id,item_id) WHERE o.run_id=rid AND m.snapshot->>'amountMinor' IS NOT NULL GROUP BY m.snapshot->>'currency',m.side,o.outcome) x),'[]'),
 'current',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.status) FROM (SELECT status,count(*)::integer AS count FROM reconciliation.current_group WHERE run_id=rid GROUP BY status) x),'[]'),
 'sourceCoverage','UNKNOWN','unknownValueCount',(SELECT count(*) FROM reconciliation.run_member WHERE run_id=rid AND snapshot->>'amountMinor' IS NULL),'populationHash',r.manifest->'populationHash') FROM reconciliation.run r WHERE r.id=rid
$$;
CREATE VIEW reconciliation.operational_metrics AS
 SELECT r.id,r.state,r.rule_version,r.started_at,r.completed_at,
 extract(epoch FROM coalesce(r.completed_at,statement_timestamp())-r.started_at) AS duration_seconds,
 r.manifest->>'processorCount' AS processor_population_count,r.manifest->>'bankCount' AS bank_population_count,
 (SELECT count(*) FROM reconciliation.candidate c WHERE c.run_id=r.id) AS candidate_count,
 (SELECT count(*) FROM reconciliation.match_group g WHERE g.run_id=r.id) AS matched_count,
 (SELECT count(*) FROM reconciliation.outcome o JOIN reconciliation.run_member m USING(run_id,item_id) WHERE o.run_id=r.id AND o.outcome='UNMATCHED' AND m.side='PROCESSOR') AS unmatched_processor_count,
 (SELECT count(*) FROM reconciliation.outcome o JOIN reconciliation.run_member m USING(run_id,item_id) WHERE o.run_id=r.id AND o.outcome='UNMATCHED' AND m.side='BANK') AS unmatched_bank_count,
 (SELECT count(*) FROM reconciliation.outcome o WHERE o.run_id=r.id AND o.outcome='AMBIGUOUS') AS ambiguous_count,
 (SELECT count(*) FROM reconciliation.outcome o WHERE o.run_id=r.id AND o.outcome='INELIGIBLE') AS ineligible_count,
 (SELECT count(*) FROM reconciliation.allocation_decision d WHERE d.caused_by_run_id=r.id AND d.decision='CONFLICT') AS reconciliation_conflict_total,
 CASE WHEN r.state='COMPLETED' THEN 0 ELSE 1 END AS incomplete_run_total FROM reconciliation.run r;

CREATE FUNCTION reconciliation.guard_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE frozen jsonb; expected jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'DRAFT' OR NEW.manifest IS NOT NULL OR NEW.seal_transaction IS NOT NULL OR NEW.plan_transaction IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.command IS DISTINCT FROM jsonb_build_object('mappingId',NEW.mapping_id,'runKey',NEW.run_key,'ruleVersion',NEW.rule_version,
   'from',to_char(NEW.window_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'to',to_char(NEW.window_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'effectiveAt',to_char(NEW.effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid run identity'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','sealed_at','completed_at','seal_transaction','plan_transaction','manifest']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','sealed_at','completed_at','seal_transaction','plan_transaction','manifest'])
 OR NOT ((OLD.state='DRAFT' AND NEW.state='SEALED') OR (OLD.state='SEALED' AND NEW.state='RUNNING') OR (OLD.state='RUNNING' AND NEW.state='COMPLETED')) THEN RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Immutable run or illegal transition'; END IF;
 IF OLD.state='DRAFT' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.side,x.identity),'[]') INTO frozen FROM reconciliation.population(NEW.mapping_id,NEW.window_from,NEW.window_to) x;
  expected:=jsonb_build_object('populationHash',encode(sha256(convert_to(frozen::text,'UTF8')),'hex'),'processorCount',(SELECT count(*) FROM jsonb_array_elements(frozen) x WHERE x->>'side'='PROCESSOR'),'bankCount',(SELECT count(*) FROM jsonb_array_elements(frozen) x WHERE x->>'side'='BANK'),'sourceCoverage','UNKNOWN','population',frozen);
  IF NEW.manifest IS DISTINCT FROM expected OR jsonb_array_length(frozen)>2000 OR NEW.seal_transaction<>pg_current_xact_id() OR NEW.plan_transaction IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.sealed_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid sealed population'; END IF;
 ELSE
  IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at OR NEW.seal_transaction IS DISTINCT FROM OLD.seal_transaction OR (OLD.state='SEALED' AND (NEW.plan_transaction<>pg_current_xact_id() OR NEW.completed_at IS NOT NULL)) OR (OLD.state='RUNNING' AND (NEW.plan_transaction IS DISTINCT FROM OLD.plan_transaction OR NEW.completed_at IS DISTINCT FROM transaction_timestamp())) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid run stage'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER run_transition BEFORE INSERT OR UPDATE OR DELETE ON reconciliation.run FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_run();
CREATE FUNCTION reconciliation.guard_item() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text;
BEGIN
 IF NEW.source_fact_id IS NOT NULL THEN SELECT object_kind INTO STRICT k FROM ingestion.source_fact WHERE id=NEW.source_fact_id;
 ELSE
  IF EXISTS(SELECT FROM ingestion.revision WHERE id=NEW.observation_revision_id AND fact_id IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Alternate economic identity'; END IF;
  SELECT object_kind INTO STRICT k FROM ingestion.raw_record WHERE revision_id=NEW.observation_revision_id LIMIT 1;
 END IF;
 IF (NEW.side='PROCESSOR' AND k<>'synthetic-settlement') OR (NEW.side='BANK' AND k<>'synthetic-bank-entry') THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid economic origin'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER item_origin BEFORE INSERT ON reconciliation.item FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_item();
CREATE FUNCTION reconciliation.guard_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; origin uuid; expected jsonb; pl reconciliation.outcome_plan%ROWTYPE; rm reconciliation.run_member%ROWTYPE; g reconciliation.match_group%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.run_id;
 IF TG_TABLE_NAME='run_member' THEN
  SELECT coalesce(source_fact_id,observation_revision_id) INTO STRICT origin FROM reconciliation.item WHERE id=NEW.item_id AND side=NEW.side;
  SELECT x->'snapshot' INTO expected FROM jsonb_array_elements(r.manifest->'population') x WHERE x->>'identity'=origin::text AND x->>'side'=NEW.side;
  IF r.seal_transaction<>pg_current_xact_id() OR r.state<>'SEALED' OR expected IS NULL OR NEW.snapshot IS DISTINCT FROM expected OR NEW.processor_batch_id IS DISTINCT FROM (CASE WHEN NEW.side='PROCESSOR' THEN (expected->>'selectedId')::uuid END) OR NEW.bank_entry_id IS DISTINCT FROM (CASE WHEN NEW.side='BANK' THEN (expected->>'selectedId')::uuid END) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Forged or late population member'; END IF;
 ELSIF TG_TABLE_NAME='candidate' THEN
  SELECT reconciliation.proof(p.snapshot,b.snapshot) INTO expected FROM reconciliation.run_member p JOIN reconciliation.run_member b ON b.run_id=p.run_id
   WHERE p.run_id=NEW.run_id AND p.item_id=NEW.processor_item_id AND p.side='PROCESSOR' AND b.item_id=NEW.bank_item_id AND b.side='BANK' AND reconciliation.is_candidate(p.snapshot,b.snapshot);
  IF r.plan_transaction<>pg_current_xact_id() OR r.state<>'RUNNING' OR expected IS NULL OR expected IS DISTINCT FROM NEW.evidence THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid or late candidate'; END IF;
 ELSIF TG_TABLE_NAME='outcome_plan' THEN
  SELECT to_jsonb(x) INTO expected FROM reconciliation.planned(NEW.run_id) x WHERE x.item_id=NEW.item_id;
  IF r.plan_transaction<>pg_current_xact_id() OR r.state<>'RUNNING' OR to_jsonb(NEW)-'run_id' IS DISTINCT FROM expected THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid outcome plan'; END IF;
 ELSIF TG_TABLE_NAME='outcome' THEN
  SELECT * INTO STRICT pl FROM reconciliation.outcome_plan WHERE run_id=NEW.run_id AND item_id=NEW.item_id;
  IF r.state<>'RUNNING' OR NEW.outcome<>pl.outcome OR NEW.reason<>pl.reason OR (NEW.group_id IS NOT NULL AND NOT EXISTS(SELECT FROM reconciliation.match_group_member gm JOIN reconciliation.match_group matched_group ON matched_group.id=gm.group_id WHERE gm.group_id=NEW.group_id AND gm.run_id=NEW.run_id AND gm.item_id=NEW.item_id AND matched_group.creation_transaction=pg_current_xact_id())) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid outcome'; END IF;
 ELSIF TG_TABLE_NAME='match_group_member' THEN
  SELECT * INTO STRICT g FROM reconciliation.match_group WHERE id=NEW.group_id;
  SELECT * INTO STRICT rm FROM reconciliation.run_member WHERE run_id=NEW.run_id AND item_id=NEW.item_id;
  IF r.state<>'RUNNING' OR g.creation_transaction<>pg_current_xact_id() OR NEW.signed_amount_minor<>g.signed_amount_minor OR NEW.currency<>g.currency OR NEW.signed_amount_minor::text IS DISTINCT FROM rm.snapshot->>'amountMinor' OR NEW.currency IS DISTINCT FROM rm.snapshot->>'currency' OR NEW.role IS DISTINCT FROM (CASE WHEN rm.side='PROCESSOR' THEN 'PROCESSOR_SETTLEMENT' ELSE 'BANK_MOVEMENT' END) OR (CASE WHEN rm.side='PROCESSOR' THEN rm.processor_batch_id ELSE rm.bank_entry_id END) IS DISTINCT FROM (CASE WHEN rm.side='PROCESSOR' THEN (g.evidence->>'processorEvidenceId')::uuid ELSE (g.evidence->>'bankEvidenceId')::uuid END) OR NOT EXISTS(SELECT FROM reconciliation.outcome_plan WHERE run_id=NEW.run_id AND item_id=NEW.item_id AND outcome='MATCHED') THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid group contribution'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['run_member','candidate','outcome_plan','outcome','match_group_member'] LOOP EXECUTE format('CREATE TRIGGER child_proof BEFORE INSERT ON reconciliation.%I FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_child()',t); END LOOP;
END $$;
CREATE FUNCTION reconciliation.guard_group() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; expected jsonb;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.run_id;
 SELECT c.evidence||jsonb_build_object('ruleVersion',r.rule_version,'mappingId',r.mapping_id,'processorSnapshot',p.snapshot,'bankSnapshot',b.snapshot,'mutualUnique',true,'populationHash',r.manifest->'populationHash') INTO expected
 FROM reconciliation.candidate c JOIN reconciliation.run_member p ON p.run_id=c.run_id AND p.item_id=c.processor_item_id JOIN reconciliation.run_member b ON b.run_id=c.run_id AND b.item_id=c.bank_item_id
 JOIN reconciliation.outcome_plan op ON op.run_id=c.run_id AND op.item_id=p.item_id AND op.counterpart_id=b.item_id AND op.outcome='MATCHED'
 WHERE c.run_id=NEW.run_id AND p.processor_batch_id=(NEW.evidence->>'processorEvidenceId')::uuid AND b.bank_entry_id=(NEW.evidence->>'bankEvidenceId')::uuid;
 IF r.state<>'RUNNING' OR NEW.rule_version<>r.rule_version OR NEW.evidence IS DISTINCT FROM expected OR expected IS NULL OR NOT reconciliation.proof_passes(expected) OR NEW.signed_amount_minor::text IS DISTINCT FROM expected->>'signedAmountMinor' OR NEW.currency IS DISTINCT FROM expected->>'currency' OR NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid reconciliation proof'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER group_proof BEFORE INSERT ON reconciliation.match_group FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_group();
CREATE FUNCTION reconciliation.guard_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g reconciliation.match_group%ROWTYPE; r reconciliation.run%ROWTYPE; gr reconciliation.run%ROWTYPE;
BEGIN
 SELECT * INTO STRICT g FROM reconciliation.match_group WHERE id=NEW.group_id;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.caused_by_run_id;
 SELECT * INTO STRICT gr FROM reconciliation.run WHERE id=g.run_id;
 IF r.mapping_id<>gr.mapping_id OR r.state<>'RUNNING' OR NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid decision scope'; END IF;
 IF NEW.decision IN ('ACTIVE','STALE','CONFLICT') THEN
  IF g.creation_transaction<>pg_current_xact_id() OR NEW.caused_by_run_id<>g.run_id OR (NEW.decision='ACTIVE' AND NOT reconciliation.current_valid(g.id)) OR (NEW.decision='STALE' AND reconciliation.current_valid(g.id)) OR (NEW.decision='CONFLICT' AND NOT EXISTS(SELECT FROM reconciliation.current_allocation a JOIN reconciliation.match_group_member gm ON gm.item_id=a.item_id WHERE gm.group_id=g.id AND a.group_id<>g.id)) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid activation decision'; END IF;
 ELSE
  IF (SELECT count(*) FROM reconciliation.current_allocation WHERE group_id=g.id)<>2 OR (NEW.decision='INVALIDATED' AND reconciliation.current_valid(g.id)) OR (NEW.decision='SUPERSEDED' AND NOT EXISTS(SELECT FROM reconciliation.match_group successor WHERE successor.id=NEW.successor_group_id AND successor.run_id=r.id AND successor.creation_transaction=pg_current_xact_id() AND (SELECT array_agg(item_id ORDER BY item_id) FROM reconciliation.match_group_member WHERE group_id=g.id)=(SELECT array_agg(item_id ORDER BY item_id) FROM reconciliation.match_group_member WHERE group_id=successor.id))) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid supersession decision'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER decision_proof BEFORE INSERT ON reconciliation.allocation_decision FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_decision();
CREATE FUNCTION reconciliation.guard_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT FROM reconciliation.match_group g JOIN reconciliation.allocation_decision d ON d.group_id=g.id WHERE g.id=NEW.group_id AND g.creation_transaction=pg_current_xact_id() AND d.decision='ACTIVE' AND reconciliation.current_valid(g.id)) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid current allocation'; END IF;
  RETURN NEW;
 ELSIF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT FROM reconciliation.allocation_decision WHERE group_id=OLD.group_id AND decision IN ('SUPERSEDED','INVALIDATED') AND creation_transaction=pg_current_xact_id()) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Unaudited allocation release'; END IF;
  RETURN OLD;
 END IF;
 RAISE EXCEPTION USING ERRCODE='P1003',MESSAGE='Allocation replacement requires new decisions';
END $$;
CREATE TRIGGER allocation_proof BEFORE INSERT OR UPDATE OR DELETE ON reconciliation.current_allocation FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_allocation();
CREATE FUNCTION reconciliation.guard_companion() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE rid uuid; did uuid; bk uuid;
BEGIN
 did:=(to_jsonb(NEW)->>'reconciliation_decision_id')::uuid;
 rid:=(to_jsonb(NEW)->>'reconciliation_run_id')::uuid;
 IF did IS NOT NULL THEN SELECT caused_by_run_id INTO STRICT rid FROM reconciliation.allocation_decision WHERE id=did; END IF;
 IF rid IS NULL THEN RETURN NEW; END IF;
 SELECT m.book_id INTO STRICT bk FROM reconciliation.run r JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE r.id=rid;
 IF NEW.book_id<>bk OR (did IS NULL AND NOT EXISTS(SELECT FROM reconciliation.run WHERE id=rid AND state='COMPLETED')) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid reconciliation companion'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_audit_scope BEFORE INSERT ON audit.audit_event FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_companion();
CREATE TRIGGER reconciliation_outbox_scope BEFORE INSERT ON outbox.outbox_event FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_companion();
CREATE FUNCTION reconciliation.validate_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; n integer; actual jsonb;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.id;
 SELECT count(*) INTO n FROM reconciliation.run_member WHERE run_id=r.id;
 IF r.state='DRAFT' THEN IF n<>0 THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Draft has members'; END IF; RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('identity',coalesce(i.source_fact_id,i.observation_revision_id),'side',m.side,'snapshot',m.snapshot) ORDER BY m.side,coalesce(i.source_fact_id,i.observation_revision_id)),'[]') INTO actual
 FROM reconciliation.run_member m JOIN reconciliation.item i ON i.id=m.item_id WHERE m.run_id=r.id;
 IF actual IS DISTINCT FROM r.manifest->'population' THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete sealed population'; END IF;
 IF r.state IN ('RUNNING','COMPLETED') AND ((SELECT count(*) FROM reconciliation.outcome_plan WHERE run_id=r.id)<>n OR (SELECT count(*) FROM reconciliation.candidate WHERE run_id=r.id)<>(SELECT count(*) FROM reconciliation.run_member p JOIN reconciliation.run_member b ON b.run_id=p.run_id WHERE p.run_id=r.id AND p.side='PROCESSOR' AND b.side='BANK' AND reconciliation.is_candidate(p.snapshot,b.snapshot))) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete deterministic plan'; END IF;
 IF r.state='COMPLETED' AND ((SELECT count(*) FROM reconciliation.outcome WHERE run_id=r.id)<>n OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE reconciliation_run_id=r.id)) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete completed run'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER run_commit_guard AFTER INSERT OR UPDATE ON reconciliation.run DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconciliation.validate_run();
CREATE FUNCTION reconciliation.validate_group() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF (SELECT count(*) FROM reconciliation.match_group_member WHERE group_id=NEW.id)<>2 OR (SELECT count(DISTINCT role) FROM reconciliation.match_group_member WHERE group_id=NEW.id)<>2 OR (SELECT count(*) FROM reconciliation.outcome WHERE group_id=NEW.id AND outcome='MATCHED')<>2 OR NOT EXISTS(SELECT FROM reconciliation.allocation_decision WHERE group_id=NEW.id AND decision IN ('ACTIVE','STALE','CONFLICT')) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete 1:1 proof'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER group_commit_guard AFTER INSERT ON reconciliation.match_group DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconciliation.validate_group();
CREATE FUNCTION reconciliation.validate_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM audit.audit_event WHERE reconciliation_decision_id=NEW.id) OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE reconciliation_decision_id=NEW.id)
 OR (NEW.decision='ACTIVE' AND (SELECT count(*) FROM reconciliation.current_allocation WHERE group_id=NEW.group_id)<>2 AND NOT EXISTS(SELECT FROM reconciliation.allocation_decision WHERE group_id=NEW.group_id AND decision IN ('SUPERSEDED','INVALIDATED')))
 OR (NEW.decision IN ('STALE','CONFLICT','SUPERSEDED','INVALIDATED') AND EXISTS(SELECT FROM reconciliation.current_allocation WHERE group_id=NEW.group_id)) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete audited allocation'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER decision_commit_guard AFTER INSERT ON reconciliation.allocation_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconciliation.validate_decision();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['rule_version','account_mapping','item','run_member','candidate','outcome_plan','match_group','match_group_member','outcome','allocation_decision'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_reconciliation_fact BEFORE UPDATE OR DELETE ON reconciliation.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['rule_version','account_mapping','item','run','run_member','candidate','outcome_plan','match_group','match_group_member','outcome','allocation_decision','current_allocation'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON reconciliation.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',t);
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reconciliation FROM PUBLIC;
GRANT USAGE ON SCHEMA reconciliation TO flow_reconciliation_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA reconciliation TO flow_reconciliation_reader;
ALTER FUNCTION reconciliation.current_valid(uuid) SECURITY DEFINER;
GRANT EXECUTE ON FUNCTION reconciliation.summary(uuid),reconciliation.current_valid(uuid) TO flow_reconciliation_reader;
GRANT EXECUTE ON FUNCTION reconciliation.create_run(jsonb),reconciliation.seal(uuid),reconciliation.plan(uuid),reconciliation.advance(uuid,integer),reconciliation.complete(uuid) TO flow_reconciliation_writer;
RESET ROLE;
