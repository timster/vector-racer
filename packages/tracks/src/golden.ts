import type { Track } from '@vector-racer/sim';
import cases from '../golden/cases.json';
import { BUILTIN_TRACKS } from './builtin';
import { parseMap, parseTrack } from './format';

export interface GoldenCase {
  name: string;
  map?: string;
  slug?: string;
  trackVersion?: number;
  maxTurns?: number;
  moves: number[];
  expectedScore?: number;
  expectedReason?: string;
}

export const GOLDEN_SIM_VERSION: number = cases.simVersion;
export const GOLDEN_CASES: readonly GoldenCase[] = cases.cases;

/** Resolves a golden case's track, failing loudly if a built-in track's version has moved on. */
export function goldenTrack(c: GoldenCase): Track {
  if (c.map !== undefined) return parseMap(c.map, c.maxTurns);
  const def = BUILTIN_TRACKS.find((d) => d.slug === c.slug);
  if (!def) throw new Error(`golden case "${c.name}": unknown track ${c.slug}`);
  if (def.version !== c.trackVersion) {
    throw new Error(`golden case "${c.name}": track ${c.slug} is v${def.version}, case expects v${c.trackVersion}`);
  }
  return parseTrack(def).track;
}
