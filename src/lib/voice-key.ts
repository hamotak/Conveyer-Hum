/**
 * Stable, unique identity for a voice row in the picker. Dependency-free so it
 * can be shared by the client modal and unit-tested in isolation.
 *
 * Saved voices key off their DB primary key (`savedId`) — two saved rows can
 * legitimately share the same `voiceId` (e.g. duplicates from older DBs), so the
 * voiceId alone is NOT unique and using it as a React key throws the
 * "two children with the same key" warning. Library (clone) voices have unique
 * ids already, so source+voiceId is fine for them.
 */
export interface VoiceKeyLike {
  source: string;
  voiceId: string;
  savedId?: string | null;
}

export function voiceUid(v: VoiceKeyLike): string {
  if (v.source === "saved" && v.savedId) return `saved:${v.savedId}`;
  return `${v.source}:${v.voiceId}`;
}

/**
 * Which single row should appear selected. Exactly one — the FIRST voice whose
 * voiceId matches the chosen id (saved-first order), so duplicate saved voices
 * that share a voiceId don't both highlight. Returns null when nothing matches.
 */
export function selectedVoiceUid(
  list: VoiceKeyLike[],
  selectedVoiceId: string | null | undefined
): string | null {
  if (!selectedVoiceId) return null;
  const match = list.find((v) => v.voiceId === selectedVoiceId);
  return match ? voiceUid(match) : null;
}
