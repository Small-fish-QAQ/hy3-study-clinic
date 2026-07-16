import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SAMPLE_MATERIAL_CONTENT,
  SAMPLE_MATERIAL_TITLE,
  UpdateMaterialTitleRequestSchema,
} from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { MaterialService } from '../services/materials.js';

const CreateMaterialBodySchema = z.object({
  content: z.string(),
  title: z.string().max(200).optional(),
  filename: z.string().max(255).optional(),
});
const MaterialIdParamsSchema = z.object({ id: z.string().min(1) });

export function registerMaterialRoutes(app: FastifyInstance, materials: MaterialService): void {
  app.post('/api/materials', async (request, reply) => {
    const body = CreateMaterialBodySchema.parse(request.body);
    const created = materials.create(body);
    reply.status(201).send(created);
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

  app.delete('/api/materials/:id', async (request, reply) => {
    const { id } = MaterialIdParamsSchema.parse(request.params);
    materials.delete(id);
    return reply.status(204).send();
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
