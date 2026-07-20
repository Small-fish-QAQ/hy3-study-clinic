export const SHARED_PACKAGE_NAME = '@hy3-clinic/shared';

export { clamp01, fnv1a32, roundTo } from './utils.js';
export {
  INITIAL_MASTERY,
  MASTERY_ALPHA,
  WEAK_MASTERY_THRESHOLD,
  updateMastery,
} from './mastery.js';

export * from './domain/material.js';
export * from './domain/workspace.js';
export * from './domain/graph.js';
export * from './domain/plan.js';
export * from './domain/quiz.js';
export * from './domain/grading.js';
export * from './domain/mistake.js';
export * from './domain/alignment.js';
export * from './domain/blueprint.js';
export * from './domain/misconception.js';
export * from './domain/review.js';
export * from './domain/tutor.js';
export * from './domain/errors.js';
export * from './provider/payloads.js';

export { SAMPLE_MATERIAL_CONTENT, SAMPLE_MATERIAL_TITLE } from './sampleMaterial.js';
