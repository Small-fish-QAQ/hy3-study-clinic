import {
  LessonReflectionSchema,
  lessonReflectionPrompt,
  type LessonReflection,
  type CourseLessonContent,
  type CourseCommand,
} from '@hy3-clinic/shared';
import type { ClinicRepository } from '../repositories/clinic.js';
import { AppError } from '../errors.js';
import { canonical } from '../util/canonical.js';

export class LessonReflections {
  constructor(readonly repo: ClinicRepository) {}
  list(workspaceId: string, lessonVersionId?: string) {
    return this.repo.payloads<LessonReflection>(
      `SELECT payload FROM lesson_reflections WHERE workspace_id=?${lessonVersionId ? ' AND lesson_version_id=?' : ''} ORDER BY updated_at DESC`,
      workspaceId,
      ...(lessonVersionId ? [lessonVersionId] : []),
    );
  }
  save(
    workspaceId: string,
    command: CourseCommand,
    input: {
      lessonVersionId: string;
      segmentId: string;
      status: LessonReflection['status'];
      response: string;
      expectedVersion: number;
    },
  ) {
    return this.repo.command(workspaceId, command, { action: 'lessonReflection', ...input }, () => {
      const content = this.repo.owned<CourseLessonContent>(
        'course_lesson_versions',
        input.lessonVersionId,
        workspaceId,
      );
      const segment = content.segments.find((s) => s.id === input.segmentId);
      if (!segment || !lessonReflectionPrompt(segment))
        throw new AppError('VALIDATION_ERROR', '该段是教师讲解，没有课堂思考任务。');
      const current = this.list(workspaceId, content.id).find(
        (s) => s.segmentId === input.segmentId,
      );
      if ((current?.version ?? 0) !== input.expectedVersion)
        throw new AppError('VERSION_CONFLICT', '课堂思考已有新记录，请刷新后继续。');
      if (input.status === 'answered' && !input.response.trim())
        throw new AppError('VALIDATION_ERROR', '请先写下你的思考。');
      const saved = LessonReflectionSchema.parse({
        lessonVersionId: content.id,
        segmentId: segment.id,
        status: input.status,
        response: input.response,
        version: (current?.version ?? 0) + 1,
        updatedAt: this.repo.now(),
      });
      this.repo.run(
        `INSERT INTO lesson_reflections VALUES(?,?,?,?,?) ON CONFLICT(lesson_version_id,segment_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`,
        workspaceId,
        content.id,
        segment.id,
        canonical(saved),
        saved.updatedAt,
      );
      return saved;
    });
  }
}
