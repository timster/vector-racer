import type { FastifyInstance } from 'fastify';
import { createPlayer, normalizeName, renamePlayer, type Player } from '../players';

const publicPlayer = (p: Player) => ({ id: p.id, displayName: p.displayName });

export async function playerRoutes(app: FastifyInstance): Promise<void> {
  const limits = app.config.rateLimits;

  // The browser's racer, created on first visit with a default Racer-XXXX name. Idempotent.
  app.post(
    '/player',
    { preHandler: app.limit('players', limits.playersPerHour, '1 hour', 'ip') },
    async (req, reply) => {
      if (req.player) return publicPlayer(req.player);
      const { player, token } = await createPlayer(app.db);
      app.setPlayerCookie(reply, token);
      req.log.info({ playerId: player.id }, 'player created');
      return reply.code(201).send(publicPlayer(player));
    },
  );

  app.get('/player', { preHandler: app.requirePlayer }, async (req) => publicPlayer(req.player!));

  // Renaming applies to every run the player has, since runs reference the player.
  app.patch<{ Body: { displayName: string } }>(
    '/player',
    {
      preHandler: app.requirePlayer,
      schema: {
        body: {
          type: 'object',
          required: ['displayName'],
          additionalProperties: false,
          properties: { displayName: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      const name = normalizeName(req.body.displayName);
      if (!name) {
        return reply
          .code(400)
          .send({ error: 'invalid_name', message: 'Names are 1 to 16 characters: letters, numbers, spaces, _ and -' });
      }
      return publicPlayer(await renamePlayer(app.db, req.player!.id, name));
    },
  );
}
