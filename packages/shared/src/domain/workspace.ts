import { z } from 'zod';
import { MediaTypeSchema, ParseStatusSchema, SourceTypeSchema } from './material.js';

/** Maximum length of a course-workspace name. */
export const WORKSPACE_NAME_MAX_LENGTH = 120;

/** Hard limit on uploaded document files (decoded bytes). */
export const MAX_DOCUMENT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Schema-level bound on the base64 payload. Slightly above the encoded size
 * of MAX_DOCUMENT_FILE_BYTES so marginally-oversized uploads reach the
 * precise decoded-size check (413) instead of a generic schema error, while
 * absurdly large payloads still fail fast at validation.
 */
export const MAX_DOCUMENT_FILE_BASE64_CHARS =
  Math.ceil((MAX_DOCUMENT_FILE_BYTES + 1024 * 1024) / 3) * 4 + 4;

/**
 * How a course workspace came into existence. Persisted once at creation and
 * immutable afterwards; it decides the workspace's deletion lifecycle:
 *
 * - `manual`: explicitly created by the learner (POST /api/workspaces). The
 *   workspace is a deliberate container — deleting its final document keeps
 *   it (and its workspace-scoped assessment history) for future documents.
 * - `material_import`: auto-created behind the scenes for a 资料库 import
 *   (POST /api/materials without a workspace). An implementation detail of
 *   that import — deleting its final document retires the workspace with it,
 *   in the same transaction.
 * - `unknown`: persisted before origins existed (including migration-created
 *   legacy compatibility workspaces). Origin cannot be reconstructed
 *   honestly, so these are conservatively preserved like `manual` and stay
 *   manually deletable.
 */
export const WorkspaceOriginSchema = z.enum(['manual', 'material_import', 'unknown']);
export type WorkspaceOrigin = z.infer<typeof WorkspaceOriginSchema>;

/**
 * A course workspace: the organizational unit that groups one or more source
 * documents, their concepts, the evidence-grounded concept graph, and
 * remediation plans. Learner state (attempts, mistakes, mastery) stays keyed
 * to documents/concepts — the workspace only aggregates it.
 */
export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(WORKSPACE_NAME_MAX_LENGTH),
  description: z.string().max(500).nullable(),
  /** Currently active concept-graph version (null before first generation). */
  activeGraphVersionId: z.string().nullable(),
  origin: WorkspaceOriginSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Listing projection of a workspace with aggregate counts. */
export const WorkspaceSummarySchema = WorkspaceSchema.extend({
  documentCount: z.number().int().nonnegative(),
  conceptCount: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

/** Listing projection of a document (no content body). */
export const DocumentSummarySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1).max(200),
  sourceType: SourceTypeSchema,
  mediaType: MediaTypeSchema.nullable(),
  originalFilename: z.string().max(255).nullable(),
  charCount: z.number().int().positive(),
  blockCount: z.number().int().nonnegative(),
  conceptCount: z.number().int().nonnegative(),
  parseStatus: ParseStatusSchema,
  pageCount: z.number().int().positive().nullable(),
  extractionWarnings: z.array(z.string().max(500)).max(50),
  parserVersion: z.string().max(80).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

/** Runtime contract for POST /api/workspaces. */
export const CreateWorkspaceRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, '课程空间名称不能为空。')
      .max(WORKSPACE_NAME_MAX_LENGTH, `课程空间名称不能超过 ${WORKSPACE_NAME_MAX_LENGTH} 个字符。`),
    description: z.string().trim().max(500).optional(),
  })
  .strict();
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

/** Runtime contract for PATCH /api/workspaces/:id. */
export const UpdateWorkspaceRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, '课程空间名称不能为空。')
      .max(WORKSPACE_NAME_MAX_LENGTH, `课程空间名称不能超过 ${WORKSPACE_NAME_MAX_LENGTH} 个字符。`),
  })
  .strict();
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

/**
 * Structured result of deleting a document (DELETE /api/materials/:id and
 * DELETE /api/workspaces/:id/documents/:docId). `workspaceDeleted` is true
 * only when the deleted document was the final one of a `material_import`
 * workspace, which is then retired in the same transaction — the client uses
 * this to reconcile workspace-scoped state without guessing.
 */
export const DocumentDeletionResultSchema = z.object({
  workspaceId: z.string().min(1),
  workspaceDeleted: z.boolean(),
});
export type DocumentDeletionResult = z.infer<typeof DocumentDeletionResultSchema>;

/**
 * Base64 file payload shared by every upload surface: workspace document
 * upload (`kind: 'file'`) and the material-library import (POST
 * /api/materials with `dataBase64`). The server re-validates extension,
 * magic bytes, and decoded size before parsing.
 */
export const DocumentFilePayloadSchema = z
  .object({
    filename: z.string().min(1).max(255),
    dataBase64: z.string().min(1).max(MAX_DOCUMENT_FILE_BASE64_CHARS),
    title: z.string().max(200).optional(),
    /** Optional client-declared MIME, cross-checked against extension/signature. */
    mediaType: MediaTypeSchema.optional(),
  })
  .strict();
export type DocumentFilePayload = z.infer<typeof DocumentFilePayloadSchema>;

/**
 * Runtime contract for POST /api/workspaces/:id/documents.
 *
 * Text-like sources (paste / .md / .txt) are sent as plain text; binary
 * sources (.pdf / .docx) are sent base64-encoded and are re-validated
 * server-side (extension, magic bytes, decoded size) before parsing.
 */
export const AddDocumentRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      content: z.string(),
      title: z.string().max(200).optional(),
      filename: z.string().max(255).optional(),
    })
    .strict(),
  DocumentFilePayloadSchema.extend({ kind: z.literal('file') }),
]);
export type AddDocumentRequest = z.infer<typeof AddDocumentRequestSchema>;
