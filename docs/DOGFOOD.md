# Hy3 Study Clinic - Post-Phase-4 Human Dogfood Gate

Status: protocol only. No human result or gate decision has been recorded.

This gate evaluates whether the Learning Execution Agent's core scaffold is usable and removes enough learner orchestration to justify later investment. It does not prove learning effectiveness, delayed retention, exam coverage, or semantic completeness. Phase 5 and Phase 6 remain out of scope.

## Safe local setup

Use Node.js 20 or newer. Routine dogfood can use the deterministic Fake provider and consumes no Hy3 quota:

```bash
npm ci
npm run build
npm run dev
```

Use a disposable course workspace or a backed-up database when intentionally testing interruption and restart behavior. Keep the server terminal visible so operation failures are observable. A real provider may be used later for teaching-quality judgment, but it is not required for the execution-scaffold gate.

Before starting, choose one real document-supported study goal that can be attempted in 30-60 minutes. Record the intended outcome, available time, and the route you would otherwise have managed manually in a general chat.

## Core-loop protocol

1. Create or select a Course, then add and review source material through `主页 > 课程资料`. Assign stable material roles as part of the Course setup.
2. Draft and learner-confirm the Learning Contract. Check the deterministic time/deadline feasibility and its assumptions.
3. Generate and inspect the Curriculum. Confirm that its hierarchy references the existing course material and concepts rather than inventing a second concept set.
4. Generate and inspect the StudyPlan. Verify rationale, estimates, completion requirements, explicit deferrals, and the learner-visible diff before accepting it.
5. Accept the route and return to `主页`. Without reconstructing the plan manually, state what the dominant next action is and why it is next.
6. Open `学习` and start or resume the current StudySession. Ask at least three natural follow-ups, including a request for another explanation or example.
7. Detour to another topic, optionally create one nested detour, then return. Confirm the original route is restored or visibly revalidated.
8. Insert a short Agenda item or deep dive. Confirm this changes today's execution context without creating or silently rewriting an accepted StudyPlan version.
9. Launch a direct formal checkpoint where available. Confirm Tutor conversation remains visually informal and only the formal assessment can record progression evidence.
10. Produce both a passing and a failing formal result where practical. Observe evidence recorded, reconciliation, completion/continue/repair state, and verify that harder failure does not erase independently valid lower-level evidence.
11. Defer one item. Confirm it remains a visible gap/risk and is not shown as completed.
12. Trigger one meaningful replan using a supported deterministic trigger, such as a sustained time change, accepted scope change, synthesis/prerequisite failure, source-manifest change, or promotion of a detour. Inspect the predecessor/successor diff. Reject once and confirm the current route survives; then accept a valid successor and confirm atomic handoff.

## Recovery probes

Run at least three of these during the same course:

- navigate away during a Tutor response, then return; navigation alone must not mean Stop;
- explicitly Stop or cancel a turn and verify no fabricated Tutor result or formal evidence appears;
- pause and resume; the accepted StudyPlan must remain `accepted` with the same pointer/version;
- restart the server with a session available, then resume without reconstructing the route;
- submit the same consequential command twice and verify it does not double-apply;
- change source execution state, then resume and confirm stale context is blocked/recomposed rather than used silently;
- reject a Curriculum, StudyPlan, or replan candidate and confirm the prior valid active route remains usable.

Inspect formal progression, assessment history, mistakes, reviews, and route history through `进展`. Use `探索` only when graph relationships or source evidence help the learning task. Server-side SQLite records and operation events may be inspected read-only when diagnosing a failure; do not edit them to make a run appear successful.

## What to record

Record timestamps and concise notes for:

- every moment the learner had to reconstruct or manually remember the route;
- whether the next action and its reason were understandable;
- detour depth, return success, and any route drift;
- formal assessments launched, evidence/reconciliation state, and repair outcomes;
- Plan proposals accepted/rejected and the usefulness of their diffs;
- manual interventions needed to recover from cancellation, restart, stale state, or rejection;
- any dead learner-visible action;
- any Tutor prose or informal check that appeared to grant formal completion;
- any learner scope decision that appeared to create factual/rubric authority;
- every time the learner bypassed the scaffold for a general chat, and why;
- interaction friction that cost more effort than the orchestration it removed.

## Gate questions

- Can a learner start or resume without reconstructing the plan manually?
- Does the system make the next action understandable?
- Can the learner detour freely and reliably return?
- Does formal evidence remain distinct from Tutor conversation?
- Does Plan/Agenda separation feel useful rather than bureaucratic?
- Does meaningful replanning require less manual orchestration than ordinary chat?
- Are major failures, restarts, and rejections recoverable without route drift?
- Does the learner repeatedly bypass the scaffold and return to general chat?
- Is interaction friction acceptable relative to the orchestration removed?

## Gate outcome

After real observed human use, record one outcome in a separate dated dogfood report or issue:

- **GO to Phase 5**: the scaffold is usable, route recovery is reliable, and orchestration reduction justifies the added machinery;
- **GO WITH SIMPLIFICATION**: the core loop helps, but specific state, controls, or surfaces should be removed or collapsed before expansion;
- **STOP/NARROW**: the scaffold does not remove enough orchestration, is routinely bypassed, or creates unacceptable friction.

Do not mark the gate from automated tests alone. Same-model ablation, human evaluation, and delayed-retention work remain later evaluation tasks.
