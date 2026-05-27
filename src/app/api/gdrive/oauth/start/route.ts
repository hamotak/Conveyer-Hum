import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { buildAuthUrl, oauthRedirectUri } from "@/lib/services/gdrive";

/**
 * First leg of the Google OAuth dance: build the consent URL and redirect the
 * user's browser to Google. After they grant access, Google redirects them to
 * /api/gdrive/oauth/callback with a one-time code.
 *
 * The redirect_uri is derived from THIS request's origin so it matches the port
 * Next.js actually bound and the URL the Settings page told the user to register.
 */
export async function GET(req: Request) {
  ensureInit();
  try {
    const url = buildAuthUrl(oauthRedirectUri(req));
    return NextResponse.redirect(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
