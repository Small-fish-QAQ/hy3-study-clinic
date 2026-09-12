import { witnesses } from './packet.mjs';
import { assert,sha } from './util.mjs';

const one = (rows, key, value) => Array.isArray(rows) && rows.filter(x=>x?.[key]===value).length===1 ? rows.find(x=>x[key]===value) : null;
const has = (ws, role) => ws?.some(w=>w.role===role);
const target = ws => ws?.some(w=>['artifact','question','product'].includes(w.role));
const reason = row => typeof row?.reason === 'string' && row.reason.trim().length > 0;
const grounded = (packet,row) => reason(row) ? witnesses(packet,row.refs) : null;
const uncertain = (proposed, code, extra={}) => ({ ...extra, proposed: proposed ?? null, reviewReasons:[code] });

export function validateContext(packet, view, raw) {
  assert(raw && typeof raw==='object','CONTEXT_OBJECT_REQUIRED');
  return {contexts:view.tasks.map(t=>{
    const p=one(raw.contexts,'taskId',t.id);
    // Accept either the exact compiled fact ID or the unique history-unit ID
    // already present in this request; both resolve to the same original text.
    const canonical=ref=>packet.facts.find(f=>f.id===ref)?.id ?? packet.facts.find(f=>
      f.pointer===`/history/${view.history.findIndex(h=>h.id===ref)}/text`)?.id;
    const valid=p && ['ready','uncertain'].includes(p.status) && reason(p) && Array.isArray(p.premises)
      && p.premises.every(x=>typeof x?.quote==='string' && x.quote.trim() && packet.facts.some(f=>
        f.id===canonical(x.ref) && f.kind==='text' && view.history.some((h,j)=>t.historyIds.includes(h.id) && f.pointer===`/history/${j}/text`) && f.value.includes(x.quote)));
    if(!valid)return {taskId:t.id,status:'uncertain',premises:[],...uncertain(p,'SCENARIO_EXTRACTION_UNGROUNDED')};
    return {...p,premises:p.premises.map(x=>({...x,ref:canonical(x.ref),proposedRef:x.ref,witness:witnesses(packet,[canonical(x.ref)])[0]})),reviewReasons:[]};
  })};
}

export function validateSolve(packet, raw) {
  assert(raw && typeof raw==='object', 'SOLVE_OBJECT_REQUIRED');
  const ws = witnesses(packet,raw.refs);
  if (!['resolved','uncertain'].includes(raw.status) || typeof raw.solution!=='string' || !raw.solution.trim() || !has(ws,'question')) {
    return { status:'uncertain', solution:'Independent solution could not be established.', ...uncertain(raw,'BLIND_SOLUTION_UNGROUNDED') };
  }
  return { status:raw.status, solution:raw.solution, witnesses:ws, reviewReasons:[] };
}
export function validateCriteria(packet, view, solution, raw) {
  assert(raw && typeof raw==='object', 'CRITERIA_OBJECT_REQUIRED');
  const validityWitnesses = grounded(packet,raw);
  const taskValidity = ['valid','invalid','uncertain'].includes(raw.taskValidity) && validityWitnesses ? raw.taskValidity : 'uncertain';
  const rubricValidity = ['valid','invalid','uncertain'].includes(raw.rubricValidity) && validityWitnesses ? raw.rubricValidity : 'uncertain';
  const criteria = (view.rubric || []).map(c=>{
    const p = one(raw.criteria,'id',c.id), ws = grounded(packet,p);
    if (!['met','partial','not_met','uncertain'].includes(p?.result) || !has(ws,'student') || !ws.some(w=>w.pointer===`/rubric/${view.rubric.indexOf(c)}/text`)) {
      return { id:c.id, required:c.required, result:'uncertain', reason:'Student/criterion evidence is missing or invalid.',
        ...uncertain(p,'CRITERION_STUDENT_GROUNDING_MISSING') };
    }
    return { id:c.id, required:c.required, result:p.result, reason:p.reason, witnesses:ws, reviewReasons:[] };
  });
  const required = criteria.filter(c=>c.required);
  const sufficiency = !required.length || solution?.status!=='resolved' || taskValidity!=='valid' || rubricValidity!=='valid' ? 'uncertain'
    : required.some(c=>['not_met','partial'].includes(c.result)) ? 'insufficient'
    : required.some(c=>c.result==='uncertain') ? 'uncertain' : 'sufficient';
  return { taskValidity,rubricValidity,reason:raw.reason || 'Unestablished validity',validityWitnesses,criteria,sufficiency,
    reviewReasons: !validityWitnesses ? ['VALIDITY_EVIDENCE_MISSING'] : [] };
}

