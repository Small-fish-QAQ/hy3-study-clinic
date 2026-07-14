import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SAMPLE_MATERIAL_CONTENT, SAMPLE_MATERIAL_TITLE } from '@hy3-clinic/shared';
import { notFound } from '../errors.js';
import type { MaterialService } from '../services/materials.js';

const CreateMaterialBodySchema = z.object({
  content: z.string(),
  title: z.string().max(200).optional(),
  filename: z.string().max(255).optional(),
});

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
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const found = materials.get(id);
    if (!found) throw notFound(`学习资料不存在:${id}`);
    return found;
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
