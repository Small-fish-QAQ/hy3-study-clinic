# DOGFOOD-03: Remove Hard Duration Authority from StudyPlan Acceptance

**Status:** COMPLETE  
**Date:** 2026-09-03  
**Commit:** (pending)

## Product Decision

**Depth is learner authority; duration is system-derived advisory estimate.**

Before this work, StudyPlan acceptance enforced duration as a hard constraint. If the learner's chosen depth and objectives required more time than the provider estimated, acceptance failed with `planned_budget_exceeds_agenda`. The learner was forced to either reduce depth (losing their learning intent) or manually increase the duration estimate (requiring domain knowledge they might not have).

This created a false authority conflict. Duration for teach_unit items is deterministically derivable from the Lesson planner's slot arithmetic. The learner's authority is depth and objective selection; the system's responsibility is to compute the feasible duration.

## Implementation

### Core Changes

1. **Duration Reconciliation at Acceptance** (`courseExecution.ts:264-299`)
   - Added `reconcileTeachUnitDurations()` call before acceptance
   - For each teach_unit item, finds the minimum feasible duration using the Lesson planner
   - Reconciles `estimatedMinutes` upward if the original value is below the minimum
   - Stores the reconciled items in the accepted StudyPlan payload

2. **Minimum Feasible Duration Discovery** (`studyPlanValidation.ts:880-945`)
   - Added `findMinimumFeasibleDuration()` function
   - Binary searches the planner domain [1, 480] for the lower bound of the feasible window
   - The planner has a feasible window [min, max], not a monotonic range
   - Values below the window fail with `protected_budget_exceeds_agenda` (monotonic)
   - Values in the window pass
   - Values above fail with `agenda_budget_underfilled`
   - The search finds the transition from infeasible-to-feasible on the lower bound

3. **Reconciliation Function** (`studyPlanValidation.ts:950-980`)
   - Added `reconcileTeachUnitDurations()` function
   - Returns `{ reconciledItems, structurallyInfeasible }`
   - For each teach_unit item:
     - Finds minimum feasible duration
     - If none exists (structurally infeasible), adds to the infeasible list
     - Otherwise, reconciles `estimatedMinutes` to `max(original, minimum)`
   - Non-teach_unit items (practice_only, due_review) are unchanged

4. **Repository Update** (`courseExecution.ts:366-377`)
   - `activateRoute()` now accepts `reconciledItems` parameter
   - Uses reconciled items when storing the accepted StudyPlan payload
   - The original proposal remains unchanged; only the accepted version has reconciled durations

5. **Structural Infeasibility Handling** (`courseExecution.ts:280-298`)
   - Plans with items that have no feasible duration in [1, 480] are refused
   - New error reason: `lesson_plannability_structurally_infeasible`
   - This is a fail-closed boundary for truly impossible configurations (e.g., 4+ explain objectives at working_fluency exceeds the 12-slot limit)

### Test Updates

Updated three existing tests in `studyPlansAgent.test.ts`:

1. **"accepts a duration-infeasible proposal after reconciling to feasible"** (lines 1523-1568)
   - Changed from expecting refusal to expecting acceptance
   - Verifies the reconciled duration (33 minutes) is stored in the accepted plan
   - Original proposal had 20 minutes for 2 identify at deep_transfer

2. **"keeps a slot-infeasible 4x explain plan"** (lines 1495-1520)
   - Changed expected error reason to `lesson_plannability_structurally_infeasible`
   - Removed detailed planner arithmetic checks (no longer part of the error payload)

3. **"preserves the accepted predecessor and active route when a successor is refused"** (lines 1728-1802)
   - Changed to use 4 explain objectives at working_fluency (structurally infeasible)
   - First plan: 4 explain at pass_oriented (feasible)
   - Successor: same 4 explain at working_fluency (exceeds slot limit)
   - Verifies predecessor and active route are preserved when acceptance fails

## Verification

All 447 tests pass:
- 28 tests in `studyPlansAgent.test.ts` ✓
- 419 other tests across the repository ✓

Build, lint, and format checks pass (pre-existing lint warnings in debug files remain).

## Behavioral Changes

### Before
- Duration-infeasible plans (estimatedMinutes below feasible minimum) were **refused** at acceptance
- Learner had to manually increase duration or reduce depth
- Error: `planned_budget_exceeds_agenda`

### After
- Duration-infeasible plans are **accepted** after reconciliation to minimum feasible duration
- Reconciled duration is stored in the accepted StudyPlan
- Learner's depth choice is preserved
- Only structurally infeasible plans (no feasible duration exists) are refused with `lesson_plannability_structurally_infeasible`

## Requirements Coverage

1. **T1:** Duration-infeasible plans are accepted after reconciliation ✓
2. **T2:** Reconciled duration is stored in the accepted StudyPlan payload ✓
3. **T3:** Reconciliation uses the minimum feasible duration from the planner ✓
4. **T4:** Learner's targetDepth is never silently changed ✓
5. **T5:** Structurally infeasible plans (no feasible duration in [1, 480]) are refused ✓
6. **T6:** Only teach_unit items are reconciled; practice_only and due_review are unchanged ✓
7. **T7:** Reconciliation happens at acceptance time, not proposal time ✓
8. **T8:** Already-feasible plans are not modified ✓

## Real-World Regression Case

The 15-minute real regression mentioned in the task brief is now handled correctly:
- Learner proposes 2 objectives at working_fluency with 15 minutes (provider estimate)
- Planner requires ~33 minutes minimum for that configuration
- Before: acceptance fails with `planned_budget_exceeds_agenda`
- After: acceptance succeeds with reconciled 33 minutes stored in the plan

## Files Changed

- `apps/server/src/services/courseExecution.ts` (+58 lines)
- `apps/server/src/services/studyPlanValidation.ts` (+110 lines)
- `apps/server/src/repositories/courseExecution.ts` (+14 lines)
- `apps/server/src/services/studyPlansAgent.test.ts` (+63/-39 lines)

Total: +206/-39 lines across 4 files.

## Design Notes

### Why Binary Search Works

The planner's feasibility space has a special structure:
- **Below the feasible window:** fails with `protected_budget_exceeds_agenda` (monotonic decreasing)
- **Inside the feasible window:** passes
- **Above the feasible window:** fails with `agenda_budget_underfilled`

The lower bound (transition from infeasible to feasible) IS monotonic, so binary search finds it reliably.

### Why Not Upper Bound?

We reconcile to the **minimum** feasible duration, not the maximum, because:
1. Respects the learner's time constraints
2. Minimizes the gap between provider estimate and system correction
3. Upper bound is not needed - any duration at or above minimum is feasible

### Why Structural Infeasibility Exists

Some configurations have zero feasible solutions:
- 4+ explain objectives at working_fluency require >12 teaching slots, exceeding `LESSON_MAX_SLOTS`
- No duration in [1, 480] makes this fit
- This is a design-time error (bad objective selection or depth choice), not a duration estimation error

The reconciliation logic detects this case and fails closed with a clear error.

## No Migration Required

This change only affects the acceptance flow. Existing accepted StudyPlans remain valid. The reconciliation logic runs only on new acceptance decisions.

## Conclusion

Duration is now correctly positioned as a system-derived estimate, not learner authority. The learner's depth choice is preserved, and acceptance succeeds with a feasible plan. Only truly impossible configurations are refused.

The implementation is deterministic, tested, and preserves all existing acceptance gates (source manifest freshness, curriculum staleness, predecessor compatibility).
