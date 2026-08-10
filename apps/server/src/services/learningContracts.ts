import {
  ApiErrorCode,
  CreateLearningContractDraftRequestSchema,
  LearningContractDetailResponseSchema,
  LearningContractHistoryResponseSchema,
  TransitionLearningContractRequestSchema,
  UpdateLearningContractDraftRequestSchema,
  type CreateLearningContractDraftRequest,
  type LearningContract,
  type LearningContractDetailResponse,
  type LearningContractHistoryResponse,
  type TransitionLearningContractRequest,
  type UpdateLearningContractDraftRequest,
} from '@hy3-clinic/shared';
import { AppError, notFound } from '../errors.js';
import type { Repositories } from '../repositories/index.js';
import type { Clock } from '../util/ids.js';
import { newId } from '../util/ids.js';
import type { CourseCommandService } from './courseCommands.js';
import { computeContractFeasibility } from './feasibility.js';

interface LearningContractServiceDeps {
  repos: Repositories;
  clock: Clock;
  commands: CourseCommandService;
}

function ensureDistinctScope(contract: LearningContract): void {
  const materialIds = contract.courseScope.materials.map((item) => item.materialId);
  if (new Set(materialIds).size !== materialIds.length) {
    throw new AppError(
      ApiErrorCode.ValidationError,
      'A Material may appear only once in Contract scope.',
    );
  }
}

