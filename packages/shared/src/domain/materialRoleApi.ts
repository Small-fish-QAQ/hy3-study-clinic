import { z } from 'zod';
import { CourseExecutionCommandEnvelopeSchema } from './learningContract.js';
import { MaterialRoleAssignmentSchema, MaterialRoleSchema } from './material.js';

export const ProposeMaterialRoleRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    materialId: z.string().min(1),
    role: MaterialRoleSchema,
    expectedCurrentAssignmentId: z.string().min(1).nullable(),
  })
  .strict();
export type ProposeMaterialRoleRequest = z.infer<typeof ProposeMaterialRoleRequestSchema>;

export const ConfirmMaterialRoleRequestSchema = z
  .object({
    command: CourseExecutionCommandEnvelopeSchema,
    assignmentId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.command.actor !== 'learner') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command', 'actor'],
        message: 'only the learner may confirm a Material role',
      });
    }
  });
export type ConfirmMaterialRoleRequest = z.infer<typeof ConfirmMaterialRoleRequestSchema>;

/** Runtime response shared by Material-role proposal and confirmation commands. */
export const MaterialRoleAssignmentResponseSchema = z
  .object({ assignment: MaterialRoleAssignmentSchema })
  .strict();
export type MaterialRoleAssignmentResponse = z.infer<typeof MaterialRoleAssignmentResponseSchema>;

export const MaterialRoleHistoryResponseSchema = z
  .object({
    materialId: z.string().min(1),
    current: MaterialRoleAssignmentSchema,
    history: z.array(MaterialRoleAssignmentSchema).max(500),
  })
  .strict();
export type MaterialRoleHistoryResponse = z.infer<typeof MaterialRoleHistoryResponseSchema>;