export function reconcileCriteria(first, second) {
  const criteria=first.criteria.map(c=>{
    const other=second.criteria.find(x=>x.id===c.id);
    if(!other || c.result!==other.result)return {...c,result:'uncertain',reason:'Independent semantic readings differ; review the actual answer and requirement.',
      readings:[c,other??null],reviewReasons:['CRITERION_SEMANTIC_DISAGREEMENT']};
    return {...c,independentWitnesses:other.witnesses};
  });
  const taskValidity=first.taskValidity===second.taskValidity?first.taskValidity:'uncertain';
  const rubricValidity=first.rubricValidity===second.rubricValidity?first.rubricValidity:'uncertain';
  const required=criteria.filter(c=>c.required);
  const sufficiency=taskValidity!=='valid'||rubricValidity!=='valid'||!required.length
    ||first.sufficiency==='uncertain'||second.sufficiency==='uncertain'||required.some(c=>c.result==='uncertain')?'uncertain'
    :required.some(c=>c.result!=='met')?'insufficient':'sufficient';
  return {...first,criteria,taskValidity,rubricValidity,sufficiency,independentAssessments:[first,second]};
}

export function validateAudit(packet, dimensions, raw, view=null, solution=null) {
  const rows = Array.isArray(raw) ? raw : raw?.dimensions;
  assert(Array.isArray(rows), 'DIMENSIONS_ARRAY_REQUIRED');
  const results = dimensions.map(d=>{
    const p = one(rows,'dimension',d), ws = grounded(packet,p);
    let code = null;
    if (![0,1,2,'U'].includes(p?.level) || !target(ws)) code='DIMENSION_TARGET_GROUNDING_MISSING';
    if (!['none','content','exposure','self_disclosure','grading','uncertain'].includes(p?.issue)) code='DIMENSION_ISSUE_UNESTABLISHED';
    if (p?.issue==='exposure' && (!has(ws,'prior_exposure') || !has(ws,'question'))) code='PRIOR_EXPOSURE_UNESTABLISHED';
    if(p?.issue==='exposure') {
      const ev=p.exposureEvidence;
      const verified=Array.isArray(ev) && ev.some(x=>{
        const index=x?.taskId==='current'?-1:view?.tasks?.findIndex(t=>t.id===x?.taskId);
        const task=x?.taskId==='current'?view:view?.tasks?.[index];
        const prefix=x?.taskId==='current'?'/priorExposure/':`/tasks/${index}/priorExposure/`;
        const f=packet.facts.find(f=>f.id===x?.ref);
        const q=task?.question, questionText=q?[q.prompt,...q.options.map(o=>o.text)]:[];
        return task && ['solution','worked_reasoning'].includes(x.kind) && typeof x.quote==='string' && x.quote.trim()
          && f?.kind==='text' && f.pointer.startsWith(prefix) && f.value.includes(x.quote)
          && ws?.some(w=>w.id===f.id) && !questionText.some(s=>s.includes(x.quote));
      });
      if(!verified)code='EXPOSED_SOLUTION_NOT_ESTABLISHED';
    }
    if (code) return { dimension:d,level:'U',reason:'The proposed judgment needs evidence review.',...uncertain(p,code) };
    return { ...p, witnesses:ws, reviewReasons:[] };
  });
  const c = raw?.credit, cw = grounded(packet,c);
  const credit = ['granted','withheld','uncertain'].includes(c?.outcome) && cw?.some(w=>w.pointer==='/productJudgment/consequence')
    ? { ...c, witnesses:cw, reviewReasons:[] }
    : { outcome:'uncertain',reason:'Observed credit consequence could not be established.',...uncertain(c,'CREDIT_CONSEQUENCE_UNESTABLISHED') };
  return { dimensions:results, ...(dimensions.includes('Q5') ? {credit,
    studentCheck:view?validateCriteria(packet,view,solution,raw?.studentCheck || {}):null} : {}) };
}
export function validateCorrectness(packet, dimensions, tasks, raw, solutions=[]) {
  assert(raw && typeof raw==='object', 'CORRECTNESS_OBJECT_REQUIRED');
  const fallback = dimensions.filter(d=>d!=='Q5');
  const checks = ['conditions','quantities'].map(kind=>{
    const p = one(raw.checks,'kind',kind), ws = grounded(packet,p);
    // No evidence contract for a non-applicable check. The full immutable packet
    // remains its review context; this statement does not certify a calculation.
    if(p?.status==='not_applicable' && reason(p))return {kind,status:'not_applicable',affected:[],reason:p.reason,
      contextHash:packet.hash,proposed:p,reviewReasons:[]};
    if (!['clear','defect','uncertain','not_applicable'].includes(p?.status) || !target(ws)
      || !Array.isArray(p.affected) || p.affected.some(d=>!dimensions.includes(d))
      || (['defect','uncertain'].includes(p.status) && !p.affected.length)) {
      return { kind,status:'uncertain',affected:fallback,reason:'Correctness check cannot be grounded.',...uncertain(p,'CORRECTNESS_EVIDENCE_OR_SCOPE_MISSING') };
    }
    if(kind==='conditions') {
      const c=p.challenge,cw=grounded(packet,c);
      if(!['counterexample','closed','uncertain','not_applicable'].includes(c?.status) || !target(cw))
        return {kind,status:'uncertain',affected:fallback,reason:'The counterexample check is not established.',...uncertain(p,'CONDITIONS_CHALLENGE_UNGROUNDED')};
      if(['counterexample','uncertain'].includes(c.status) && p.status!=='defect')return {...p,status:'uncertain',affected:p.affected.length?p.affected:fallback,
        reason:'The authored conclusion has a compatible counterexample or an unresolved necessary premise. '+c.reason,witnesses:ws,
        proposed:p,reviewReasons:['CONDITIONS_COUNTEREXAMPLE_REVIEW']};
    }
    return { ...p, witnesses:ws,reviewReasons:[] };
  });
  const keys = tasks.map(t=>{
    const p=one(raw.keys,'taskId',t.id),ws=grounded(packet,p);
    const qp = t.id==='current' ? '/question/' : `/tasks/${tasks.filter(x=>x.id!=='current').findIndex(x=>x.id===t.id)}/question/`;
    if (!['absent','agrees','conflicts','uncertain'].includes(p?.status) || !target(ws)
      || (p.status==='absent' && !ws.some(w=>w.pointer==='/artifacts' || w.pointer.startsWith('/artifacts/')))
      || (p.status!=='absent' && (!has(ws,'artifact') || !ws.some(w=>w.pointer.startsWith(qp))))) {
      return {taskId:t.id,status:'uncertain',reason:'Current-key correspondence is unestablished.',...uncertain(p,'CURRENT_KEY_BINDING_MISSING')};
    }
    if(['agrees','conflicts'].includes(p.status) && solutions.find(s=>s.taskId===t.id)?.status!=='resolved')
      return {taskId:t.id,status:'uncertain',reason:'The blind solution is unresolved; a retrospective key comparison cannot certify agreement or conflict.',...uncertain(p,'CURRENT_KEY_SOLUTION_UNRESOLVED')};
    return {...p,witnesses:ws,reviewReasons:[]};
  });
  return {checks,keys};
}

