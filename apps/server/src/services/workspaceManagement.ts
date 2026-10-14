import type { ClinicRepository } from '../repositories/clinic.js';
import type { CourseOperationRunner } from './courseOperationRunner.js';

/** Same workspace-owned deletion used by single and batch actions; no cross-course cleanup. */
export function deleteWorkspaces(
  repo: ClinicRepository,
  operations: CourseOperationRunner,
  ids: string[],
) {
  // All selections must exist before any cancellation or deletion happens.
  ids.forEach((id) => repo.workspace(id));
  return repo.transaction(() => {
    for (const workspaceId of ids) {
      for (const row of repo.rows<{ id: string }>(
        "SELECT id FROM agent_operations WHERE workspace_id=? AND status IN ('queued','running')",
        workspaceId,
      ))
        operations.fenceResource(row.id);
      repo.run(
        'DELETE FROM quiz_exposures WHERE quiz_id IN (SELECT id FROM quizzes WHERE workspace_id=?)',
        workspaceId,
      );
      for (const table of [
        'quiz_answer_drafts',
        'repair_rounds',
        'evidence',
        'assessment_grade_records',
      ])
        repo.run(`DELETE FROM ${table} WHERE workspace_id=?`, workspaceId);
      repo.run(
        'DELETE FROM assessment_item_grades WHERE attempt_id IN (SELECT id FROM assessment_attempts WHERE workspace_id=?)',
        workspaceId,
      );
      for (const table of ['assessment_attempts', 'assessment_versions'])
        repo.run(`DELETE FROM ${table} WHERE workspace_id=?`, workspaceId);
      repo.run(
        'DELETE FROM successor_review_events WHERE source_record_id IN (SELECT id FROM submissions WHERE workspace_id=?)',
        workspaceId,
      );
      for (const table of [
        'submissions',
        'quizzes',
        'study_turns',
        'lesson_execution_events',
        'study_sessions',
        'lesson_reflections',
        'course_lesson_versions',
        'curriculum_versions',
        'course_plan_candidates',
        'course_knowledge_inventories',
        'source_blocks',
        'material_revisions',
        'materials',
        'semantic_cache',
      ])
        repo.run(`DELETE FROM ${table} WHERE workspace_id=?`, workspaceId);
      repo.run(
        'DELETE FROM llm_physical_attempts WHERE logical_call_id IN (SELECT id FROM llm_calls WHERE workspace_id=?)',
        workspaceId,
      );
      repo.run('DELETE FROM llm_calls WHERE workspace_id=?', workspaceId);
      repo.run('DELETE FROM workspaces WHERE id=?', workspaceId);
    }
    return { removed: true, workspaceIds: ids };
  });
}
