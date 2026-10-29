import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import type { UpdateStatusDto } from '../../shared/types.js';

const StatusQuery = z.object({ refresh: z.enum(['0', '1']).optional() });

export function registerUpdateRoutes(app: FastifyInstance, s: Services): void {
  /** The newest release and how to install it; ?refresh=1 asks GitHub now. */
  app.get('/api/update', { config: { admin: true } }, async (req): Promise<UpdateStatusDto> => {
    const { refresh } = StatusQuery.parse(req.query);
    return s.updates.status(refresh === '1');
  });

  /** Only the PHP version replaces its own files; Docker pulls a new image instead. */
  app.post('/api/update/install', { config: { admin: true } }, async (_req, reply) => reply.code(409).send({ error: 'install_unsupported' }));
}
