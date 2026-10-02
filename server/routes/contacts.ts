import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app.js';
import { parseVCards } from '../vcard.js';
import { isValidNanp, normalizePhone } from '../../shared/phone.js';
import type { ContactDto } from '../../shared/types.js';

const ContactBody = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().max(2000).nullable().optional(),
  phones: z.array(z.string()).min(1).max(20),
  /** Move numbers that already belong to another contact instead of refusing. */
  force: z.boolean().optional(),
});

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ImportBody = z.object({ vcard: z.string().max(10 * 1024 * 1024) });

export function registerContactRoutes(app: FastifyInstance, s: Services): void {
  const changed = () => {
    s.events.broadcast({ type: 'contacts' });
    // Conversation names come from contacts.
    s.events.broadcast({ type: 'reload' });
  };

  const save = (id: number | undefined, raw: unknown) => {
    const body = ContactBody.parse(raw);
    const phones = [...new Set(body.phones.map(normalizePhone))];
    const invalid = phones.filter((p) => !isValidNanp(p) && !/^\d{5,6}$/.test(p));
    if (invalid.length) return { status: 400, body: { error: 'invalid_phone', phones: invalid } };
    const conflicts = s.repo.conflictingPhones(phones, id ?? null);
    if (conflicts.length && !body.force) return { status: 409, body: { error: 'phone_taken', phones: conflicts } };
    const contactId = s.repo.saveContact({ id, name: body.name, notes: body.notes ?? null, phones });
    changed();
    return { status: 200, body: s.repo.getContact(contactId)! };
  };

  app.get('/api/contacts', async (): Promise<ContactDto[]> => s.repo.listContacts());

  app.post('/api/contacts', async (req, reply) => {
    const result = save(undefined, req.body);
    return reply.code(result.status === 200 ? 201 : result.status).send(result.body);
  });

  app.put('/api/contacts/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!s.repo.getContact(id)) return reply.code(404).send({ error: 'not_found' });
    const result = save(id, req.body);
    return reply.code(result.status).send(result.body);
  });

  app.delete('/api/contacts/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!s.repo.deleteContact(id)) return reply.code(404).send({ error: 'not_found' });
    changed();
    return { ok: true };
  });

  /** Imports a .vcf file; numbers already assigned to a contact are left alone. */
  app.post('/api/contacts/import', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const { vcard } = ImportBody.parse(req.body);
    let imported = 0;
    let skipped = 0;
    s.repo.transaction(() => {
      for (const contact of parseVCards(vcard)) {
        const free = contact.phones.filter((p) => s.repo.conflictingPhones([p], null).length === 0);
        if (free.length === 0) {
          skipped++;
          continue;
        }
        s.repo.saveContact({ name: contact.name, phones: free });
        imported++;
      }
    });
    if (imported) changed();
    return { imported, skipped };
  });
}
