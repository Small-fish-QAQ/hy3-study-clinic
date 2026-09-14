import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import {ROOT} from './common.mjs';
import {PRODUCT} from '../product/runtime.mjs';
const root=ROOT;
const product=PRODUCT;
const name=process.argv[2],partial=process.argv.includes('--partial');
if(!/^[a-z0-9-]+$/.test(name||''))throw Error('Run name required');
const runRoot=path.join(root,'runs',name),out=path.join(root,'analysis',name);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const write=(p,x)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');};
const jsonl=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):[];
const sha=x=>crypto.createHash('sha256').update(Buffer.isBuffer(x)||typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const identity=read(path.join(runRoot,'identity.json'));
if(!partial&&!fs.existsSync(path.join(runRoot,'complete.json')))throw Error('Wait for the complete fixed-denominator run');
const {currentScoringReview,scoringFingerprint}=await import(pathToFileURL(path.join(product,'apps/server/dist/services/formalScoringReview.js')));
const Database=createRequire(path.join(product,'package.json'))('better-sqlite3');
const errors=[],cold=[],bindings=[],replays=[],ordinary=[],controls=[],manual=[];
const supported=s=>s.rows.assessment_evidence_records.filter(e=>e.conclusion==='supported'&&s.rows.assessment_progression_reconciliations.some(r=>r.evidence_record_id===e.id&&r.status==='applied'));
const check=(ok,message)=>{if(!ok)errors.push(message);};
function auditSnapshot(id,snapshot){
 const filename=path.join(runRoot,'data',id+'.sqlite');const before=sha(fs.readFileSync(filename));
 const db=new Database(filename,{readonly:true,fileMustExist:true});
 try{const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);const changed=tables.filter(t=>sha(db.prepare('SELECT * FROM "'+t+'"').all())!==sha(snapshot.rows[t]));const integrity=db.pragma('integrity_check'),foreignKeys=db.pragma('foreign_key_check');const passed=!changed.length&&integrity[0]?.integrity_check==='ok'&&!foreignKeys.length;cold.push({id,passed,tables:tables.length,changed});check(passed,id+': cold persistence/integrity');}finally{db.close();}check(sha(fs.readFileSync(filename))===before,id+': read-only audit changed database');
 for(const e of snapshot.rows.assessment_evidence_records.filter(e=>e.conclusion==='supported')){
  const grade=JSON.parse(snapshot.rows.assessment_grade_records.find(g=>g.id===e.grade_record_id)?.payload||'null');const version=JSON.parse(snapshot.rows.assessment_versions.find(v=>v.id===e.assessment_version_id)?.payload||'null');const item=version?.items.find(q=>q.id===e.item_id),required=item?.rubric.filter(r=>r.required)||[];
  check(required.length>0&&required.every(c=>grade?.judgment.criterionResults.some(r=>r.criterionId===c.id&&r.result==='met')),id+': credited missing criterion');check(snapshot.rows.assessment_progression_reconciliations.some(r=>r.evidence_record_id===e.id&&r.status==='applied'),id+': credit not reconciled');
  const attempt=snapshot.rows.assessment_attempts.find(a=>a.id===e.attempt_id);manual.push({id,evidence:e,item,grade,attempt});
 }
 const blocks=snapshot.rows.source_blocks.map(b=>({id:b.id,content:b.content,materialRevisionId:b.material_revision_id,contentOrigin:b.content_origin}));
 for(const row of snapshot.rows.questions){const q=JSON.parse(row.payload);const cr=snapshot.rows.formal_question_contracts.find(c=>c.question_id===q.id);if(!cr)continue;const c=JSON.parse(cr.payload);const cv=snapshot.rows.curriculum_versions.find(v=>v.id===c.curriculumVersionId);const objective=cv?JSON.parse(cv.payload).nodes.flatMap(n=>n.learningUnit?.objectives||[]).find(o=>o.id===c.primaryObjectiveId):null;const review=currentScoringReview(q,objective,blocks);const passed=!!review&&c.premiseVisibilityVerdict==='satisfied'&&c.assessmentPremiseBindings.every(b=>b.supportMode==='reviewed_derivation'&&b.scoringReviewFingerprint===scoringFingerprint(review));bindings.push({id,questionId:q.id,passed,reviewVersion:review?.policyVersion});check(passed,id+': source/scoring/premise binding');}
}
const logical=jsonl(path.join(runRoot,'logical.jsonl')),physical=jsonl(path.join(runRoot,'physical.jsonl'));
const rows=identity.schedule.map(t=>{
 const id=t.sourceId,dir=path.join(runRoot,'cases',id),file=path.join(dir,'final.snapshot.json');
 if(!fs.existsSync(file))return {id,pending:true};
 const s=read(path.join(dir,'state.json')),snapshot=read(file);auditSnapshot(id,snapshot);
 for(const file of fs.readdirSync(dir).filter(p=>/^after-teaching-\d+\.snapshot\.json$/.test(p))){const passed=read(path.join(dir,file)).rows.assessment_evidence_records.length===0;ordinary.push({id,file,passed});check(passed,id+': informal credit');}
 for(const f of s.formal){if(f.result){const passed=f.replay?.identicalResult&&f.replay?.newPhysicalCalls===0&&!f.replay?.changedTables?.length;replays.push({id,passed:!!passed,...f.replay});check(passed,id+': replay');}}
 const branches=[];
 for(const f of s.formal){
  if(f.negative)branches.push({kind:'negative',branch:f.negative});
  if(f.responsive)branches.push({kind:'responsive',branch:f.responsive});
  for(const c of f.controls||[])branches.push({kind:c.name,branch:c});
 }
 let responsiveEvidence=false;
 for(const {kind,branch} of branches){const branchDir=path.join(runRoot,'cases',branch.caseId);const known=fs.existsSync(branchDir)?fs.readdirSync(branchDir).filter(p=>/^after-(?:control|negative|responsive)\.snapshot\.json$/.test(p)):[];if(!known.length){check(false,id+': missing '+kind+' snapshot');continue;}const snap=read(path.join(branchDir,known[0]));auditSnapshot(branch.caseId,snap);const credited=supported(snap).length;if(kind==='responsive')responsiveEvidence=credited>0;else controls.push({id,kind,caseId:branch.caseId,submitted:!!branch.result,credited});}
 const row={id,imported:snapshot.rows.material_revisions.length>0,prepared:!!snapshot.overview.acceptedStudyPlan,lessonReady:s.teaching.some(x=>x.preparationAttempts?.some(a=>a.status==='ready')),teachingComplete:s.teaching.some(x=>x.status==='completed'),allTeachingComplete:s.teaching.length>0&&s.teaching.every(x=>x.status==='completed'),formalAttempted:s.formal.length>0,candidateReturned:logical.some(x=>x.caseId===id&&x.operation==='proposeAssessment'&&x.event==='completed'),admitted:fs.readdirSync(dir).some(p=>/^formal-\d+-before\.json$/.test(p)),submitted:s.formal.some(f=>!!f.result),supportedEvidence:snapshot.rows.assessment_evidence_records.some(e=>e.conclusion==='supported'),durableCredit:supported(snapshot).length>0,responsiveEvidence,attemptedTeaching:s.teaching.length,completedTeaching:s.teaching.filter(t=>t.status==='completed').length,demonstrated:s.formal.some(f=>f.result?.result?.demonstrated),failure:s.events.find(e=>e.status==='failed')??s.formal.find(f=>f.error)?.error??s.teaching.find(t=>t.error)?.error??null};
 row.completeJourney=row.prepared&&row.allTeachingComplete&&row.demonstrated&&row.durableCredit;
 return row;
});
const starts=physical.filter(x=>x.event==='started'),ends=physical.filter(x=>['completed','failed'].includes(x.event)),received=ends.filter(x=>x.event==='completed');
if(!partial){for(const s of starts){check(ends.filter(e=>e.physicalId===s.physicalId).length===1,s.physicalId+': request terminal');check(sha(fs.readFileSync(path.join(runRoot,'raw',s.physicalId+'.request.json')))===s.requestSha256,s.physicalId+': request hash');}for(const e of received)check(sha(fs.readFileSync(path.join(runRoot,'raw',e.physicalId+'.response.txt')))===e.responseSha256,e.physicalId+': response hash');}
const costs={requests:starts.length,received:received.length,unfinished:starts.length-ends.length,transportFailures:ends.filter(e=>e.event==='failed').length,httpErrors:received.filter(e=>e.status>=400).length,truncated:received.filter(e=>e.finishReason==='length').length,missingUsage:received.filter(e=>!e.usage).length,inputTokens:received.reduce((n,e)=>n+(e.usage?.prompt_tokens||0),0),outputTokens:received.reduce((n,e)=>n+(e.usage?.completion_tokens||0),0),totalTokens:received.reduce((n,e)=>n+(e.usage?.total_tokens||0),0)};
const stages=['imported','prepared','lessonReady','teachingComplete','allTeachingComplete','formalAttempted','candidateReturned','admitted','submitted','supportedEvidence','durableCredit','responsiveEvidence','completeJourney'];
const result={at:new Date().toISOString(),suite:identity.suite,partial,n:rows.length,completed:rows.filter(r=>!r.pending).length,funnel:Object.fromEntries(stages.map(k=>[k,rows.filter(r=>r[k]).length])),teaching:{attempted:rows.reduce((n,r)=>n+(r.attemptedTeaching||0),0),completed:rows.reduce((n,r)=>n+(r.completedTeaching||0),0)},controls,costs,rows};
write(path.join(out,'results.json'),result);write(path.join(out,'runtime-audit.json'),{at:new Date().toISOString(),partial,passed:!errors.length,errors,cold,bindings,replays,ordinary});write(path.join(out,'credited-answer-audit-input.json'),manual);
console.log(JSON.stringify({suite:identity.suite,completed:result.completed,n:result.n,funnel:result.funnel,costs,controls:{submitted:controls.filter(c=>c.submitted).length,credited:controls.filter(c=>c.credited).length},runtimeErrors:errors}));
