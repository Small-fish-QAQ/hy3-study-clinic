# DOGFOOD-03.1: Duration Product Simplification

**Status:** CORRECTED — PENDING OWNER REAL RETRY / HUMAN VERIFICATION

**Date:** 2026-09-03

**Start HEAD:** `417f6c6aa479c531578d41d3b600224b954a3094`

**REAL_HY3:** 0

## Final Product Rule

Course creation asks for materials, learning goal, and depth. Duration is
system-derived advisory output. Course completion deadline is removed from the
competition product.

## Correction

- Every provider proposal, learner-edit successor, and deterministic replan now
  derives each `teach_unit.estimatedMinutes` before its StudyPlan identity/version is
  persisted.
- Derivation scans the complete supported domain from 1 through 480 and chooses the
  first duration the existing Lesson planning core reports as exactly feasible. It
  makes no monotonicity assumption and copies no planner arithmetic.
- Legacy provider/request minutes remain schema-compatible but are neither authority
  nor a lower bound. StudyPlan provider context receives neutral time fields.
- A structurally infeasible item fails closed before proposal persistence.
- Acceptance retains the same structural and exact-duration feasibility gates, but it
  discards the derivation result and never rewrites proposed items. Route activation
  can no longer receive replacement Plan items.
- Course setup sends no learner deadline or study-budget fields. Request schemas fill
  neutral stored values while continuing to parse historical fields.
- The normal UI removes Course deadline, daily/weekly/session-minute, and per-item
  minute-edit controls. It shows total and per-teaching-unit time as system estimates
  and no longer labels Contract schedule feasibility as Lesson feasibility.
- Selected depth is preserved exactly. Existing depth-required Lesson quality
  contracts are unchanged.
- FSRS, Review scheduling, due-review items, and internal review due dates are
  unchanged.

## Regression Evidence

1. A working-fluency three-objective proposal carrying the obsolete 15-minute value is
   persisted at the planner-derived 33 minutes, replayed with the same identity, and
   accepted without item changes.
2. A legacy 120-minute `resize_time` edit remains parseable but persists the same
   planner-derived 33-minute estimate.
3. Four working-fluency `explain` objectives fail as structurally infeasible without a
   StudyPlan row.
4. A test-only historical proposed Plan carrying stale 15-minute data remains readable;
   acceptance refuses it and leaves it byte-for-byte uncorrected.
5. Course creation works without minute/deadline fields, and the web request contains
   neither field.
6. Focused FSRS and Review scheduler tests pass without source changes.

## Verification

- Baseline at start HEAD: shared 272/272; server 1,822/1,823 with the adjacent replan
  plannability regression failing; web 447/447. Build and diff check passed. Lint had no
  errors but the prior DOGFOOD-03 files failed formatting.
- Focused correction gate: shared 10/10; server 145/145; web 89/89.
- Adjacent continuation and Lesson-order regressions: PASS.
- Full `npm test`: PASS — shared 273/273, server 1,825/1,825, web 447/447
  (2,545 total).
- `npm run build`: PASS.
- `npm run lint`: PASS with the same three pre-existing React warnings and no errors.
- `git diff --check`: PASS.

## Compatibility and Scope

No migration and no dependency were added. Existing persisted Contracts and
StudyPlans retain their historical fields and remain readable. No previously accepted
Plan is rewritten. Formal authority, Course Map, Curriculum objective identity,
Concepts, Repair, Mastery, Fast Learn, concurrency, and FSRS scheduling were not
changed.
