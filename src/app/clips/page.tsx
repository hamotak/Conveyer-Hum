"use client";
import { StockLibrary } from "../_stock-library";

/**
 * Clips — the stock B-roll library that fills Hybrid / Stock Cut videos.
 * (The old "Past runs" view was removed: it was confusing and its Drive listing
 * caused the page to stall. Auto-reuse of past-run clips still works in the
 * backend.)
 */
export default function ClipsPage() {
  return (
    <div>
      <h1>Clips</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: 13.5 }}>
        The stock B-roll that fills your videos. Pick a channel to see its clips, delete ones that don&apos;t fit, or generate more.
      </p>
      <StockLibrary embedded />
    </div>
  );
}
