import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DocumentFilePayloadSchema,
  SAMPLE_MATERIAL_CONTENT,
  SAMPLE_MATERIAL_TITLE,
  UpdateMaterialTitleRequestSchema,
  WebSnapshotRequestSchema,
} from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { MaterialService } from '../services/materials.js';
import { requestSignal } from '../util/requestSignal.js';

const CreateMaterialBodySchema = z.object({
  content: z.string(),
  title: z.string().max(200).optional(),
  filename: z.string().max(255).optional(),
});
const MaterialIdParamsSchema = z.object({ id: z.string().min(1) });

export function registerMaterialRoutes(app: FastifyInstance, materials: MaterialService): void {
  app.post('/api/materials', async (request, reply) => {
    const raw = request.body;
    // File imports (.md/.txt/.pdf/.docx sent as base64) are distinguished
    // from pasted/read text by the presence of `dataBase64`; both shapes
    // stay schema-validated and share the workspace document ingestion path.
    if (typeof raw === 'object' && raw !== null && 'dataBase64' in raw) {
      const body = DocumentFilePayloadSchema.parse(raw);
      const created = await materials.createFromUpload(body, undefined, {
        signal: requestSignal(request, reply),
      });
      reply.status(201).send(created);
      return;
    }
    const body = CreateMaterialBodySchema.parse(raw);
    const created = materials.create(body);
    reply.status(201).send(created);
  });

  app.post('/api/materials/web-snapshot', async (request, reply) => {
    const body = WebSnapshotRequestSchema.parse(request.body);
    const created = await materials.createFromWebSnapshot(body, undefined, {
      signal: requestSignal(request, reply),
    });
    reply.status(201).send(created);
  });

  app.post('/api/materials/:id/web-snapshot', async (request, reply) => {
    const { id } = MaterialIdParamsSchema.parse(request.params);
    const body = WebSnapshotRequestSchema.parse(request.body);
    const refreshed = await materials.refreshWebSnapshot(id, body, {
      signal: requestSignal(request, reply),
    });
    reply.status(200).send(refreshed);
  });

  app.get('/api/materials', async () => {
    return { materials: materials.list() };
  });

  app.get('/api/materials/:id', async (request) => {
    const { id } = MaterialIdParamsSchema.parse(request.params);
    const found = materials.get(id);
    if (!found) throw notFound(`学习资料不存在:${id}`);
    return found;
  });

  app.patch('/api/materials/:id', async (request) => {
    const { id } = MaterialIdParamsSchema.parse(request.params);
    const { title } = UpdateMaterialTitleRequestSchema.parse(request.body);
    return { material: materials.updateTitle(id, title) };
  });

  // Returns the structured deletion result (200) instead of a bare 204: the
  // client needs to know whether the document's auto-created import
  // workspace was retired with it to reconcile workspace-scoped state.
  app.delete('/api/materials/:id', async (request) => {
    const { id } = MaterialIdParamsSchema.parse(request.params);
    return materials.delete(id);
  });

  // Built-in self-authored sample document (original content, Apache-2.0).
  app.get('/api/sample-material', async () => {
    return {
      title: SAMPLE_MATERIAL_TITLE,
      content: SAMPLE_MATERIAL_CONTENT,
      filename: 'sample.md',
    };
  });
}
