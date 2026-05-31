"use client";

export function friendlyError(raw: unknown, fallback = "That action failed. Please try again."): string {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  const lower = text.toLowerCase();

  if (!text.trim()) return fallback;
  if (lower.includes("invalid_grant")) {
    return "Google Drive login expired. Reconnect Drive in Settings, then try again.";
  }
  if (lower.includes("redirect_uri_mismatch")) {
    return "Google rejected the callback URL. Add the exact callback URL shown in Settings, then reconnect Drive.";
  }
  if (lower.includes("concurrent") || lower.includes("rate limit") || lower.includes("429")) {
    return "The provider is full right now. The app will wait for a slot instead of wasting credits.";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return "A connected service rejected the request. Check the related key or reconnect the service in Settings.";
  }
  if (lower.includes("failed to fetch") || lower.includes("network") || lower.includes("timeout")) {
    return "The app could not reach the service. Check the connection and try again.";
  }
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}
