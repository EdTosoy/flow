-- Phase 7: conservative complete-declaration N:1. Applied Phase 1–6 migrations stay unchanged.
RESET ROLE;
SET LOCAL ROLE flow_ledger_owner;
INSERT INTO ingestion.normalizer_version VALUES ('synthetic-settlement-group-v1','Supplemental exact settlement interpretation with explicit complete payoutMemberIds; v1 financial interpretation remains pinned');
-- Retain the exact old shape predicate and add only the new supplemental version.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint WHERE conrelid='ingestion.interpretation'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%synthetic-bank-statement-v1%' LOOP
  EXECUTE format('ALTER TABLE ingestion.interpretation DROP CONSTRAINT %I',c.conname);
  EXECUTE 'ALTER TABLE ingestion.interpretation ADD CHECK ((('||c.expression||') OR (normalizer_version=''synthetic-settlement-group-v1'' AND state=''NORMALIZED'' AND failure_code IS NULL AND amount_minor IS NOT NULL AND currency IS NOT NULL AND occurred_at IS NOT NULL AND direction IS NOT NULL AND result->>''state''=''NORMALIZED'' AND result->''observation''->>''type''=''settlement'' AND result->''observation''->''amount''=jsonb_build_object(''amountMinor'',amount_minor::text,''currency'',currency) AND result->''observation''->>''direction''=direction)) IS TRUE)';
 END LOOP;
END $$;
CREATE FUNCTION reconciliation.guard_group_normalization() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r ingestion.raw_record%ROWTYPE; o jsonb:=NEW.result->'observation'; BEGIN
 SELECT * INTO STRICT r FROM ingestion.raw_record WHERE id=NEW.basis_raw_id AND revision_id=NEW.revision_id;
 IF r.object_kind<>'synthetic-settlement' OR r.external_id IS NULL OR o->>'externalId' IS DISTINCT FROM r.external_id OR o->>'type' IS DISTINCT FROM 'settlement' OR o->>'componentKind' IS DISTINCT FROM 'synthetic-movement'
 OR (SELECT count(*) FROM jsonb_object_keys(o))<>9 OR (SELECT count(*) FROM jsonb_object_keys(NEW.result))<>2
 OR length(o->>'transferReference') NOT BETWEEN 1 AND 512 OR o->>'transferReference' IS NULL
 OR bank.valid_time(o->>'occurredAt') IS DISTINCT FROM true OR NEW.occurred_at IS DISTINCT FROM (o->>'occurredAt')::timestamptz
 OR o->'amount' IS DISTINCT FROM jsonb_build_object('amountMinor',NEW.amount_minor::text,'currency',NEW.currency) OR o->>'direction' IS DISTINCT FROM NEW.direction
 OR (o->'payoutMemberIds'<>'null'::jsonb AND (jsonb_typeof(o->'payoutMemberIds') IS DISTINCT FROM 'array' OR jsonb_array_length(o->'payoutMemberIds') NOT BETWEEN 2 AND 10000))
 OR jsonb_typeof(o->'componentIds') IS DISTINCT FROM 'array' OR jsonb_array_length(o->'componentIds')>10000
 OR EXISTS(SELECT FROM jsonb_array_elements((CASE WHEN o->'payoutMemberIds'='null'::jsonb THEN '[]'::jsonb ELSE o->'payoutMemberIds' END)||(o->'componentIds')) x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 512)
 THEN RAISE EXCEPTION USING ERRCODE='P2003',MESSAGE='Invalid complete transfer declaration'; END IF;
 RETURN NEW; END $$;
DROP TRIGGER interpretation_provenance ON ingestion.interpretation;
CREATE TRIGGER interpretation_provenance BEFORE INSERT ON ingestion.interpretation FOR EACH ROW
 WHEN (NEW.normalizer_version NOT IN ('synthetic-bank-entry-v1','synthetic-bank-statement-v1','synthetic-settlement-group-v1') OR NEW.state='FAILED') EXECUTE FUNCTION ingestion.guard_interpretation();
CREATE TRIGGER group_normalization_provenance BEFORE INSERT ON ingestion.interpretation FOR EACH ROW
 WHEN (NEW.normalizer_version='synthetic-settlement-group-v1' AND NEW.state='NORMALIZED') EXECUTE FUNCTION reconciliation.guard_group_normalization();
INSERT INTO reconciliation.rule_version VALUES ('settlement-bank-grouped-v1','Complete explicit payoutMemberIds agreement before arithmetic; mapped exact transfer reference; whole declared sets of 2..32 settlements to one bank; exact signed same-direction amount/currency; UTC 0..72h each; candidate uniqueness; no subsets; declared groups reserve evidence before pair rules');
ALTER TABLE reconciliation.match_group DROP CONSTRAINT match_group_shape_check;
ALTER TABLE reconciliation.match_group ADD CHECK(shape IN ('1:1','N:1'));
ALTER FUNCTION reconciliation.population(uuid,timestamptz,timestamptz) RENAME TO population_v6;
CREATE FUNCTION reconciliation.population(mid uuid,lo timestamptz,hi timestamptz) RETURNS TABLE(identity uuid,side text,snapshot jsonb) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p.identity,p.side,p.snapshot || CASE WHEN p.side='PROCESSOR' THEN jsonb_build_object('externalId',f.external_id,'groupDeclarationFailed',EXISTS(SELECT FROM ingestion.interpretation gi WHERE gi.revision_id=(p.snapshot->>'revisionId')::uuid AND gi.normalizer_version='synthetic-settlement-group-v1' AND gi.state='FAILED'),'groupVariants',coalesce((SELECT jsonb_agg(jsonb_build_object('revisionId',i.revision_id,'normalizerVersion',i.normalizer_version,'reference',i.result->'observation'->'transferReference','currency',i.currency,'members',i.result->'observation'->'payoutMemberIds','selected',i.revision_id=(p.snapshot->>'revisionId')::uuid,'consistent',(i.result->'observation')-'payoutMemberIds'=(SELECT result->'observation' FROM ingestion.interpretation WHERE revision_id=i.revision_id AND normalizer_version='synthetic-settlement-v1' AND state='NORMALIZED')) ORDER BY i.revision_id) FROM ingestion.revision rev JOIN ingestion.interpretation i ON i.revision_id=rev.id WHERE rev.fact_id=p.identity AND i.normalizer_version='synthetic-settlement-group-v1' AND i.state='NORMALIZED' AND i.result->'observation'->'payoutMemberIds'<>'null'::jsonb),'[]')) ELSE '{}'::jsonb END
 FROM reconciliation.population_v6(mid,lo,hi) p LEFT JOIN ingestion.source_fact f ON f.id=p.identity
