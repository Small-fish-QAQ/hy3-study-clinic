import { RUBRIC } from './rubric.mjs';
import { CONFIG,SOLVE,CRITERIA,AUDIT,CORRECTNESS,CONTEXT,CERTIFICATION } from './prompts.mjs';
import { project,compile,taskViews,contextView } from './packet.mjs';
import { validateSolve,validateCriteria,validateAudit,validateCorrectness,aggregate,mixedRateReview,validateContext,reconcileCriteria,certificationPlan,validateCertification,applyCertification } from './contracts.mjs';
import { assert,sha } from './util.mjs';

export async function evaluate(record,{tasks=[],stage}={}) {
  const dimensions=record.dimensions;
  assert(Array.isArray(dimensions) && dimensions.length && new Set(dimensions).size===dimensions.length && dimensions.every(d=>RUBRIC[d]),'INPUT_DIMENSIONS_INVALID');
  const stages={},packets={};
  const run=async(name,view,prompt,validator,extra={})=>{
    const packet=compile(view);packets[name]=packet.hash;
    const output=await stage(name,{packet,...extra},prompt,raw=>validator(packet,raw));
    stages[name]=output;return output;
  };
  const fail=output=>({version:CONFIG.version,packets,stages,result:output,resultHash:sha(output)});
  const tviews=taskViews(record,tasks),solutions=[];
  let prepared={contexts:[]};
  for(const t of tviews) {
    const cv=contextView([t]);
    if(!cv.tasks.length)continue;
    const context=await run('prepare-context-'+t.id,cv,CONTEXT,(packet,raw)=>validateContext(packet,cv,raw));
    if(context.status==='JUDGE_INVALID')return fail(context);
    prepared.contexts.push(...context.contexts);
  }
  const withContext=(t,stage)=>{
    const view=project(t.record,stage),c=prepared.contexts.find(c=>c.taskId===t.id);
    if(c)view.scenarioContext=c.premises.map(x=>({text:x.quote}));
    return view;
  };
  for(const t of tviews) {
    const context=prepared.contexts.find(c=>c.taskId===t.id);
    const solved=await run('solve-'+t.id,withContext(t,'solve'),SOLVE,(packet,raw)=>{
      const s=validateSolve(packet,raw);
      return context && context.status!=='ready'?{...s,status:'uncertain',proposed:s,reviewReasons:[...s.reviewReasons,'SCENARIO_CONTEXT_UNCERTAIN']}:s;
    });
    if(solved.status==='JUDGE_INVALID')return fail(solved);
    solutions.push({taskId:t.id,...solved});
  }
  let criteria=null;
  if(dimensions.includes('Q5') && record.evidence.rubric && record.evidence.answer!==undefined && record.evidence.question) {
    const view=withContext({id:'current',record},'criteria'), solution=solutions.find(s=>s.taskId==='current');
    criteria=await run('student-criteria',view,CRITERIA,(packet,raw)=>validateCriteria(packet,view,solution,raw),{blindSolution:solution});
    if(criteria.status==='JUDGE_INVALID')return fail(criteria);
  }
  const view=project(record,'audit',tasks);
  for(const c of prepared.contexts) {
    const target=c.taskId==='current'?view:view.tasks?.find(t=>t.id===c.taskId);
    if(target)target.scenarioContext=c.premises.map(x=>({text:x.quote}));
  }
  const rubric=Object.fromEntries(dimensions.map(d=>[d,RUBRIC[d]]));
  let correctness=null;
  if(dimensions.some(d=>d!=='Q5')) {
    const keyTasks=tviews;
    correctness=await run('correctness',view,CORRECTNESS,(packet,raw)=>validateCorrectness(packet,dimensions,keyTasks,raw,solutions),{
      dimensions, tasks:keyTasks.map(t=>({id:t.id})), blindSolutions:solutions});
    if(correctness.status==='JUDGE_INVALID')return fail(correctness);
  }
  // The artifact audit is independent of the correctness review's decisions.
  const audit=await run('artifact-audit',view,AUDIT,(packet,raw)=>validateAudit(packet,dimensions,raw,view,solutions.find(s=>s.taskId==='current')),
    {rubric,blindSolutions:solutions});
  if(audit.status==='JUDGE_INVALID')return fail(audit);
  if(criteria)criteria=reconcileCriteria(criteria,audit.studentCheck);
  let result=aggregate(dimensions,view,audit,correctness,solutions,criteria,mixedRateReview(compile(view)));
  const plan=certificationPlan(result,audit,correctness,solutions,criteria,compile(view));
  if(plan.candidate.length) {
    const closure=await run('certification',view,CERTIFICATION,(packet,raw)=>validateCertification(packet,plan,raw),
      {...plan,rubric});
    if(closure.status==='JUDGE_INVALID')return fail(closure);
    result=applyCertification(result,closure);
  }
  return {version:CONFIG.version,packets,stages,result,resultHash:sha(result)};
}
