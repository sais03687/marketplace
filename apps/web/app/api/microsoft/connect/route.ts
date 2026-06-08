import { NextResponse } from "next/server";
import { requireOrg, jsonError } from "@/lib/api-utils";

const MS_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || "";

export async function GET(request: Request) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;

  if (!MS_CLIENT_ID) {
    return jsonError("Microsoft integration not configured", 500);
  }

  // The hire wizard passes ?returnTo=/browse/agent-slug/hire so the callback
  // can redirect back after consent.
  const { searchParams } = new URL(request.url);
  const returnTo = searchParams.get("returnTo") || "/settings";

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.agentstore.it.com";
  const redirectUri = `${appUrl}/api/microsoft/callback`;

  // Encode returnTo in state so the callback can redirect back to the hire wizard
  const state = encodeURIComponent(returnTo);

  const consentUrl = new URL("https://login.microsoftonline.com/common/adminconsent");
  consentUrl.searchParams.set("client_id", MS_CLIENT_ID);
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  consentUrl.searchParams.set("state", state);

  return NextResponse.redirect(consentUrl.toString());
}
