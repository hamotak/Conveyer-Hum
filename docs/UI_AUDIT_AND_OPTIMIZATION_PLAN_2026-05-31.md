# Conveyer Hum UI + Project Audit

Date: 2026-05-31  
Audited app: `http://localhost:3001`  
Actual project root: `/Users/hamidaliyev/Desktop/Conveyer-Hum`

## Scope

- Inspected the project files, generated folders, source reachability, package usage, and app routes.
- Exercised the UI with the in-app browser and the repo's Playwright audit scripts.
- Captured fresh screenshots in `artifacts/2026-05-31-current/`.
- Did not press the real `Run` button with live providers, reveal real secrets, disconnect Drive, or start real B-roll generation, because those actions can expose secrets, alter accounts, spend credits, or transmit script data. The run/detail actions were exercised through mocked audit scripts.

## Project File Audit

### Source Of Truth

- `/Users/hamidaliyev/Desktop/Conveyer-Hum` is the real repo. It has `package.json`, `.git`, `src/app`, `src/lib`, and the live dev server on port `3001`.
- `/Users/hamidaliyev/Documents/Conveyer-Hum` was stale and contained only `.next` artifacts. I removed that stale `.next` folder.
- Port `3000` is a different app at `/Users/hamidaliyev/ytmanager`, not Conveyer Hum.

### Cleanup Done

- Removed generated junk folders:
  - `.next 2`
  - `.next 3`
  - `.playwright-mcp`
  - `audit-screenshots`
  - stale `/Users/hamidaliyev/Documents/Conveyer-Hum/.next`
- Removed old artifact batches and kept only `artifacts/2026-05-31-current`.
- Updated `.gitignore` to ignore `.next*`, `artifacts/`, and `tmp/`.

### Source Reachability

- Static import graph found `109/109` source files reachable from Next route/layout/API entrypoints.
- No source files should be deleted right now.
- `src/app/stock/page.tsx`, `src/app/reassembly/page.tsx`, and `src/app/advanced/page.tsx` are legacy compatibility pages. They are linked indirectly by tests and should become real redirects or be intentionally kept.

### Dependency Candidates

Potentially unused package entries:

- `clsx`
- `tailwind-merge`
- `zod`

Package nuance:

- Scripts import `playwright`, while `package.json` lists `@playwright/test`. This works through transitive install today, but should be made explicit by adding `playwright` directly or changing scripts to an intentional package import.

## Verification Results

| Check | Result | Notes |
|---|---:|---|
| `npm run lint` | Pass | TypeScript completed cleanly. |
| `npm run test` | Fail | `22/23` suites passed. `scene-chunking.test.ts` fails: `natural repaired plan is accepted`. |
| `npm run build` | Fail | `/clips/generate` uses `useSearchParams()` without a Suspense boundary. |
| `ui-click-audit` | Fail | Navigation, settings tabs, legacy redirects, Run disabled state, clear draft, and final video frame checks failed. |
| `ui-run-actions-audit` | Fail | `5/6` mocked run scenarios passed; unsynced done run could not find expected `Upload to Drive` button. |

## Fresh Screenshot Evidence

Manual browser screenshots:

- `artifacts/2026-05-31-current/manual-browser/01-home.png`
- `artifacts/2026-05-31-current/manual-browser/02-home-script.png`
- `artifacts/2026-05-31-current/manual-browser/03-home-full-render.png`
- `artifacts/2026-05-31-current/manual-browser/04-home-stock-cut.png`
- `artifacts/2026-05-31-current/manual-browser/05-home-hybrid.png`
- `artifacts/2026-05-31-current/manual-browser/06-clips.png`
- `artifacts/2026-05-31-current/manual-browser/07-library.png`
- `artifacts/2026-05-31-current/manual-browser/08-runs.png`
- `artifacts/2026-05-31-current/manual-browser/09-channels.png`
- `artifacts/2026-05-31-current/manual-browser/10-settings.png`
- `artifacts/2026-05-31-current/manual-browser/11-settings-speed-quality.png`
- `artifacts/2026-05-31-current/manual-browser/12-settings-files.png`
- `artifacts/2026-05-31-current/manual-browser/13-settings-connections.png`
- `artifacts/2026-05-31-current/manual-browser/14-settings-rarely-needed.png`

Automated screenshots and JSON reports:

- `artifacts/2026-05-31-current/ui-click-audit/report.json`
- `artifacts/2026-05-31-current/run-actions/ui-run-actions-audit.json`

## Findings And Fix Plan

### P0: App Correctness Blockers

1. Sidebar links can fail to navigate.
   - Evidence: `ui-click-audit` stayed on `/clips` or `/prompts` after clicking other sidebar links.
   - Likely cause: `src/app/_sidebar.tsx` calls `closeDrawer()` on every desktop link click, and `closeDrawer()` uses `window.history.replaceState(...)`.
   - Fix: only close the hash drawer when `drawerOpen` is true; do not call `history.replaceState` on normal desktop navigation.

2. Production build fails on `/clips/generate`.
   - Evidence: `npm run build` fails with `useSearchParams() should be wrapped in a suspense boundary`.
   - Fix: split `src/app/clips/generate/page.tsx` into a server wrapper with `<Suspense>` and a client child, or pass `searchParams` from the page props instead of calling `useSearchParams()` at the top level.

