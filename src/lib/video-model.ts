/**
 * Friendly display names for the video models Conveyer Hum supports through the
 * 69labs gateway. Keep in sync with the ANIMATION_MODEL dropdown in
 * `app/settings/_groups.ts`. Used by UI that shows the *active* model.
 */
const VIDEO_MODEL_LABELS: Record<string, string> = {
  "veo-3.1-fast": "Veo 3.1 Fast",
  "veo-video": "Veo 3.1",
  "grok-imagine-video": "Grok",
};

/** Short friendly name for a video model id (falls back to the raw id). */
export function videoModelLabel(modelId: string | null | undefined): string {
  if (!modelId) return "Veo 3.1 Fast";
  return VIDEO_MODEL_LABELS[modelId] ?? modelId;
}