export function createLearningContractService({
  repos,
  clock,
  commands,
}: LearningContractServiceDeps) {
  function requireWorkspace(workspaceId: string): void {
    if (!repos.workspaces.get(workspaceId)) throw notFound('Course not found.');
  }

  function requireContract(workspaceId: string, contractId: string): LearningContract {
    const contract = repos.learningContracts.get(contractId);
    if (!contract || contract.workspaceId !== workspaceId)
      throw notFound('Learning Contract not found.');
    return contract;
  }

  function detail(workspaceId: string, contractId: string): LearningContractDetailResponse {
    const contract = requireContract(workspaceId, contractId);
    const feasibility = repos.learningContracts.getLatestFeasibility(contract.id);
    if (!feasibility) throw new Error('Learning Contract feasibility snapshot is missing.');
    return LearningContractDetailResponseSchema.parse({ contract, feasibility });
  }

  function history(workspaceId: string): LearningContractHistoryResponse {
    requireWorkspace(workspaceId);
    const items = repos.learningContracts.list(workspaceId);
    const state = repos.courseExecution.get(workspaceId);
    const pending = [...items]
      .reverse()
      .find(
        (item) =>
          item.status === 'draft' ||
          item.status === 'proposed' ||
          item.status === 'learner_confirmed',
      );
    return LearningContractHistoryResponseSchema.parse({
      workspaceId,
      activeContractId: state.activeContractId,
      pendingContractId: pending && pending.id !== state.activeContractId ? pending.id : null,
      items: items.map((item) => ({
        id: item.id,
        version: item.version,
        predecessorId: item.predecessorId,
        status: item.status,
        intent: item.intent,
        targetDescription: item.targetOutcome.description,
        deadlineAt: item.deadline?.at ?? null,
        desiredDepth: item.desiredDepth,
        learnerConfirmedAt: item.learnerConfirmedAt,
        createdAt: item.createdAt,
      })),
    });
  }

  function createDraft(input: CreateLearningContractDraftRequest): LearningContractDetailResponse {
    const parsed = CreateLearningContractDraftRequestSchema.parse(input);
    requireWorkspace(parsed.command.workspaceId);
    const claim = commands.begin(parsed.command, 'create_learning_contract', {
      predecessorContractId: parsed.predecessorContractId,
      expectedActiveContractId: parsed.expectedActiveContractId,
    });
    try {
      return LearningContractDetailResponseSchema.parse(
        commands.complete(claim, () => {
          const versions = repos.learningContracts.list(parsed.command.workspaceId);
          const latest = versions.at(-1);
          const state = repos.courseExecution.get(parsed.command.workspaceId);
          if (
            (latest?.id ?? null) !== parsed.predecessorContractId ||
            state.activeContractId !== parsed.expectedActiveContractId
          ) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Learning Contract pointers are stale.',
              {
                latestContractId: latest?.id ?? null,
                activeContractId: state.activeContractId,
              },
            );
          }
          const now = clock.now().toISOString();
          const contract: LearningContract = {
            id: newId('contract'),
            workspaceId: parsed.command.workspaceId,
            version: (latest?.version ?? 0) + 1,
            predecessorId: parsed.predecessorContractId,
            ...parsed.fields,
            status: 'draft',
            proposedBy: parsed.command.actor,
            learnerConfirmedAt: null,
            createdAt: now,
          };
          ensureDistinctScope(contract);
          const feasibility = computeContractFeasibility(contract, null, clock.now());
          const created = repos.learningContracts.createVersion(contract, feasibility, {
            id: newId('contract_evt'),
            eventType: 'draft_created',
            actor: parsed.command.actor,
            payload: { stableScopeOnly: true },
            createdAt: now,
          });
          return { contract: created, feasibility };
        }),
      );
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function updateDraft(input: UpdateLearningContractDraftRequest): LearningContractDetailResponse {
    const parsed = UpdateLearningContractDraftRequestSchema.parse(input);
    const claim = commands.begin(parsed.command, 'update_learning_contract', {
      contractId: parsed.contractId,
      expectedVersion: parsed.expectedVersion,
    });
    try {
      return LearningContractDetailResponseSchema.parse(
        commands.complete(claim, () => {
          const current = requireContract(parsed.command.workspaceId, parsed.contractId);
          if (current.status !== 'draft' || current.version !== parsed.expectedVersion) {
            throw new AppError(
              ApiErrorCode.VersionConflict,
              'Only the current draft Contract may be edited.',
            );
          }
          const latest = repos.learningContracts.list(parsed.command.workspaceId).at(-1);
          if (latest?.id !== current.id) {
            throw new AppError(ApiErrorCode.VersionConflict, 'Learning Contract draft is stale.');
          }
          const now = clock.now().toISOString();
          const successor: LearningContract = {
            ...current,
            id: newId('contract'),
            version: current.version + 1,
            predecessorId: current.id,
            ...parsed.fields,
            proposedBy: parsed.command.actor,
            createdAt: now,
          };
          ensureDistinctScope(successor);
          const feasibility = computeContractFeasibility(successor, null, clock.now());
          repos.learningContracts.transition(current.id, 'draft', 'withdrawn', now, {
            id: newId('contract_evt'),
            eventType: 'draft_replaced',
            actor: parsed.command.actor,
            payload: { successorId: successor.id },
            createdAt: now,
          });
          const created = repos.learningContracts.createVersion(successor, feasibility, {
            id: newId('contract_evt'),
            eventType: 'successor_draft_created',
            actor: parsed.command.actor,
            payload: { predecessorId: current.id },
            createdAt: now,
          });
          return { contract: created, feasibility };
        }),
      );
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  function transition(input: TransitionLearningContractRequest): LearningContractDetailResponse {
    const parsed = TransitionLearningContractRequestSchema.parse(input);
    const current = requireContract(parsed.command.workspaceId, parsed.contractId);
    if (current.version !== parsed.expectedVersion) {
      throw new AppError(ApiErrorCode.VersionConflict, 'Learning Contract version is stale.');
    }
    const nextStatus =
      parsed.transition === 'propose'
        ? 'proposed'
        : parsed.transition === 'confirm'
          ? 'learner_confirmed'
          : 'withdrawn';
    const claim = commands.begin(parsed.command, `${parsed.transition}_learning_contract`, {
      contractId: parsed.contractId,
      expectedVersion: parsed.expectedVersion,
      transition: parsed.transition,
    });
    try {
      return LearningContractDetailResponseSchema.parse(
        commands.complete(claim, () => {
          const latest = requireContract(parsed.command.workspaceId, parsed.contractId);
          const changed = repos.learningContracts.transition(
            current.id,
            latest.status,
            nextStatus,
            clock.now().toISOString(),
            {
              id: newId('contract_evt'),
              eventType: parsed.transition,
              actor: parsed.command.actor,
              payload: {},
              createdAt: clock.now().toISOString(),
            },
          );
          const feasibility = repos.learningContracts.getLatestFeasibility(changed.id)!;
          return { contract: changed, feasibility };
        }),
      );
    } catch (error) {
      commands.fail(claim, error);
      throw error;
    }
  }

  return { detail, history, createDraft, updateDraft, transition };
}

export type LearningContractService = ReturnType<typeof createLearningContractService>;