$$;
CREATE FUNCTION reconciliation.group_search_supported(pop jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH claims AS(SELECT DISTINCT g->'reference' AS ref,g->'currency' AS cur,(SELECT jsonb_agg(v ORDER BY v#>>'{}') FROM jsonb_array_elements(g->'members') v) AS members FROM jsonb_array_elements(pop) p CROSS JOIN LATERAL jsonb_array_elements(p->'snapshot'->'groupVariants') g)
 SELECT (SELECT count(*) FROM claims)<=256 AND
 (SELECT coalesce(sum(coalesce(jsonb_array_length(p->'snapshot'->'groupVariants'),0)+jsonb_array_length(p->'snapshot'->'variants')),0) FROM jsonb_array_elements(pop) p)<=10000 AND
 (SELECT count(*) FROM claims c CROSS JOIN jsonb_array_elements(pop) b WHERE b->>'side'='BANK' AND EXISTS(SELECT FROM jsonb_array_elements(b->'snapshot'->'variants') v WHERE v->'reference'=c.ref AND v->'currency'=c.cur))<=4096
$$;
CREATE TABLE reconciliation.group_candidate(
 run_id uuid NOT NULL REFERENCES reconciliation.run ON DELETE RESTRICT, group_key jsonb NOT NULL, bank_item_id uuid NOT NULL,
 processor_item_ids uuid[] NOT NULL, evidence jsonb NOT NULL, group_key_hash text NOT NULL CHECK(group_key_hash=encode(sha256(convert_to(group_key::text,'UTF8')),'hex')),
 PRIMARY KEY(run_id,group_key_hash,bank_item_id), FOREIGN KEY(run_id,bank_item_id) REFERENCES reconciliation.run_member ON DELETE RESTRICT
);
CREATE TRIGGER immutable_reconciliation_fact BEFORE UPDATE OR DELETE ON reconciliation.group_candidate FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON reconciliation.group_candidate FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation();
-- Deterministic enumeration of declarations, never subsets. Missing/failed competitors are retained.
CREATE FUNCTION reconciliation.group_evaluations(pop jsonb) RETURNS TABLE(group_key jsonb,bank_origin uuid,processor_origins uuid[],evidence jsonb) LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE claim jsonb; members jsonb; b jsonb; total numeric; complete boolean; agree boolean; eligible boolean; direction_checks boolean; time_checks boolean; n integer;
BEGIN
 FOR claim IN SELECT DISTINCT jsonb_build_object('reference',g->'reference','currency',g->'currency','members',(SELECT jsonb_agg(v ORDER BY v#>>'{}') FROM jsonb_array_elements(g->'members') v))
 FROM jsonb_array_elements(pop) p CROSS JOIN LATERAL jsonb_array_elements(p->'snapshot'->'groupVariants') g LOOP
  SELECT coalesce(jsonb_agg(p->'snapshot' ORDER BY p->'snapshot'->>'externalId'),'[]'),array_agg((p->>'identity')::uuid ORDER BY p->>'identity') INTO members,processor_origins
  FROM jsonb_array_elements(pop) p WHERE p->>'side'='PROCESSOR' AND (p->'snapshot'->>'externalId') IN(SELECT jsonb_array_elements_text(claim->'members'));
  processor_origins:=coalesce(processor_origins,'{}'); n:=jsonb_array_length(claim->'members');
  complete:=jsonb_array_length(members)=n AND (SELECT count(DISTINCT v) FROM jsonb_array_elements(claim->'members') v)=n;
  SELECT coalesce(sum((m->>'amountMinor')::numeric),0),coalesce(bool_and((m->>'eligible')::boolean),false),
   coalesce(bool_and(m->>'reference'=claim->>'reference' AND m->>'currency'=claim->>'currency' AND jsonb_array_length(m->'groupVariants')=1 AND
    EXISTS(SELECT FROM jsonb_array_elements(m->'groupVariants') g WHERE (g->>'selected')::boolean AND (g->>'consistent')::boolean AND g->>'reference'=claim->>'reference' AND g->>'currency'=claim->>'currency' AND (SELECT jsonb_agg(v ORDER BY v#>>'{}') FROM jsonb_array_elements(g->'members') v)=claim->'members')),false)
  INTO total,eligible,agree FROM jsonb_array_elements(members) m;
  agree:=agree AND NOT EXISTS(SELECT FROM jsonb_array_elements(pop) x CROSS JOIN LATERAL jsonb_array_elements(x->'snapshot'->'variants') v WHERE x->>'side'='PROCESSOR' AND v->>'reference'=claim->>'reference' AND (x->'snapshot'->>'externalId') NOT IN(SELECT jsonb_array_elements_text(claim->'members')));
  FOR b IN SELECT x->'snapshot' FROM jsonb_array_elements(pop) x WHERE x->>'side'='BANK' AND EXISTS(SELECT FROM jsonb_array_elements(x->'snapshot'->'variants') v WHERE v->>'reference'=claim->>'reference' AND v->>'currency'=claim->>'currency') LOOP
   group_key:=claim; bank_origin:=(b->>'origin')::uuid;
   SELECT coalesce(bool_and((reconciliation.proof(m,b)->>'directionCompatible')::boolean),false),coalesce(bool_and((reconciliation.proof(m,b)->>'bookingWindowValid')::boolean),false) INTO direction_checks,time_checks FROM jsonb_array_elements(members) m;
   evidence:=jsonb_build_object('membershipComplete',complete,'claimsAgree',agree,'groupSizeValid',n BETWEEN 2 AND 32,'declaredCount',n,
    'currencyExact',coalesce(b->>'currency'=claim->>'currency',false),'amountExact',coalesce(total=(b->>'amountMinor')::numeric,false),
    'directionCompatible',direction_checks,'bookingWindowValid',time_checks,'referenceExact',coalesce(b->>'reference'=claim->>'reference',false),
    'processorEligible',eligible,'bankEligible',(b->>'eligible')::boolean,'accountMappingValid',true,
    'groupingKey',claim,'processorSnapshots',members,'bankSnapshot',b,'processorEvidenceIds',(SELECT coalesce(jsonb_agg(m->'selectedId' ORDER BY m->>'selectedId'),'[]') FROM jsonb_array_elements(members) m),
    'bankEvidenceId',b->'selectedId','currency',claim->'currency','reference',claim->'reference','signedAmountMinor',total::text,'windowPolicy','elapsed-UTC-booked-0-to-72h-v1');
   RETURN NEXT;
  END LOOP;
 END LOOP;
END $$;
CREATE FUNCTION reconciliation.group_passes(e jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT reconciliation.proof_passes(e) AND coalesce((e->>'membershipComplete')::boolean AND (e->>'claimsAgree')::boolean AND (e->>'groupSizeValid')::boolean,false)
$$;
CREATE FUNCTION reconciliation.pair_allowed(rid uuid,p jsonb,b jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT r.rule_version='settlement-bank-exact-v1' OR (NOT EXISTS(SELECT FROM reconciliation.run_member m WHERE m.run_id=rid AND (m.snapshot->>'groupDeclarationFailed')::boolean AND (m.snapshot->>'reference'=p->>'reference' OR m.snapshot->>'reference'=b->>'reference')) AND NOT EXISTS(SELECT FROM reconciliation.run_member m CROSS JOIN LATERAL jsonb_array_elements(m.snapshot->'groupVariants') g WHERE m.run_id=rid AND
 (g->>'reference'=p->>'reference' OR g->>'reference'=b->>'reference' OR p->>'externalId' IN(SELECT jsonb_array_elements_text(g->'members')))))
 FROM reconciliation.run r WHERE r.id=rid
$$;
CREATE FUNCTION reconciliation.expected_groups(rid uuid) RETURNS TABLE(group_key jsonb,bank_item_id uuid,processor_item_ids uuid[],evidence jsonb) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT e.group_key,b.item_id,coalesce((SELECT array_agg(m.item_id ORDER BY m.item_id) FROM reconciliation.run_member m WHERE m.run_id=rid AND (m.snapshot->>'origin')::uuid=ANY(e.processor_origins)),'{}'),e.evidence
 FROM reconciliation.group_evaluations((SELECT manifest->'population' FROM reconciliation.run WHERE id=rid)) e JOIN reconciliation.run_member b ON b.run_id=rid AND (b.snapshot->>'origin')::uuid=e.bank_origin
$$;
CREATE FUNCTION reconciliation.guard_group_candidate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF NOT EXISTS(SELECT FROM reconciliation.run r JOIN reconciliation.expected_groups(NEW.run_id) e ON e.group_key=NEW.group_key AND e.bank_item_id=NEW.bank_item_id WHERE r.id=NEW.run_id AND r.rule_version='settlement-bank-grouped-v1' AND r.state='RUNNING' AND r.plan_transaction=pg_current_xact_id() AND e.processor_item_ids=NEW.processor_item_ids AND e.evidence=NEW.evidence) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid or late grouped candidate'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER group_candidate_proof BEFORE INSERT ON reconciliation.group_candidate FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_group_candidate();
ALTER FUNCTION reconciliation.planned(uuid) RENAME TO planned_pairs;
CREATE FUNCTION reconciliation.planned(rid uuid) RETURNS TABLE(item_id uuid,outcome text,counterpart_id uuid,reason text) LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH edges AS(SELECT g.*,EXISTS(SELECT FROM reconciliation.group_candidate h WHERE h.run_id=g.run_id AND (h.group_key,h.bank_item_id)<>(g.group_key,g.bank_item_id) AND (h.bank_item_id=g.bank_item_id OR h.processor_item_ids && g.processor_item_ids)) AS competing FROM reconciliation.group_candidate g WHERE g.run_id=rid),
 own AS(SELECT m.item_id,m.side,m.snapshot,count(e.*) AS degree,bool_or(e.competing) AS competing,bool_or(NOT (e.evidence->>'groupSizeValid')::boolean) AS exceeded,bool_and(reconciliation.group_passes(e.evidence)) AS passes,min(e.bank_item_id::text)::uuid AS bank_id,min(e.processor_item_ids[1]::text)::uuid AS first_processor FROM reconciliation.run_member m LEFT JOIN edges e ON e.bank_item_id=m.item_id OR m.item_id=ANY(e.processor_item_ids) WHERE m.run_id=rid GROUP BY m.item_id,m.side,m.snapshot)
 SELECT o.item_id,CASE WHEN NOT (o.snapshot->>'eligible')::boolean OR o.exceeded OR ((SELECT rule_version FROM reconciliation.run WHERE id=rid)='settlement-bank-grouped-v1' AND coalesce((o.snapshot->>'groupDeclarationFailed')::boolean,false)) THEN 'INELIGIBLE' WHEN o.degree>1 OR o.competing THEN 'AMBIGUOUS' WHEN o.degree=1 AND o.passes THEN 'MATCHED' ELSE p.outcome END,
 CASE WHEN (o.snapshot->>'eligible')::boolean AND NOT coalesce((o.snapshot->>'groupDeclarationFailed')::boolean,false) AND NOT coalesce(o.exceeded,false) AND o.degree=1 AND NOT o.competing AND o.passes THEN CASE WHEN o.side='PROCESSOR' THEN o.bank_id ELSE o.first_processor END WHEN o.degree=0 THEN p.counterpart_id END,
 CASE WHEN NOT (o.snapshot->>'eligible')::boolean THEN (o.snapshot->'reasons')::text WHEN (SELECT rule_version FROM reconciliation.run WHERE id=rid)='settlement-bank-grouped-v1' AND coalesce((o.snapshot->>'groupDeclarationFailed')::boolean,false) THEN 'INVALID_GROUP_DECLARATION' WHEN o.exceeded THEN 'GROUP_SIZE_LIMIT' WHEN o.degree>1 OR o.competing THEN 'NON_UNIQUE_DECLARED_GROUPS' WHEN o.degree=1 AND o.passes THEN 'COMPLETE_DECLARED_GROUP_PROOF' WHEN o.degree=1 THEN 'GROUP_RULE_CHECK_FAILED' ELSE p.reason END
 FROM own o JOIN reconciliation.planned_pairs(rid) p ON p.item_id=o.item_id
$$;
CREATE OR REPLACE FUNCTION reconciliation.create_run(p jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE mapping reconciliation.account_mapping%ROWTYPE; r reconciliation.run%ROWTYPE; cmd jsonb:=p-'actorId';
BEGIN
 IF p->>'ruleVersion' NOT IN ('settlement-bank-exact-v1','settlement-bank-grouped-v1') OR NOT bank.valid_time(p->>'from') OR NOT bank.valid_time(p->>'to') OR NOT bank.valid_time(p->>'effectiveAt') OR (p->>'from')::timestamptz>=(p->>'to')::timestamptz OR length(p->>'actorId') NOT BETWEEN 1 AND 512 OR length(p->>'runKey') NOT BETWEEN 1 AND 512 OR (SELECT count(*) FROM jsonb_object_keys(p))<>7 THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Unsupported run command'; END IF;
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
CREATE OR REPLACE FUNCTION reconciliation.plan(rid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid FOR UPDATE;
 IF r.state IN ('RUNNING','COMPLETED') THEN RETURN; END IF;
 IF r.state<>'SEALED' THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Unsealed run'; END IF;
 UPDATE reconciliation.run SET state='RUNNING',plan_transaction=pg_current_xact_id() WHERE id=rid;
 INSERT INTO reconciliation.candidate SELECT rid,p.item_id,b.item_id,reconciliation.proof(p.snapshot,b.snapshot)
 FROM reconciliation.run_member p CROSS JOIN reconciliation.run_member b WHERE p.run_id=rid AND b.run_id=rid AND p.side='PROCESSOR' AND b.side='BANK' AND reconciliation.is_candidate(p.snapshot,b.snapshot) AND reconciliation.pair_allowed(rid,p.snapshot,b.snapshot);
 IF r.rule_version='settlement-bank-grouped-v1' THEN INSERT INTO reconciliation.group_candidate SELECT rid,e.group_key,e.bank_item_id,e.processor_item_ids,e.evidence,encode(sha256(convert_to(e.group_key::text,'UTF8')),'hex') FROM reconciliation.expected_groups(rid) e; END IF;
 INSERT INTO reconciliation.outcome_plan SELECT rid,item_id,outcome,counterpart_id,reason FROM reconciliation.planned(rid);
END $$;
ALTER FUNCTION reconciliation.guard_child() RENAME TO guard_child_v6;
CREATE FUNCTION reconciliation.guard_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; g reconciliation.match_group%ROWTYPE; rm reconciliation.run_member%ROWTYPE; origin uuid; expected jsonb; pl reconciliation.outcome_plan%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='match_group_member' THEN
  SELECT * INTO STRICT g FROM reconciliation.match_group WHERE id=NEW.group_id;
  IF g.shape='N:1' THEN
   SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.run_id;
   SELECT * INTO STRICT rm FROM reconciliation.run_member WHERE run_id=NEW.run_id AND item_id=NEW.item_id;
   IF r.state<>'RUNNING' OR g.creation_transaction<>pg_current_xact_id() OR NEW.currency<>g.currency OR NEW.signed_amount_minor::text IS DISTINCT FROM rm.snapshot->>'amountMinor' OR NEW.currency IS DISTINCT FROM rm.snapshot->>'currency'
   OR NEW.role IS DISTINCT FROM (CASE WHEN rm.side='PROCESSOR' THEN 'PROCESSOR_SETTLEMENT' ELSE 'BANK_MOVEMENT' END)
   OR NOT EXISTS(SELECT FROM reconciliation.group_candidate c WHERE c.run_id=NEW.run_id AND c.group_key=g.evidence->'groupingKey' AND c.bank_item_id=(SELECT item_id FROM reconciliation.run_member WHERE run_id=NEW.run_id AND bank_entry_id=(g.evidence->>'bankEvidenceId')::uuid) AND (NEW.item_id=c.bank_item_id OR NEW.item_id=ANY(c.processor_item_ids)))
   OR NOT EXISTS(SELECT FROM reconciliation.outcome_plan WHERE run_id=NEW.run_id AND item_id=NEW.item_id AND outcome='MATCHED') THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid grouped contribution'; END IF;
   RETURN NEW;
  END IF;
 END IF;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.run_id;
 IF TG_TABLE_NAME='run_member' THEN
  SELECT coalesce(source_fact_id,observation_revision_id) INTO STRICT origin FROM reconciliation.item WHERE id=NEW.item_id AND side=NEW.side;
  SELECT x->'snapshot' INTO expected FROM jsonb_array_elements(r.manifest->'population') x WHERE x->>'identity'=origin::text AND x->>'side'=NEW.side;
  IF r.seal_transaction<>pg_current_xact_id() OR r.state<>'SEALED' OR expected IS NULL OR NEW.snapshot IS DISTINCT FROM expected OR NEW.processor_batch_id IS DISTINCT FROM (CASE WHEN NEW.side='PROCESSOR' THEN (expected->>'selectedId')::uuid END) OR NEW.bank_entry_id IS DISTINCT FROM (CASE WHEN NEW.side='BANK' THEN (expected->>'selectedId')::uuid END) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Forged or late population member'; END IF;
 ELSIF TG_TABLE_NAME='candidate' THEN
  SELECT reconciliation.proof(p.snapshot,b.snapshot) INTO expected FROM reconciliation.run_member p JOIN reconciliation.run_member b ON b.run_id=p.run_id
   WHERE p.run_id=NEW.run_id AND p.item_id=NEW.processor_item_id AND p.side='PROCESSOR' AND b.item_id=NEW.bank_item_id AND b.side='BANK' AND reconciliation.is_candidate(p.snapshot,b.snapshot) AND reconciliation.pair_allowed(NEW.run_id,p.snapshot,b.snapshot);
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
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['run_member','candidate','outcome_plan','outcome','match_group_member'] LOOP
 EXECUTE format('DROP TRIGGER child_proof ON reconciliation.%I',t);
 EXECUTE format('CREATE TRIGGER child_proof BEFORE INSERT ON reconciliation.%I FOR EACH ROW EXECUTE FUNCTION reconciliation.guard_child()',t); END LOOP; END $$;
CREATE OR REPLACE FUNCTION reconciliation.guard_group() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; expected jsonb;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.run_id;
 IF NEW.shape='N:1' THEN
  SELECT c.evidence||jsonb_build_object('ruleVersion',r.rule_version,'mappingId',r.mapping_id,'mutualUnique',true,'populationHash',r.manifest->'populationHash') INTO expected
  FROM reconciliation.group_candidate c JOIN reconciliation.run_member b ON b.run_id=c.run_id AND b.item_id=c.bank_item_id
  WHERE c.run_id=NEW.run_id AND c.group_key=NEW.evidence->'groupingKey' AND b.bank_entry_id=(NEW.evidence->>'bankEvidenceId')::uuid
   AND NOT EXISTS(SELECT FROM reconciliation.outcome_plan p WHERE p.run_id=c.run_id AND (p.item_id=c.bank_item_id OR p.item_id=ANY(c.processor_item_ids)) AND (p.outcome<>'MATCHED' OR p.reason<>'COMPLETE_DECLARED_GROUP_PROOF'));
  IF r.rule_version<>'settlement-bank-grouped-v1' OR NOT reconciliation.group_passes(expected) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid grouped proof'; END IF;
 ELSE
 SELECT c.evidence||jsonb_build_object('ruleVersion',r.rule_version,'mappingId',r.mapping_id,'processorSnapshot',p.snapshot,'bankSnapshot',b.snapshot,'mutualUnique',true,'populationHash',r.manifest->'populationHash') INTO expected
 FROM reconciliation.candidate c JOIN reconciliation.run_member p ON p.run_id=c.run_id AND p.item_id=c.processor_item_id JOIN reconciliation.run_member b ON b.run_id=c.run_id AND b.item_id=c.bank_item_id
 JOIN reconciliation.outcome_plan op ON op.run_id=c.run_id AND op.item_id=p.item_id AND op.counterpart_id=b.item_id AND op.outcome='MATCHED'
 WHERE c.run_id=NEW.run_id AND p.processor_batch_id=(NEW.evidence->>'processorEvidenceId')::uuid AND b.bank_entry_id=(NEW.evidence->>'bankEvidenceId')::uuid;
 END IF;
 IF r.state<>'RUNNING' OR NEW.rule_version<>r.rule_version OR NEW.evidence IS DISTINCT FROM expected OR expected IS NULL OR NOT reconciliation.proof_passes(expected) OR NEW.signed_amount_minor::text IS DISTINCT FROM expected->>'signedAmountMinor' OR NEW.currency IS DISTINCT FROM expected->>'currency' OR NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid reconciliation proof'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reconciliation.valid_against(gid uuid,fresh jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE p jsonb; b jsonb; oldp jsonb; oldb jsonb; g reconciliation.match_group%ROWTYPE; e record; contenders integer;
BEGIN
 SELECT * INTO STRICT g FROM reconciliation.match_group WHERE id=gid;
 IF g.shape='N:1' THEN
  SELECT * INTO e FROM reconciliation.group_evaluations(fresh) x WHERE x.group_key=g.evidence->'groupingKey' AND x.evidence->>'bankEvidenceId'=g.evidence->>'bankEvidenceId';
  IF NOT FOUND OR NOT reconciliation.group_passes(e.evidence) OR e.evidence IS DISTINCT FROM g.evidence-ARRAY['ruleVersion','mappingId','mutualUnique','populationHash'] THEN RETURN false; END IF;
  SELECT count(*) INTO contenders FROM reconciliation.group_evaluations(fresh) x WHERE x.bank_origin=e.bank_origin OR x.processor_origins && e.processor_origins;
  RETURN contenders=1;
 END IF;
 SELECT rm.snapshot INTO STRICT oldp FROM reconciliation.match_group_member gm JOIN reconciliation.run_member rm ON rm.run_id=gm.run_id AND rm.item_id=gm.item_id WHERE gm.group_id=gid AND gm.role='PROCESSOR_SETTLEMENT';
 SELECT rm.snapshot INTO STRICT oldb FROM reconciliation.match_group_member gm JOIN reconciliation.run_member rm ON rm.run_id=gm.run_id AND rm.item_id=gm.item_id WHERE gm.group_id=gid AND gm.role='BANK_MOVEMENT';
 SELECT x->'snapshot' INTO p FROM jsonb_array_elements(fresh) x WHERE x->>'identity'=oldp->>'origin' AND x->>'side'='PROCESSOR';
 SELECT x->'snapshot' INTO b FROM jsonb_array_elements(fresh) x WHERE x->>'identity'=oldb->>'origin' AND x->>'side'='BANK';
 IF g.rule_version='settlement-bank-grouped-v1' AND (
  EXISTS(SELECT FROM jsonb_array_elements(fresh) x CROSS JOIN LATERAL jsonb_array_elements(x->'snapshot'->'groupVariants') gv WHERE gv->>'reference'=p->>'reference' OR gv->>'reference'=b->>'reference' OR p->>'externalId' IN(SELECT jsonb_array_elements_text(gv->'members')))
  OR EXISTS(SELECT FROM jsonb_array_elements(fresh) x WHERE coalesce((x->'snapshot'->>'groupDeclarationFailed')::boolean,false) AND (x->'snapshot'->>'reference'=p->>'reference' OR x->'snapshot'->>'reference'=b->>'reference'))
 ) THEN RETURN false; END IF;
 IF p IS NULL OR b IS NULL OR p->>'selectedId' IS DISTINCT FROM oldp->>'selectedId' OR b->>'selectedId' IS DISTINCT FROM oldb->>'selectedId' OR p->'domainControls' IS DISTINCT FROM oldp->'domainControls' OR b->'domainControls' IS DISTINCT FROM oldb->'domainControls' OR NOT reconciliation.proof_passes(reconciliation.proof(p,b)) THEN RETURN false; END IF;
 RETURN (SELECT count(*) FROM jsonb_array_elements(fresh) x WHERE x->>'side'='BANK' AND reconciliation.is_candidate(p,x->'snapshot'))=1
 AND (SELECT count(*) FROM jsonb_array_elements(fresh) x WHERE x->>'side'='PROCESSOR' AND reconciliation.is_candidate(x->'snapshot',b))=1;
END $$;
CREATE OR REPLACE FUNCTION reconciliation.advance(rid uuid,lim integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; mapping reconciliation.account_mapping%ROWTYPE; planned record; pm reconciliation.run_member%ROWTYPE; bm reconciliation.run_member%ROWTYPE; gid uuid; old_group uuid; fresh jsonb; n integer:=0; conflict boolean; ids uuid[]; ce jsonb; shape text;
BEGIN
 IF lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Invalid progress bound'; END IF;
 SELECT m.* INTO STRICT mapping FROM reconciliation.run rr JOIN reconciliation.account_mapping m ON m.id=rr.mapping_id WHERE rr.id=rid;
 PERFORM FROM ledger.book WHERE id=mapping.book_id FOR NO KEY UPDATE;
 PERFORM FROM ingestion.source_account WHERE id IN(mapping.processor_source_account_id,mapping.bank_source_account_id) ORDER BY id FOR UPDATE;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid FOR UPDATE;
 IF r.state='COMPLETED' THEN RETURN 0; END IF;
 IF r.state<>'RUNNING' THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Unplanned run'; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO fresh FROM reconciliation.population(r.mapping_id,r.window_from,r.window_to) x;
 FOR old_group IN SELECT DISTINCT a.group_id FROM reconciliation.current_allocation a JOIN reconciliation.match_group g ON g.id=a.group_id JOIN reconciliation.run oldr ON oldr.id=g.run_id WHERE oldr.mapping_id=r.mapping_id LOOP
  IF NOT reconciliation.current_valid(old_group) THEN PERFORM reconciliation.record_decision(old_group,rid,'INVALIDATED'); DELETE FROM reconciliation.current_allocation WHERE group_id=old_group; END IF;
 END LOOP;
 FOR planned IN SELECT op.* FROM reconciliation.outcome_plan op WHERE op.run_id=rid AND NOT EXISTS(SELECT FROM reconciliation.outcome o WHERE o.run_id=rid AND o.item_id=op.item_id) ORDER BY op.item_id LIMIT lim LOOP
  IF EXISTS(SELECT FROM reconciliation.outcome WHERE run_id=rid AND item_id=planned.item_id) THEN CONTINUE; END IF;
  IF planned.outcome='MATCHED' THEN
   IF planned.reason='COMPLETE_DECLARED_GROUP_PROOF' THEN
    SELECT c.processor_item_ids||c.bank_item_id,c.evidence INTO STRICT ids,ce FROM reconciliation.group_candidate c WHERE c.run_id=rid AND (c.bank_item_id=planned.item_id OR planned.item_id=ANY(c.processor_item_ids)); shape:='N:1';
   ELSE
    ids:=ARRAY[planned.item_id,planned.counterpart_id]; shape:='1:1';
    SELECT * INTO STRICT pm FROM reconciliation.run_member WHERE run_id=rid AND item_id=ANY(ids) AND side='PROCESSOR';
    SELECT * INTO STRICT bm FROM reconciliation.run_member WHERE run_id=rid AND item_id=ANY(ids) AND side='BANK';
    SELECT evidence||jsonb_build_object('processorSnapshot',pm.snapshot,'bankSnapshot',bm.snapshot) INTO STRICT ce FROM reconciliation.candidate WHERE run_id=rid AND processor_item_id=pm.item_id AND bank_item_id=bm.item_id;
   END IF;
   INSERT INTO reconciliation.match_group(run_id,rule_version,shape,currency,signed_amount_minor,evidence)
   VALUES(rid,r.rule_version,shape,ce->>'currency',(ce->>'signedAmountMinor')::bigint,ce||jsonb_build_object('ruleVersion',r.rule_version,'mappingId',mapping.id,'mutualUnique',true,'populationHash',r.manifest->'populationHash')) RETURNING id INTO gid;
   INSERT INTO reconciliation.match_group_member SELECT gid,rid,m.item_id,CASE WHEN m.side='PROCESSOR' THEN 'PROCESSOR_SETTLEMENT' ELSE 'BANK_MOVEMENT' END,(m.snapshot->>'amountMinor')::bigint,m.snapshot->>'currency' FROM reconciliation.run_member m WHERE m.run_id=rid AND m.item_id=ANY(ids);
   INSERT INTO reconciliation.outcome SELECT rid,op.item_id,op.outcome,op.reason,gid FROM reconciliation.outcome_plan op WHERE op.run_id=rid AND op.item_id=ANY(ids);
   IF NOT reconciliation.valid_against(gid,fresh) THEN PERFORM reconciliation.record_decision(gid,rid,'STALE');
   ELSE
    conflict:=EXISTS(SELECT FROM reconciliation.current_allocation a WHERE a.item_id=ANY(ids) AND (SELECT array_agg(gm.item_id ORDER BY gm.item_id) FROM reconciliation.match_group_member gm WHERE gm.group_id=a.group_id) IS DISTINCT FROM (SELECT array_agg(i ORDER BY i) FROM unnest(ids) i));
    IF conflict THEN PERFORM reconciliation.record_decision(gid,rid,'CONFLICT');
    ELSE
     FOR old_group IN SELECT DISTINCT group_id FROM reconciliation.current_allocation WHERE item_id=ANY(ids) LOOP
      PERFORM reconciliation.record_decision(old_group,rid,'SUPERSEDED',gid); DELETE FROM reconciliation.current_allocation WHERE group_id=old_group;
     END LOOP;
     PERFORM reconciliation.record_decision(gid,rid,'ACTIVE');
     INSERT INTO reconciliation.current_allocation SELECT i,'settlement_bank',gid FROM unnest(ids) i;
    END IF;
   END IF;
   n:=n+cardinality(ids);
  ELSE INSERT INTO reconciliation.outcome VALUES(rid,planned.item_id,planned.outcome,planned.reason,NULL); n:=n+1;
  END IF;
 END LOOP;
 RETURN n;
END $$;
CREATE OR REPLACE FUNCTION reconciliation.record_decision(gid uuid,rid uuid,d text,successor uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE event_id uuid; bk uuid; actor text;
BEGIN
 SELECT m.book_id,r.actor_id INTO STRICT bk,actor FROM reconciliation.run r JOIN reconciliation.account_mapping m ON m.id=r.mapping_id WHERE r.id=rid;
 INSERT INTO reconciliation.allocation_decision(group_id,caused_by_run_id,decision,successor_group_id) VALUES(gid,rid,d,successor) RETURNING id INTO event_id;
 INSERT INTO audit.audit_event(book_id,reconciliation_decision_id,action,actor_id,previous_state,new_state,reason,policy_version)
 VALUES(bk,event_id,'reconciliation.decision',actor,'absent','recorded',d||' settlement-bank proof; immutable decision links run and group',(SELECT rule_version FROM reconciliation.run WHERE id=rid));
 INSERT INTO outbox.outbox_event(book_id,reconciliation_decision_id,event_type,aggregate_version,schema_version,payload)
 VALUES(bk,event_id,'reconciliation.decision',1,1,jsonb_build_object('bookId',bk,'decisionId',event_id));
END $$;
CREATE OR REPLACE FUNCTION reconciliation.guard_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g reconciliation.match_group%ROWTYPE; r reconciliation.run%ROWTYPE; gr reconciliation.run%ROWTYPE;
BEGIN
 SELECT * INTO STRICT g FROM reconciliation.match_group WHERE id=NEW.group_id;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.caused_by_run_id;
 SELECT * INTO STRICT gr FROM reconciliation.run WHERE id=g.run_id;
 IF r.mapping_id<>gr.mapping_id OR r.state<>'RUNNING' OR NEW.creation_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid decision scope'; END IF;
 IF NEW.decision IN ('ACTIVE','STALE','CONFLICT') THEN
  IF g.creation_transaction<>pg_current_xact_id() OR NEW.caused_by_run_id<>g.run_id OR (NEW.decision='ACTIVE' AND NOT reconciliation.current_valid(g.id)) OR (NEW.decision='STALE' AND reconciliation.current_valid(g.id)) OR (NEW.decision='CONFLICT' AND NOT EXISTS(SELECT FROM reconciliation.current_allocation a JOIN reconciliation.match_group_member gm ON gm.item_id=a.item_id WHERE gm.group_id=g.id AND a.group_id<>g.id)) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid activation decision'; END IF;
 ELSE
  IF (SELECT count(*) FROM reconciliation.current_allocation WHERE group_id=g.id)<>(SELECT count(*) FROM reconciliation.match_group_member WHERE group_id=g.id) OR (NEW.decision='INVALIDATED' AND reconciliation.current_valid(g.id)) OR (NEW.decision='SUPERSEDED' AND NOT EXISTS(SELECT FROM reconciliation.match_group successor WHERE successor.id=NEW.successor_group_id AND successor.run_id=r.id AND successor.creation_transaction=pg_current_xact_id() AND (SELECT array_agg(item_id ORDER BY item_id) FROM reconciliation.match_group_member WHERE group_id=g.id)=(SELECT array_agg(item_id ORDER BY item_id) FROM reconciliation.match_group_member WHERE group_id=successor.id))) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid supersession decision'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION reconciliation.validate_group() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE pn integer; bn integer; n integer; ps numeric; bs numeric;
BEGIN
 SELECT count(*) FILTER(WHERE role='PROCESSOR_SETTLEMENT'),count(*) FILTER(WHERE role='BANK_MOVEMENT'),count(*),sum(signed_amount_minor) FILTER(WHERE role='PROCESSOR_SETTLEMENT'),sum(signed_amount_minor) FILTER(WHERE role='BANK_MOVEMENT') INTO pn,bn,n,ps,bs FROM reconciliation.match_group_member WHERE group_id=NEW.id;
 IF bn<>1 OR (NEW.shape='1:1' AND pn<>1) OR (NEW.shape='N:1' AND pn NOT BETWEEN 2 AND 32) OR ps IS DISTINCT FROM bs OR bs IS DISTINCT FROM NEW.signed_amount_minor::numeric
 OR EXISTS(SELECT FROM reconciliation.match_group_member WHERE group_id=NEW.id AND (currency<>NEW.currency OR sign(signed_amount_minor)<>sign(NEW.signed_amount_minor)))
 OR (SELECT count(*) FROM reconciliation.outcome WHERE group_id=NEW.id AND outcome='MATCHED')<>n
 OR NOT EXISTS(SELECT FROM reconciliation.allocation_decision WHERE group_id=NEW.id AND decision IN('ACTIVE','STALE','CONFLICT')) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete/nonconserving whole-item proof'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION reconciliation.validate_decision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM audit.audit_event WHERE reconciliation_decision_id=NEW.id) OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE reconciliation_decision_id=NEW.id)
 OR (NEW.decision='ACTIVE' AND (SELECT count(*) FROM reconciliation.current_allocation WHERE group_id=NEW.group_id)<>(SELECT count(*) FROM reconciliation.match_group_member WHERE group_id=NEW.group_id) AND NOT EXISTS(SELECT FROM reconciliation.allocation_decision WHERE group_id=NEW.group_id AND decision IN ('SUPERSEDED','INVALIDATED')))
 OR (NEW.decision IN ('STALE','CONFLICT','SUPERSEDED','INVALIDATED') AND EXISTS(SELECT FROM reconciliation.current_allocation WHERE group_id=NEW.group_id)) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete audited allocation'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION reconciliation.validate_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; n integer; actual jsonb;
BEGIN
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=NEW.id;
 SELECT count(*) INTO n FROM reconciliation.run_member WHERE run_id=r.id;
 IF r.state='DRAFT' THEN IF n<>0 THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Draft has members'; END IF; RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('identity',coalesce(i.source_fact_id,i.observation_revision_id),'side',m.side,'snapshot',m.snapshot) ORDER BY m.side,coalesce(i.source_fact_id,i.observation_revision_id)),'[]') INTO actual
 FROM reconciliation.run_member m JOIN reconciliation.item i ON i.id=m.item_id WHERE m.run_id=r.id;
 IF actual IS DISTINCT FROM r.manifest->'population' THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete sealed population'; END IF;
 IF r.state IN ('RUNNING','COMPLETED') AND ((SELECT count(*) FROM reconciliation.outcome_plan WHERE run_id=r.id)<>n OR (SELECT count(*) FROM reconciliation.candidate WHERE run_id=r.id)<>(SELECT count(*) FROM reconciliation.run_member p JOIN reconciliation.run_member b ON b.run_id=p.run_id WHERE p.run_id=r.id AND p.side='PROCESSOR' AND b.side='BANK' AND reconciliation.is_candidate(p.snapshot,b.snapshot) AND reconciliation.pair_allowed(r.id,p.snapshot,b.snapshot))) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete deterministic plan'; END IF;
 IF r.state='COMPLETED' AND ((SELECT count(*) FROM reconciliation.outcome WHERE run_id=r.id)<>n OR NOT EXISTS(SELECT FROM outbox.outbox_event WHERE reconciliation_run_id=r.id)) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete completed run'; END IF;
 IF r.state IN ('RUNNING','COMPLETED') AND r.rule_version='settlement-bank-grouped-v1' AND (SELECT count(*) FROM reconciliation.group_candidate WHERE run_id=r.id)<>(SELECT count(*) FROM reconciliation.expected_groups(r.id)) THEN RAISE EXCEPTION USING ERRCODE='P6004',MESSAGE='Incomplete grouped plan'; END IF;
 RETURN NULL;
END $$;
ALTER FUNCTION reconciliation.summary(uuid) RENAME TO summary_v6;
CREATE FUNCTION reconciliation.summary(rid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT reconciliation.summary_v6(rid)||CASE WHEN r.rule_version='settlement-bank-grouped-v1' THEN jsonb_build_object('grouped',jsonb_build_object(
 'candidateCount',(SELECT count(*) FROM reconciliation.group_candidate WHERE run_id=rid),
 'partitionCount',(SELECT count(DISTINCT group_key) FROM reconciliation.group_candidate WHERE run_id=rid),
 'matchedGroups',(SELECT count(*) FROM reconciliation.match_group WHERE run_id=rid AND shape='N:1'),
 'processorMembers',(SELECT count(*) FROM reconciliation.match_group_member m JOIN reconciliation.match_group g ON g.id=m.group_id WHERE g.run_id=rid AND g.shape='N:1' AND m.role='PROCESSOR_SETTLEMENT'),
 'refusedLimitCount',(SELECT count(*) FROM reconciliation.outcome_plan WHERE run_id=rid AND reason='GROUP_SIZE_LIMIT'),
 'ambiguousCount',(SELECT count(*) FROM reconciliation.outcome_plan WHERE run_id=rid AND reason='NON_UNIQUE_DECLARED_GROUPS'),
 'values',(SELECT coalesce(jsonb_agg(to_jsonb(v)),'[]') FROM(SELECT currency,sum(signed_amount_minor)::text AS "amountMinor" FROM reconciliation.match_group WHERE run_id=rid AND shape='N:1' GROUP BY currency) v))) ELSE '{}'::jsonb END FROM reconciliation.run r WHERE r.id=rid
$$;
CREATE VIEW reconciliation.grouped_metrics AS
 SELECT r.id,r.rule_version,r.state,extract(epoch FROM coalesce(r.completed_at,statement_timestamp())-r.started_at) AS grouped_evaluation_duration,
 (reconciliation.summary(r.id)->'grouped') AS grouped_metrics,
 (SELECT max(cardinality(processor_item_ids)) FROM reconciliation.group_candidate WHERE run_id=r.id) AS grouped_candidate_partition_size,
 (SELECT count(*) FROM reconciliation.allocation_decision WHERE caused_by_run_id=r.id AND decision='CONFLICT') AS allocation_conflict_total
 FROM reconciliation.run r WHERE r.rule_version='settlement-bank-grouped-v1';
CREATE OR REPLACE FUNCTION reconciliation.seal(rid uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r reconciliation.run%ROWTYPE; row record; iid uuid; frozen jsonb; frozen_manifest jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Freeze requires repeatable read'; END IF;
 SELECT * INTO STRICT r FROM reconciliation.run WHERE id=rid FOR UPDATE;
 IF r.state<>'DRAFT' THEN RETURN; END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.side,x.identity),'[]') INTO frozen FROM reconciliation.population(r.mapping_id,r.window_from,r.window_to) x;
 IF r.rule_version='settlement-bank-grouped-v1' AND NOT reconciliation.group_search_supported(frozen) THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Unsupported grouped search bound: declarations/variants/candidates'; END IF;
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
CREATE OR REPLACE FUNCTION reconciliation.guard_run() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
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
  IF NEW.rule_version='settlement-bank-grouped-v1' AND NOT reconciliation.group_search_supported(frozen) THEN RAISE EXCEPTION USING ERRCODE='P6002',MESSAGE='Unsupported grouped search bound'; END IF;
  IF NEW.manifest IS DISTINCT FROM expected OR jsonb_array_length(frozen)>2000 OR NEW.seal_transaction<>pg_current_xact_id() OR NEW.plan_transaction IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.sealed_at IS DISTINCT FROM transaction_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid sealed population'; END IF;
 ELSE
  IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at OR NEW.seal_transaction IS DISTINCT FROM OLD.seal_transaction OR (OLD.state='SEALED' AND (NEW.plan_transaction<>pg_current_xact_id() OR NEW.completed_at IS NOT NULL)) OR (OLD.state='RUNNING' AND (NEW.plan_transaction IS DISTINCT FROM OLD.plan_transaction OR NEW.completed_at IS DISTINCT FROM transaction_timestamp())) THEN RAISE EXCEPTION USING ERRCODE='P6003',MESSAGE='Invalid run stage'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reconciliation FROM PUBLIC;
-- Renamed helpers retain old ACLs; remove newly exposed historical command helpers.
REVOKE ALL ON FUNCTION reconciliation.population_v6(uuid,timestamptz,timestamptz),reconciliation.summary_v6(uuid) FROM flow_reconciliation_reader,flow_reconciliation_writer;
GRANT SELECT ON reconciliation.group_candidate,reconciliation.grouped_metrics TO flow_reconciliation_reader;
GRANT EXECUTE ON FUNCTION reconciliation.summary(uuid) TO flow_reconciliation_reader;
RESET ROLE;
