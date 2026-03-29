#!/usr/bin/env npx tsx
/**
 * One-time OAuth helper to get a Google refresh token with calendar scope.
 *
 * Usage:
 *   npx tsx scripts/google-oauth.ts
 *
 * 1. Starts a local HTTP server on port 8000
 * 2. Opens a Google OAuth URL — you authorize in your browser
 * 3. Google redirects back to localhost:8000 with the auth code
 * 4. Script exchanges it for a refresh token and prints it
 *
 * Uses the agent_platform Google Cloud client credentials
 * (redirect URI: http://localhost:8000/oauth/google).
 */

import { createServer } from "node:http";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars are required.");
  console.error("Set them in .env or pass them directly.");
  process.exit(1);
}
const REDIRECT_URI = "http://localhost:8000/oauth/google";
const PORT = 8000;

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

const TOKEN_URL = "https://oauth2.googleapis.com/token";

function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code: string): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data, null, 2)}`);
  }

  return data;
}

async function main() {
  const authUrl = buildAuthUrl();

  console.log("Starting local OAuth callback server on port", PORT);
  console.log("\nOpen this URL in your browser to authorize:\n");
  console.log(authUrl);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (url.pathname !== "/oauth/google") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<h1>OAuth Error</h1><p>${error}</p>`);
      console.error("\nOAuth error:", error);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h1>Missing authorization code</h1>");
      return;
    }

    try {
      const data = await exchangeCode(code);

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Success!</h1><p>Google Calendar authorized. You can close this tab.</p>",
      );

      console.log("\n=== Token Response ===");
      console.log(JSON.stringify(data, null, 2));
      console.log("\n=== Your Refresh Token ===");
      console.log(
        data.refresh_token || "(no refresh_token — did you use prompt=consent?)",
      );
      console.log("\nAdd this to your marketplace/.env as:");
      console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(`<h1>Token Exchange Failed</h1><pre>${err}</pre>`);
      console.error("\n", err);
    }

    server.close();
  });

  server.listen(PORT, () => {
    console.log(`\nWaiting for OAuth callback on http://localhost:${PORT}/oauth/google ...`);
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
