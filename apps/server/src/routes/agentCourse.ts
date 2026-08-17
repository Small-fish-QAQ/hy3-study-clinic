import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AcceptCurriculumRequestSchema,
  ApplyStudyPlanDraftEditRequestSchema,
  ConfirmMaterialRoleRequestSchema,
  CreateLearningContractDraftRequestSchema,
  DecideStudyPlanRequestSchema,
  LaunchCourseActionRequestSchema,
  MaterialRoleAssignmentResponseSchema,
  ProposeMaterialRoleRequestSchema,
  ProposeStudyPlanRequestSchema,
  RejectCurriculumRequestSchema,
  RunCoursePreparationRequestSchema,
  TransitionLearningContractRequestSchema,
  UpdateLearningContractDraftRequestSchema,
} from '@hy3-clinic/shared';
import type { Services } from '../services/index.js';
import { ProposeCurriculumCommandRequestSchema } from '../services/curriculum.js';
import { requestSignal } from '../util/requestSignal.js';

const WorkspaceParams = z.object({ id: z.string().min(1) });
const ContractParams = z.object({ id: z.string().min(1), contractId: z.string().min(1) });
const CurriculumParams = z.object({ id: z.string().min(1), curriculumId: z.string().min(1) });
const PlanParams = z.object({ id: z.string().min(1), planId: z.string().min(1) });
const RoleParams = z.object({ id: z.string().min(1), docId: z.string().min(1) });
const RoleConfirmParams = z.object({
  id: z.string().min(1),
  docId: z.string().min(1),
  assignmentId: z.string().min(1),
});
const AgendaItemParams = z.object({
  id: z.string().min(1),
  agendaId: z.string().min(1),
  itemId: z.string().min(1),
});

function assertWorkspace(body: { command: { workspaceId: string } }, workspaceId: string): void {
  if (body.command.workspaceId !== workspaceId) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['command', 'workspaceId'],
        message: 'command workspace does not match route workspace',
      },
    ]);
  }
}