export function mixedRateReview(packet) {
  // Explicit, narrow semi-automatic boundary. Co-occurring rate scales need
  // human verification; model agreement and normalized tokens do not bind units.
  // This detects a class of inputs, never a case, phrase, expected value or label.
  return packet.facts.filter(f=>['artifact','product'].includes(f.role) && f.kind==='text').flatMap(f=>{
    const rates=packet.rates.filter(r=>r.ref===f.id),scales=new Set(rates.map(r=>r.literal.includes('‰')?'per_mille':'percent'));
    return scales.size>1?[{code:'MIXED_RATE_SCALES_REQUIRE_REVIEW',reason:'The authored field combines percent and per-mille values. Automatic model agreement does not establish the original-input conversion. Review the stated rate, convert it once to a dimensionless value, and recompute the result before certifying correctness.',
      witnesses:witnesses(packet,[f.id]),rates}]:[];
  });
}

export function aggregate(dimensions, view, audit, correctness, solutions, criteria, rateReviews=[]) {
  const result = {status:'VALID',dimensions:audit.dimensions.map(d=>({...d,constraints:[]})),
    ...(criteria ? {studentAssessment:criteria} : {}),reviewRequired:[]};
  const constrain = (d,level,code,detail) => {
    const row=result.dimensions.find(x=>x.dimension===d); if(!row)return;
    row.constraints.push({level,code,detail});
  };
  const grading=result.dimensions.find(d=>d.dimension==='Q5');
  if(grading?.level===0 && criteria?.sufficiency==='uncertain') {
    grading.proposed={level:grading.level,reason:grading.reason};
    grading.level='U';grading.reason='The material grading accusation needs independent semantic agreement.';
  }
  // These checks concern authored truth. When Q1 is requested, a model cannot
  // leave it confidently high by assigning the truth problem only to Q3/Q4.
  for(const c of correctness?.checks || []) if(['defect','uncertain'].includes(c.status)) for(const d of new Set([...c.affected,...(dimensions.includes('Q1')?['Q1']:[])])) {
    constrain(d,c.status==='defect'?0:'U','INDEPENDENT_'+c.kind.toUpperCase(),c);
  }
  for(const c of correctness?.checks || [])if(c.status==='defect' && dimensions.includes('Q1') && dimensions.includes('Q3') && !c.affected.includes('Q3')) {
    constrain('Q3','U','EXPLANATION_IMPACT_REVIEW',{...c,reason:'A material authored rule/calculation is contradicted; its effect on this explanation needs review. '+c.reason});
  }
  for(const review of rateReviews)for(const d of dimensions)constrain(d,'U',review.code,review);
  // A current authored answer is also an authored truth claim. Its uncertainty
  // cannot be confined to assessment quality while correctness certifies it.
  for(const k of correctness?.keys || []) if(['conflicts','uncertain'].includes(k.status)) for(const d of ['Q1','Q4'])
    constrain(d,k.status==='conflicts'?0:'U','CURRENT_KEY',k);
  if(dimensions.includes('Q4')) {
    if(!solutions.length)constrain('Q4','U','TASK_NOT_PROVIDED',null);
    for(const s of solutions) if(s.status!=='resolved')constrain('Q4','U','BLIND_SOLUTION_UNCERTAIN',s);
  }
  if(dimensions.includes('Q5')) {
    if(!criteria || !view.productJudgment)constrain('Q5','U','GRADING_CONTEXT_MISSING',null);
    else {
      const product=view.productJudgment.criteria;
      for(const c of criteria.criteria.filter(c=>c.required)) {
        const actual=one(product,'id',c.id);
        if(criteria.taskValidity!=='valid' || criteria.rubricValidity!=='valid' || c.result==='uncertain' || !actual || !['met','partial','not_met'].includes(actual.result))constrain('Q5','U','REQUIRED_CRITERION_UNCERTAIN',{independent:c,product:actual});
        else if((c.result==='met') !== (actual.result==='met'))constrain('Q5',0,'REQUIRED_CRITERION_CONTRADICTION',{independent:c,product:actual});
        else if(c.result!==actual.result)constrain('Q5',1,'PARTIAL_CRITERION_DIFFERENCE',{independent:c,product:actual});
      }
      if(criteria.sufficiency==='uncertain' || audit.credit.outcome==='uncertain')constrain('Q5','U','CREDIT_CORRECTNESS_UNCERTAIN',{sufficiency:criteria.sufficiency,credit:audit.credit});
      else if((criteria.sufficiency==='sufficient') !== (audit.credit.outcome==='granted'))constrain('Q5',0,'CREDIT_CONTRADICTION',{sufficiency:criteria.sufficiency,credit:audit.credit});
    }
  }
  for(const row of result.dimensions) {
    const proposed=row.level, all=[proposed,...row.constraints.map(c=>c.level)];
    row.proposedLevel=proposed;row.proposedReason=row.reason;
    row.level=all.includes(0)?0:all.includes('U')?'U':all.includes(1)?1:2;
    const deciding=row.constraints.find(c=>c.level===row.level);
    if(deciding){row.reason=deciding.detail?.reason || deciding.code;row.decidingConstraint=deciding.code;}
    if(row.level==='U' || row.constraints.some(c=>c.level==='U') || row.reviewReasons.length)result.reviewRequired.push({dimension:row.dimension,reason:row.level==='U'?'UNRESOLVED':'RESOLVED_DEFECT_WITH_OTHER_UNCERTAINTY'});
  }
  return result;
}

