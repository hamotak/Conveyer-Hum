/**
 * Proof for the Google OAuth redirect-URI port fix (Prompt 2).
 *
 *   node scripts/audit-tests/oauth-redirect.test.ts
 *
 * Tests the dependency-free redirect-URI derivation that BOTH OAuth legs use.
 * The start route does `buildAuthUrl(oauthRedirectUri(req))` and the callback
 * does `exchangeCodeForTokens(code, oauthRedirectUri(req))`, and googleapis'
 * generateAuthUrl embeds that string verbatim as `redirect_uri` — so proving
 * oauthRedirectUri here proves the Location the start route emits. No DB, no
 * network, no secrets.
 */
let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

delete process.env.APP_ORIGIN;
delete process.env.NEXT_PUBLIC_APP_ORIGIN;

const { oauthRedirectUri } = await import("../../src/lib/services/gdrive-redirect.ts");

const reqAt = (origin: string) =>
  new Request(`${origin}/api/gdrive/oauth/start`, { headers: { host: origin.replace(/^https?:\/\//, "") } });

console.log("Test 1 — redirect URI follows the live request origin:");
check(
  "port 3002 → redirect_uri=http://localhost:3002/api/gdrive/oauth/callback",
  oauthRedirectUri(reqAt("http://localhost:3002")) === "http://localhost:3002/api/gdrive/oauth/callback"
);
check(
  "default :3000 still works",
  oauthRedirectUri(reqAt("http://localhost:3000")) === "http://localhost:3000/api/gdrive/oauth/callback"
);
check(
  "x-forwarded-host + proto win (behind a proxy)",
  oauthRedirectUri(
    new Request("http://internal:3000/x", {
      headers: { host: "internal:3000", "x-forwarded-host": "hum.example.com", "x-forwarded-proto": "https" },
    })
  ) === "https://hum.example.com/api/gdrive/oauth/callback"
);

console.log("Test 2 — APP_ORIGIN env override wins when set:");
process.env.APP_ORIGIN = "https://fixed.example.com/";
check(
  "override ignores request origin and trims the trailing slash",
  oauthRedirectUri(reqAt("http://localhost:3002")) === "https://fixed.example.com/api/gdrive/oauth/callback"
);
delete process.env.APP_ORIGIN;
process.env.NEXT_PUBLIC_APP_ORIGIN = "http://localhost:4000";
check(
  "NEXT_PUBLIC_APP_ORIGIN is also honored",
  oauthRedirectUri(reqAt("http://localhost:3002")) === "http://localhost:4000/api/gdrive/oauth/callback"
);
delete process.env.NEXT_PUBLIC_APP_ORIGIN;

console.log("Test 3 — no stale hardcoded :3000:");
check(
  "a :3002 request never yields a :3000 callback",
  !oauthRedirectUri(reqAt("http://localhost:3002")).includes("3000")
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
