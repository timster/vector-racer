import { BUILTIN_TRACKS } from './builtin';
import { parseTrack, type ParsedTrack } from './format';

export * from './format';
export * from './validate';
export { BUILTIN_TRACKS };

export function getBuiltinTrack(slug: string): ParsedTrack | undefined {
  const def = BUILTIN_TRACKS.find((t) => t.slug === slug);
  return def && parseTrack(def);
}
