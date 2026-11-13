// Replays a run exported from the browser ("Copy run") and prints the server-side result.
// Usage: npm run replay -- run.json      or      pbpaste | npm run replay
import { readFileSync } from 'node:fs';
import { replay, SIM_VERSION } from '@vector-racer/sim';
import { getBuiltinTrack } from '@vector-racer/tracks';

interface RunFile {
  track: string;
  trackVersion: number;
  moves: unknown;
}

function main(): number {
  const path = process.argv[2];
  const text = readFileSync(path ?? 0, 'utf8');
  const run = JSON.parse(text) as RunFile;

  const t = getBuiltinTrack(run.track);
  if (!t) {
    console.error(`unknown track: ${run.track}`);
    return 2;
  }
  if (t.version !== run.trackVersion) {
    console.error(`stale track version: run is v${run.trackVersion}, ${t.slug} is v${t.version}`);
    return 2;
  }

  const result = replay(t.track, run.moves);
  console.log(`track:   ${t.slug} v${t.version}`);
  console.log(`sim:     ${SIM_VERSION}`);
  console.log(`moves:   ${Array.isArray(run.moves) ? run.moves.length : '?'}`);
  if (!result.valid) {
    console.log(`result:  INVALID (${result.reason})`);
    return 1;
  }
  console.log(`result:  valid, score ${result.score}`);
  return 0;
}

process.exitCode = main();