// Only stage findings, not an inventory of claims or sentences. Evidence IDs in
// earlier packets are deliberately omitted: the final check cites its own packet.
const compact = x => Array.isArray(x) ? x.map(compact) : x && typeof x==='object'
  ? Object.fromEntries(Object.entries(x).filter(([k])=>!['witnesses','validityWitnesses','independentWitnesses','refs'].includes(k)).map(([k,v])=>[k,compact(v)])) : x;
const targetFields = ws => (ws || []).filter(w=>['artifact','question','product'].includes(w.role)).map(w=>({pointer:w.pointer,kind:w.kind,valueHash:w.valueHash}));
const sharesField = (a,b) => a.pointer===b.pointer || (a.kind==='text'&&b.kind==='text'&&a.valueHash!==undefined&&a.valueHash===b.valueHash);

export function certificationPlan(result, audit, correctness, solutions, criteria, packet=null) {
  const candidate=result.dimensions.filter(d=>[1,2].includes(d.level)).map(d=>({dimension:d.dimension,level:d.level,reason:d.reason,supportFields:targetFields(d.witnesses)}));
  const issues=[];
  const fields=row=>targetFields(row.witnesses || (packet?witnesses(packet,row.proposed?.refs):null));
  for(const c of correctness?.checks || [])if(['defect','uncertain'].includes(c.status))issues.push({issueId:'check:'+c.kind,...compact(c),scopeFields:fields(c)});
  for(const k of correctness?.keys || [])if(['conflicts','uncertain'].includes(k.status))issues.push({issueId:'key:'+k.taskId,...compact(k),scopeFields:fields(k)});
  for(const s of solutions)if(s.status!=='resolved'){
    const index=packet?.facts.find(f=>f.pointer.match(/^\/tasks\/\d+\/id$/)&&f.value===s.taskId)?.pointer.split('/')[2];
    const prefix=s.taskId==='current'?'/question/':index===undefined?null:`/tasks/${index}/question/`;
    const ws=prefix?packet?.facts.filter(f=>f.pointer.startsWith(prefix)).map(f=>({...f,valueHash:sha(f.value)})):[];
    issues.push({issueId:'solve:'+s.taskId,...compact(s),scopeFields:targetFields(ws)});
  }
  for(const d of audit.dimensions)if([0,'U'].includes(d.level))issues.push({issueId:'audit:'+d.dimension,...compact(d),scopeFields:fields(d)});
  return {candidate,issues,findings:compact({audit,correctness,blindSolutions:solutions,...(criteria?{studentAssessment:criteria}:{})})};
}