/** Focused Phase-2 Course execution routes; legacy routes remain in workspaces.ts. */
export function registerAgentCourseRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/workspaces/:id/execution', async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    return { overview: services.courseOverview.get(id) };
  });

  app.get('/api/workspaces/:id/preparation', async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    return { preparation: services.coursePreparation.get(id) };
  });

  app.post('/api/workspaces/:id/preparation/run', async (request, reply) => {
    const { id } = WorkspaceParams.parse(request.params);
    const body = RunCoursePreparationRequestSchema.parse(request.body);
    assertWorkspace(body, id);
    return services.coursePreparation.run(body, { signal: requestSignal(request, reply) });
  });

  app.get('/api/workspaces/:id/documents/:docId/role', async (request) => {
    const { id, docId } = RoleParams.parse(request.params);
    return services.materialRoles.history(id, docId);
  });

  app.post('/api/workspaces/:id/documents/:docId/role/proposals', async (request, reply) => {
    const { id, docId } = RoleParams.parse(request.params);
    const body = ProposeMaterialRoleRequestSchema.parse(request.body);
    assertWorkspace(body, id);
    if (body.materialId !== docId) throw new z.ZodError([]);
    reply.status(201);
    return MaterialRoleAssignmentResponseSchema.parse({
      assignment: services.materialRoles.propose(body),
    });
  });

  app.post('/api/workspaces/:id/documents/:docId/role/:assignmentId/confirm', async (request) => {
    const params = RoleConfirmParams.parse(request.params);
    const body = ConfirmMaterialRoleRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.assignmentId !== params.assignmentId) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['assignmentId'],
          message: 'assignment does not match route assignment',
        },
      ]);
    }
    const roleHistory = services.materialRoles.history(params.id, params.docId);
    if (!roleHistory.history.some((assignment) => assignment.id === params.assignmentId)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['assignmentId'],
          message: 'assignment does not belong to route Material',
        },
      ]);
    }
    const assignment = services.materialRoles.confirm(body);
    return MaterialRoleAssignmentResponseSchema.parse({ assignment });
  });

  app.get('/api/workspaces/:id/contracts', async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    return services.learningContracts.history(id);
  });

  app.get('/api/workspaces/:id/contracts/:contractId', async (request) => {
    const params = ContractParams.parse(request.params);
    return services.learningContracts.detail(params.id, params.contractId);
  });

  app.post('/api/workspaces/:id/contracts', async (request, reply) => {
    const { id } = WorkspaceParams.parse(request.params);
    const body = CreateLearningContractDraftRequestSchema.parse(request.body);
    assertWorkspace(body, id);
    reply.status(201);
    return services.learningContracts.createDraft(body);
  });

  app.patch('/api/workspaces/:id/contracts/:contractId', async (request) => {
    const params = ContractParams.parse(request.params);
    const body = UpdateLearningContractDraftRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.contractId !== params.contractId) throw new z.ZodError([]);
    return services.learningContracts.updateDraft(body);
  });

  app.post('/api/workspaces/:id/contracts/:contractId/transition', async (request) => {
    const params = ContractParams.parse(request.params);
    const body = TransitionLearningContractRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.contractId !== params.contractId) throw new z.ZodError([]);
    return services.learningContracts.transition(body);
  });

  app.get('/api/workspaces/:id/curricula', async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    return services.curriculum.history(id);
  });

  app.get('/api/workspaces/:id/curricula/:curriculumId', async (request) => {
    const params = CurriculumParams.parse(request.params);
    return services.curriculum.detail(params.id, params.curriculumId);
  });

  app.post('/api/workspaces/:id/curricula/proposals', async (request, reply) => {
    const { id } = WorkspaceParams.parse(request.params);
    const body = ProposeCurriculumCommandRequestSchema.parse(request.body);
    assertWorkspace(body, id);
    reply.status(201);
    return services.curriculum.propose(body, { signal: requestSignal(request, reply) });
  });

  app.post('/api/workspaces/:id/curricula/:curriculumId/accept', async (request) => {
    const params = CurriculumParams.parse(request.params);
    const body = AcceptCurriculumRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.curriculumId !== params.curriculumId) throw new z.ZodError([]);
    if (body.acceptanceBasis !== 'learner_review' || body.command.actor !== 'learner') {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['acceptanceBasis'],
          message: 'the public Curriculum route requires learner review',
        },
      ]);
    }
    return services.curriculum.accept(body);
  });

  app.post('/api/workspaces/:id/curricula/:curriculumId/reject', async (request) => {
    const params = CurriculumParams.parse(request.params);
    const body = RejectCurriculumRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.curriculumId !== params.curriculumId) throw new z.ZodError([]);
    return services.curriculum.reject(body);
  });

  app.get('/api/workspaces/:id/study-plans', async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    return services.studyPlansAgent.history(id);
  });

  app.get('/api/workspaces/:id/study-plans/:planId', async (request) => {
    const params = PlanParams.parse(request.params);
    return { studyPlan: services.studyPlansAgent.get(params.id, params.planId) };
  });

  app.post('/api/workspaces/:id/study-plans/proposals', async (request, reply) => {
    const { id } = WorkspaceParams.parse(request.params);
    const body = ProposeStudyPlanRequestSchema.parse(request.body);
    assertWorkspace(body, id);
    reply.status(201);
    return services.studyPlansAgent.propose(body, { signal: requestSignal(request, reply) });
  });

  app.post('/api/workspaces/:id/study-plans/:planId/edits', async (request) => {
    const params = PlanParams.parse(request.params);
    const body = ApplyStudyPlanDraftEditRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.studyPlanId !== params.planId) throw new z.ZodError([]);
    return services.studyPlansAgent.applyDraftEdit(body);
  });

  app.post('/api/workspaces/:id/study-plans/:planId/decision', async (request) => {
    const params = PlanParams.parse(request.params);
    const body = DecideStudyPlanRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.studyPlanId !== params.planId) throw new z.ZodError([]);
    return services.courseExecution.decideStudyPlan(body);
  });

  app.get('/api/workspaces/:id/coverage-risks', async (request) => {
    const { id } = WorkspaceParams.parse(request.params);
    return { risks: services.courseOverview.get(id).riskSummary };
  });

  app.post('/api/workspaces/:id/agendas/:agendaId/items/:itemId/launch', async (request, reply) => {
    const params = AgendaItemParams.parse(request.params);
    const body = LaunchCourseActionRequestSchema.parse(request.body);
    assertWorkspace(body, params.id);
    if (body.agendaId !== params.agendaId || body.agendaItemId !== params.itemId) {
      throw new z.ZodError([]);
    }
    return services.courseActionLaunch.launch(body, { signal: requestSignal(request, reply) });
  });
}
