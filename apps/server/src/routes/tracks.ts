import type { FastifyInstance } from 'fastify';
import { bestForPlayer, leaderboard, submitRun } from '../runs';
import { currentTrack, listTracks, type StoredTrack } from '../tracks';

function publicTrack(t: StoredTrack) {
  return {
    slug: t.slug,
    version: t.version,
    name: t.name,
    rulesVersion: t.rulesVersion,
    maxTurns: t.maxTurns,
    par: t.par,
    map: t.rows.join('\n'),
  };
}

/** Upper bound before the track is even loaded; the real cap is the track's maxTurns. */
const MAX_MOVES = 2000;

export async function trackRoutes(app: FastifyInstance): Promise<void> {
  const limits = app.config.rateLimits;

  app.get('/tracks', async () => (await listTracks(app.db)).map(publicTrack));

  app.get<{ Params: { slug: string } }>('/tracks/:slug', async (req, reply) => {
    const track = await currentTrack(app.db, req.params.slug);
    if (!track) return reply.code(404).send({ error: 'unknown_track', message: 'No such track' });
    return publicTrack(track);
  });

  app.post<{ Params: { slug: string }; Body: { trackVersion: number; moves: unknown[] } }>(
    '/tracks/:slug/runs',
    {
      preHandler: [
        app.requirePlayer,
        app.limit('runs-player', limits.runsPerMinutePerPlayer, '1 minute', 'player'),
        app.limit('runs-ip', limits.runsPerMinutePerIp, '1 minute'),
      ],
      schema: {
        body: {
          type: 'object',
          required: ['trackVersion', 'moves'],
          // Anything else, e.g. a client-supplied score, is stripped before the handler sees it.
          additionalProperties: false,
          properties: {
            trackVersion: { type: 'integer', minimum: 1 },
            // Items are checked by replay() so a bad move gets a precise reason.
            moves: { type: 'array', maxItems: MAX_MOVES },
          },
        },
      },
    },
    async (req, reply) => {
      const player = req.player!;
      const track = await currentTrack(app.db, req.params.slug);
      if (!track) return reply.code(404).send({ error: 'unknown_track', message: 'No such track' });

      const result = await submitRun(app.db, player.id, track, req.body.trackVersion, req.body.moves);
      if (!result.ok) {
        req.log.warn(
          {
            playerId: player.id,
            ip: req.ip,
            track: track.slug,
            error: result.error,
            reason: result.reason,
            moves: req.body.moves.length,
          },
          'run rejected',
        );
        const message =
          result.error === 'stale_track_version'
            ? `This run is for an old version of ${track.name}; the current one is version ${track.version}`
            : result.error === 'duplicate_run'
              ? 'You already submitted this exact run'
              : `Run rejected: ${result.reason}`;
        const { ok: _ok, status, ...body } = result;
        return reply.code(status).send({ ...body, message });
      }

      req.log.info(
        { playerId: player.id, track: track.slug, runId: result.runId, score: result.score },
        'run accepted',
      );
      const best = await bestForPlayer(app.db, track.id, player.id);
      return reply.code(201).send({
        score: result.score,
        par: track.par,
        best: best ? { rank: best.rank, score: best.score } : null,
        isBest: best?.runId === result.runId,
      });
    },
  );

  // Names and scores only: other players' moves are never served, so their lines stay a mystery.
  app.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    '/tracks/:slug/leaderboard',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'string', pattern: '^[0-9]{1,3}$' } },
        },
      },
    },
    async (req, reply) => {
      const track = await currentTrack(app.db, req.params.slug);
      if (!track) return reply.code(404).send({ error: 'unknown_track', message: 'No such track' });
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
      const entries = await leaderboard(app.db, track.id, limit);
      const me = req.player ? await bestForPlayer(app.db, track.id, req.player.id) : undefined;
      return {
        track: { slug: track.slug, version: track.version, par: track.par },
        entries: entries.map((e) => ({
          rank: e.rank,
          playerName: e.playerName,
          score: e.score,
          createdAt: e.createdAt,
          isMe: e.playerId === req.player?.id,
        })),
        me: me ? { rank: me.rank, score: me.score } : null,
      };
    },
  );
}