export function validateCertification(packet, plan, raw) {
  assert(raw && Array.isArray(raw.certifications),'CERTIFICATIONS_ARRAY_REQUIRED');
  return {certifications:plan.candidate.map(c=>{
    const p=one(raw.certifications,'dimension',c.dimension),ws=grounded(packet,p);
    const dependencies=plan.issues.map(issue=>{
      const d=one(p?.dependencies,'issueId',issue.issueId),dw=grounded(packet,d);
      if(!['independent','depends','uncertain'].includes(d?.relation)||!target(dw))
        return {issueId:issue.issueId,relation:'uncertain',reason:'The dependency disposition is missing or ungrounded.',...uncertain(d,'CERTIFICATION_DEPENDENCY_UNESTABLISHED')};
      // Whole-field evidence is the unit of certification. A later model cannot
      // erase an earlier judgment's cited support or declare that same disputed
      // content independent merely by changing the dimension or its rationale.
      const support=[...(c.supportFields || []),...targetFields(ws)];
      if(d.relation==='independent' && (!issue.scopeFields?.length || !support.length
        || support.some(a=>issue.scopeFields.some(b=>sharesField(a,b)))))
        return {issueId:issue.issueId,relation:'uncertain',reason:'The certification cites disputed content, or its separation from that content is unestablished.',
          ...uncertain(d,'DISPUTED_SUPPORT_NOT_SEPARATE')};
      return {...d,witnesses:dw,reviewReasons:[]};
    });
    const valid=['supported','uncertain'].includes(p?.status)&&target(ws)&&Array.isArray(p.dependencies)
      && p.dependencies.length===plan.issues.length && p.dependencies.every(d=>plan.issues.some(i=>i.issueId===d.issueId));
    const supported=valid&&p.status==='supported'&&dependencies.every(d=>d.relation==='independent');
    return {dimension:c.dimension,status:supported?'supported':'uncertain',
      reason:!valid?'Final certification or dependency coverage is unestablished.':!supported&&p.status==='supported'
        ?'The positive judgment depends on an unresolved or disputed finding.':p.reason,
      dependencies,witnesses:ws,...(!supported?uncertain(p,'CERTIFICATION_DEPENDENCY_REVIEW'):{reviewReasons:[]})};
  })};
}

export function applyCertification(result, closure) {
  const closed=structuredClone(result);closed.certification=closure;
  for(const c of closure.certifications)if(c.status!=='supported'){
    const row=closed.dimensions.find(d=>d.dimension===c.dimension);
    if(!row||![1,2].includes(row.level))continue;
    row.constraints.push({level:'U',code:'CERTIFICATION_DEPENDENCY_REVIEW',detail:c});
    row.level='U';row.reason=c.reason;row.decidingConstraint='CERTIFICATION_DEPENDENCY_REVIEW';
    if(!closed.reviewRequired.some(d=>d.dimension===row.dimension))closed.reviewRequired.push({dimension:row.dimension,reason:'UNRESOLVED'});
  }
  return closed;
}
