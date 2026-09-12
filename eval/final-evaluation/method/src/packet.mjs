import { assert, escapePointer, sha } from './util.mjs';

const units = xs => (xs || []).map(x => ({ id: x.id, text: x.text }));
const question = q => ({ prompt: q.prompt, options: units(q.options) });
export function project(record, stage = 'audit', tasks = []) {
  const e = record.evidence;
  assert(e && Array.isArray(e.sources), 'INPUT_EVIDENCE_REQUIRED');
  const view = { sources: units(e.sources), goals: e.goals || [], prerequisites: e.prerequisites || [],
    desiredDepth: e.desiredDepth || 'not_specified', authorityBoundaries: e.authorityBoundaries || [] };
  if (e.question) view.question = question(e.question);
  if (stage !== 'solve') {
    if (e.rubric) view.rubric = e.rubric.map(r => ({ id: r.id, text: r.text, required: r.required === true }));
    if (e.answer !== undefined) view.answer = e.answer;
  }
  if (stage === 'audit') {
    view.artifacts = units(e.artifacts);
    // Top-level episode archives do not establish which text preceded a task.
    view[tasks.length ? 'episodeArchive' : 'priorExposure'] = units(e.exposure);
    if (e.productJudgment) view.productJudgment = {
      criteria: e.productJudgment.criteria.map(c => ({ id: c.id, result: c.result })),
      feedback: e.productJudgment.feedback || '', consequence: e.productJudgment.consequence
    };
    if (e.proposition) { view.proposition = e.proposition; view.candidates = units(e.candidates); }
    if (tasks.length) view.tasks = tasks.map((t,i) => {
      const shared=project(t.record,'solve');
      for(const k of ['sources','goals','prerequisites','desiredDepth','authorityBoundaries']) assert(sha(shared[k])===sha(view[k]),'TASK_CONTEXT_MISMATCH');
      return { id:'task'+(i+1),question:question(t.record.evidence.question),priorExposure:units(t.record.evidence.exposure) };
    });
  }
  return view;
}
export function roleOf(p) {
  if (p.startsWith('/sources')) return 'source';
  if (p.startsWith('/authorityBoundaries')) return 'boundary';
  if (p.startsWith('/goals')) return 'goal';
  if (p.startsWith('/prerequisites') || p.includes('/scenarioContext') || p === '/desiredDepth') return 'context';
  if (p === '/answer') return 'student';
  if (p.startsWith('/rubric')) return 'criterion';
  if (p.startsWith('/productJudgment')) return 'product';
  if (p.startsWith('/priorExposure') || p.includes('/priorExposure') || p.startsWith('/history')) return 'prior_exposure';
  if (p.startsWith('/episodeArchive')) return 'archive_not_prior';
  if (p.startsWith('/question') || p.includes('/question')) return 'question';
  return 'artifact';
}
// Whole text fields, not compulsory sentence ledgers. Exact text/structures stay local.
export function compile(view) {
  const facts = [];
  const add = (pointer, value, kind) => facts.push({ id: 'e' + (facts.length+1), pointer, role: roleOf(pointer), kind, value });
  const visit = (v,p) => {
    if (Array.isArray(v)) { add(p, v.length, 'array_length'); v.forEach((x,i)=>visit(x,p+'/'+i)); }
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k,x])=>visit(x,p+'/'+escapePointer(k)));
    else add(p,v,typeof v === 'string' ? 'text' : 'scalar');
  };
  visit(view,'');
  for (const k of ['question','rubric','answer','productJudgment']) if (!Object.hasOwn(view,k)) add('/'+k,null,'absent');
  const rates = [];
  for (const f of facts.filter(f=>f.kind==='text')) {
    for (const m of f.value.matchAll(/(?<![\w.])([+-]?\d+(?:\.\d+)?)\s*([%％‰])/gu)) {
      const [whole, fraction=''] = m[1].split('.');
      const denominator = 10n ** BigInt(fraction.length) * (m[2] === '‰' ? 1000n : 100n);
      const numerator = BigInt(whole + fraction);
      rates.push({ ref: f.id, literal: m[0], startUtf16: m.index, exactRatio: `${numerator}/${denominator}`, decimal: Number(numerator)/Number(denominator) });
    }
  }
  return { facts, rates, hash: sha({ facts, rates }) };
}
export function witnesses(packet, refs) {
  if (!Array.isArray(refs) || !refs.length || refs.length > 40) return null;
  const result = [...new Set(refs)].map(id=>packet.facts.find(f=>f.id===id));
  if (result.some(f=>!f)) return null;
  return result.map(f=>({ ...f, valueHash: sha(f.value) }));
}
export function taskViews(record, tasks) {
  return [...(record.evidence.question ? [{ id:'current', record }] : []), ...tasks.map((t,i)=>({id:'task'+(i+1),record:t.record}))];
}

// Context preparation sees only each task's actual prior surfaces and question.
// Author artifacts, grading, student responses and episode archives stay hidden.
export function contextView(tasks) {
  const history=[],index=new Map();
  return {history,tasks:tasks.filter(t=>t.record.evidence.exposure?.length).map(t=>({
    id:t.id,sources:units(t.record.evidence.sources),question:question(t.record.evidence.question),
    historyIds:t.record.evidence.exposure.map(x=>{
      if(!index.has(x.text)){const id='h'+(history.length+1);index.set(x.text,id);history.push({id,text:x.text});}
      return index.get(x.text);
    })
  }))};
}
