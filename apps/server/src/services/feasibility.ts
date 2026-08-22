import type { LearningContract, LearningContractFeasibility } from '@hy3-clinic/shared';

const DAY_MS = 24 * 60 * 60 * 1000;
const POLICY_VERSION = 'contract-feasibility-v1';

/** Missing policy is the compatibility interpretation for historical records. */
export function isHardAvailability(contract: LearningContract): boolean {
  return contract.studyBudget.availabilityPolicy !== 'estimate';
}

export function isHardDeadline(contract: LearningContract): boolean {
  return contract.deadline?.hard === true;
}

function availableMinutesPerDay(contract: LearningContract): number | null {
  const daily = contract.studyBudget.minutesPerDay;
  const weekly = contract.studyBudget.minutesPerWeek;
  if (daily === null && weekly === null) return null;
  if (daily === null) return weekly! / 7;
  if (weekly === null) return daily;
  return Math.min(daily, weekly / 7);
}

function unavailableFraction(
  startsAt: string,
  endsAt: string,
  horizonStart: number,
  horizonEnd: number,
): number {
  const overlapStart = Math.max(Date.parse(startsAt), horizonStart);
  const overlapEnd = Math.min(Date.parse(endsAt), horizonEnd);
  return Math.max(0, overlapEnd - overlapStart) / DAY_MS;
}

/**
 * Deterministic time arithmetic for a learner-owned Contract. The model may
 * estimate work elsewhere, but it never computes deadline capacity or slack.
 */
export function computeContractFeasibility(
  contract: LearningContract,
  projectedMinutes: number | null,
  now: Date,
): LearningContractFeasibility {
  const computedAt = now.toISOString();
  if (!contract.deadline) {
    return {
      state: 'unknown',
      deadlineAt: null,
      availableMinutes: null,
      projectedMinutes,
      slackMinutes: null,
      reasonCodes: ['deadline_absent'],
      assumptions: ['No deadline is configured, so bounded remaining capacity is unknown.'],
      policyVersion: POLICY_VERSION,
      computedAt,
    };
  }

  const deadlineAt = contract.deadline.at;
  const deadlineMs = Date.parse(deadlineAt);
  const nowMs = now.getTime();
  if (deadlineMs <= nowMs) {
    const elapsedIsHard = isHardAvailability(contract) || isHardDeadline(contract);
    return {
      state: projectedMinutes === 0 ? 'at_risk' : elapsedIsHard ? 'infeasible' : 'at_risk',
      deadlineAt,
      availableMinutes: 0,
      projectedMinutes,
      slackMinutes: projectedMinutes === null ? null : -projectedMinutes,
      reasonCodes: ['deadline_elapsed'],
      assumptions: ['The accepted deadline has elapsed.'],
      policyVersion: POLICY_VERSION,
      computedAt,
    };
  }

  const perDay = availableMinutesPerDay(contract);
  if (perDay === null) {
    return {
      state: 'unknown',
      deadlineAt,
      availableMinutes: null,
      projectedMinutes,
      slackMinutes: null,
      reasonCodes: ['budget_unknown'],
      assumptions: ['Available study minutes are not known.'],
      policyVersion: POLICY_VERSION,
      computedAt,
    };
  }

  const horizonDays = (deadlineMs - nowMs) / DAY_MS;
  const unavailableDays = Math.min(
    horizonDays,
    contract.studyBudget.unavailablePeriods.reduce(
      (sum, period) => sum + unavailableFraction(period.startsAt, period.endsAt, nowMs, deadlineMs),
      0,
    ),
  );
  const availableMinutes = Math.max(0, Math.floor((horizonDays - unavailableDays) * perDay));
  const assumptions = [
    'Capacity is prorated uniformly across the time remaining before the deadline.',
    'When daily and weekly values are both present, the stricter average is shown for planning.',
    isHardAvailability(contract)
      ? 'The learner marked availability as a hard cap.'
      : 'Daily and weekly values are estimates/preferences, not an automatic scope cap.',
  ];
  const reasonCodes: LearningContractFeasibility['reasonCodes'] = [];
  if (unavailableDays > 0) {
    reasonCodes.push('unavailable_periods_reduce_capacity');
  }
  if (projectedMinutes === null) {
    reasonCodes.push('effort_unknown');
    return {
      state: 'unknown',
      deadlineAt,
      availableMinutes,
      projectedMinutes: null,
      slackMinutes: null,
      reasonCodes,
      assumptions,
      policyVersion: POLICY_VERSION,
      computedAt,
    };
  }

  const slackMinutes = availableMinutes - projectedMinutes;
  const lowSlackThreshold = Math.max(
    contract.studyBudget.preferredSessionMinutes ?? 0,
    Math.ceil(projectedMinutes * 0.1),
  );
  if (slackMinutes < 0) reasonCodes.push('insufficient_time');
  else if (slackMinutes < lowSlackThreshold) reasonCodes.push('low_slack');
  else reasonCodes.push('sufficient_slack');
  reasonCodes.push(
    isHardAvailability(contract) ? 'hard_availability_cap' : 'soft_availability_estimate',
  );

  const deficitIsHard = isHardAvailability(contract) || isHardDeadline(contract);

  return {
    state:
      slackMinutes < 0
        ? deficitIsHard
          ? 'infeasible'
          : 'at_risk'
        : slackMinutes < lowSlackThreshold
          ? 'at_risk'
          : 'feasible',
    deadlineAt,
    availableMinutes,
    projectedMinutes,
    slackMinutes,
    reasonCodes,
    assumptions,
    policyVersion: POLICY_VERSION,
    computedAt,
  };
}
