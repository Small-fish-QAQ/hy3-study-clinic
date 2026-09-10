import { z } from 'zod';
import { DurableMasteryEvaluationSchema } from './formalProgression.js';

export const CourseAssessmentRecordSchema = z.object({
  attemptId: z.string(),
  versionId: z.string(),
  title: z.string(),
  learningUnitId: z.string().nullable(),
  objectiveIds: z.array(z.string()),
  current: z.boolean(),
  status: z.enum(['started', 'submitted', 'cancelled']),
  result: z.enum(['pending', 'supported', 'partial', 'unsupported']),
  credited: z.boolean(),
  reconciliationPending: z.boolean(),
  reviewSchedulingPending: z.boolean().optional(),
  startedAt: z.string(),
  submittedAt: z.string().nullable(),
  feedback: z.string().nullable(),
  repairEpisodeId: z.string().nullable(),
  repairResolved: z.boolean().optional(),
  items: z.array(z.object({ prompt: z.string(), response: z.string() })),
  criteria: z.array(z.object({ label: z.string(), result: z.string() })),
});
export const CourseRepairRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(['formal', 'practice']),
  title: z.string(),
  learningUnitId: z.string(),
  status: z.string(),
  resolved: z.boolean(),
  current: z.boolean(),
  description: z.string(),
  updatedAt: z.string(),
  versionId: z.string().nullable(),
  sessionId: z.string().nullable(),
});
export const CourseLearningProgressSchema = z.object({
  workspaceId: z.string(),
  summary: z.object({
    teachingTotal: z.number(),
    teachingCompleted: z.number(),
    objectiveTotal: z.number(),
    supportedObjectives: z.number(),
    openRepairs: z.number(),
  }),
  units: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      teachingTotal: z.number(),
      teachingCompleted: z.number(),
      objectiveTotal: z.number(),
      supportedObjectives: z.number(),
      formalState: z.string(),
      scheduledCheckpoints: z.number(),
      scheduledTransfers: z.number().optional(),
      completedTransfers: z.number().optional(),
      durableMastery: DurableMasteryEvaluationSchema.nullable().optional(),
    }),
  ),
  assessments: z.array(CourseAssessmentRecordSchema),
  repairs: z.array(CourseRepairRecordSchema),
  lessons: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      completedAt: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
});
export type CourseLearningProgress = z.infer<typeof CourseLearningProgressSchema>;
export type CourseAssessmentRecord = z.infer<typeof CourseAssessmentRecordSchema>;
export type CourseRepairRecord = z.infer<typeof CourseRepairRecordSchema>;
