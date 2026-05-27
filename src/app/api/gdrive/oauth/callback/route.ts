import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { exchangeCodeForTokens, oauthRedirectUri } from "@/lib/services/gdrive";

/**
 * Second leg of OAuth: Google redirects the user here with `?code=...` after
 * consent. We swap the code for tokens, persist refresh_token + email, then
 * redirect back to /settings with a status banner.
 */
export async function GET(req: Request) {
  ensureInit();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const origin = url.origin;

  if (error) {
    return NextResponse.redirect(
      `${origin}/settings?gdrive=error&reason=${encodeURIComponent(error)}`
    );
  }
  if (!code) {
    return NextResponse.redirect(`${origin}/settings?gdrive=error&reason=missing_code`);
  }

  try {
    // Must reuse the SAME redirect_uri the start leg sent, or Google rejects it.
    await exchangeCodeForTokens(code, oauthRedirectUri(req));
    return NextResponse.redirect(`${origin}/settings?gdrive=connected`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(
      `${origin}/settings?gdrive=error&reason=${encodeURIComponent(msg)}`
    );
  }
}
