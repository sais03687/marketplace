import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tenantId = searchParams.get("tenant");
  const adminConsent = searchParams.get("admin_consent");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.agentstore.it.com";

  if (error) {
    console.error(`[microsoft-callback] Consent denied: ${error} — ${errorDescription}`);
    const returnTo = state ? decodeURIComponent(state) : "/settings";
    return NextResponse.redirect(
      `${appUrl}${returnTo}?microsoft=error&reason=${encodeURIComponent(errorDescription || error)}`,
    );
  }

  if (!tenantId || adminConsent !== "True") {
    const returnTo = state ? decodeURIComponent(state) : "/settings";
    return NextResponse.redirect(`${appUrl}${returnTo}?microsoft=error&reason=invalid_response`);
  }

  // Decode the returnTo path from state and redirect back with the tenantId.
  // The hire wizard reads this from the URL and includes it when creating the deployment.
  const returnTo = state ? decodeURIComponent(state) : "/settings";

  console.log(`[microsoft-callback] Admin consent granted — tenant=${tenantId}, returnTo=${returnTo}`);

  return NextResponse.redirect(
    `${appUrl}${returnTo}?microsoft=connected&microsoftTenantId=${encodeURIComponent(tenantId)}`,
  );
}
