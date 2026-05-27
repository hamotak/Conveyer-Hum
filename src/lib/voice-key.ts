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
export function voiceUid(v: { source: string; voiceId: string; savedId?: string | null }): string {
  if (v.source === "saved" && v.savedId) return `saved:${v.savedId}`;
  return `${v.source}:${v.voiceId}`;
}