3. Scene chunking regression.
   - Evidence: `scripts/audit-tests/scene-chunking.test.ts` fails `natural repaired plan is accepted`.
   - Fix: adjust `validateFreshOpeningScenes()` so natural sentence-final chunks are accepted while still rejecting mid-thought starts/ends.

4. Legacy routes do not behave as expected.
   - Evidence: `/stock` stayed on `/stock`; audit expected `/clips`. `/advanced` and `/reassembly` are also compatibility screens.
   - Fix: use Next `redirect()` for true legacy aliases, or update tests and navigation language if compatibility pages are intentional.

### P1: Slow And Clunky Interactions

5. Settings tabs are slow and route-heavy.
   - Evidence: in-app browser measured `Files` and `Connections` tab clicks at about `3s`.
   - Likely cause: Settings tabs are `Link` elements with local `onClick` state updates, so clicks perform client state changes plus URL navigation.
   - Fix: make Settings tabs real buttons that call `history.replaceState`, or call `preventDefault()` and manage URL state without App Router navigation.

6. New Run first paint is different from loaded UI.
   - Evidence: first screen shows a `Loading channels` card, then swaps to the full form.
   - Cause: `src/app/page.tsx` is a client-only page that waits for channels/settings/preflight after mount.
   - Fix: either load initial channels/settings/preflight server-side or render a skeleton that preserves the final form geometry.

7. Short scripts get trapped by default Hybrid fresh duration.
   - Evidence: with a 28-word script, Hybrid showed `5 min` fresh opening, every fresh preset was disabled, and `Run` stayed disabled.
   - Fix: if the selected channel's fresh duration is unsupported, auto-select the largest supported preset, show a clear inline adjustment, or let Full Render/Stock Cut remain obviously runnable.

8. Run detail can reserve a zero-size final video frame.
   - Evidence: `ui-click-audit` reported `Final video frame is not visibly reserved: width 0 height 0`.
   - Fix: give the final video/preview container a stable aspect ratio and fallback poster/error state before metadata loads.

9. Unsynced done run action label is inconsistent.
   - Evidence: mocked audit expected `Upload to Drive`; UI exposes `Save to Drive`.
   - Fix: choose one label across tests and UI. Recommended: `Upload to Drive`, because it describes the action directly.

### P2: Performance Architecture

10. New Run textarea can jank on long scripts.
    - Cause: every keystroke writes persisted state to `localStorage` and recalculates stats/duration validation.
    - Fix: debounce persisted writes, keep immediate React state in memory, compute word stats once, and remove or surface unused `timeEstimate`.

11. Run detail repeatedly rescans disk.
    - Cause: run page polls assets every 2-4 seconds, and the assets endpoint stats directories, parses files, and recomputes export state.
    - Fix: persist a lightweight run progress/export snapshot; use SSE for changing fields or guarded polling with ETags/version stamps.

12. Runs list gets heavier with history.
    - Cause: `/api/runs` enriches up to 50 rows with worker activity and export state checks.
    - Fix: store derived status in SQLite during pipeline updates, paginate, and compute expensive folder checks on detail pages only.

13. Stock library media work is too eager.
    - Cause: poster images for visible clips can trigger Drive download + FFmpeg poster extraction; first 16 are eager.
    - Fix: lazy-load more aggressively, cap poster generation concurrency, cache posters, and virtualize large clip grids.

14. Polling loops can overlap.
    - Cause: repeated `setInterval` polling has no shared in-flight guard.
    - Fix: create a shared polling helper with aborts, hidden-tab pause, stale-response protection, and backoff.

### P3: UI Consistency And Polish

15. Component patterns drift.
    - Evidence: New Run has its own notice component even though `_action-notice.tsx` exists; tabs, status badges, empty states, and fetch timeout helpers are duplicated.
    - Fix: centralize `Notice`, `StatusBadge`, `SegmentedControl`, `EmptyState`, and `fetchJsonWithTimeout`.

16. Undefined design token.
    - Evidence: `--bg-elev` is used but not defined.
    - Fix: define it in `globals.css` or replace it with an existing surface token.

17. Some internal navigation uses full reloads.
    - Evidence: raw `<a>` and `window.location.href` appear in app pages.
    - Fix: use `Link`/router for internal navigation except OAuth and file/browser handoff actions.

## Recommended Execution Order

1. Stabilize: fix sidebar navigation, `/clips/generate` build, scene chunking test, and legacy route behavior.
2. Make the main flow fast: remove the initial loading swap, fix Hybrid duration auto-selection, debounce script persistence, and make Run states obvious.
3. Unify the UI kit: shared segmented tabs, notices, empty states, status badges, and button labels.
4. Reduce background work: replace polling/disk rescans with stored snapshots and guarded polling.
5. Optimize media-heavy pages: virtualize stock/clip grids, lazy-load posters, and cap FFmpeg/Drive poster generation.
6. Lock it in: keep `npm run lint`, `npm run test`, `npm run build`, `ui-click-audit`, and `ui-run-actions-audit` in CI.

