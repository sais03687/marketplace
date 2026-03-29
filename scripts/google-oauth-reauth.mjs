/**
 * Google OAuth Authorization Script
 *
 * Uses the "installed" (desktop) OAuth client from ai-employee project.
 * Starts a local server to catch the redirect, exchanges for refresh token.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars are required.");
  process.exit(1);
}
const PORT = 9876;
const REDIRECT_URI = `http://localhost:${PORT}`;

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
].join(" ");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("\n=== Google OAuth Authorization ===\n");
console.log("Scopes: Calendar, Drive, Sheets, Docs\n");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h1>Failed</h1><p>${error}</p>`);
    console.error("Authorization failed:", error);
    server.close();
    process.exit(1);
  }

  if (code) {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await tokenRes.json();

    if (data.refresh_token) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Success! You can close this tab.</h1>");

      console.log("\n=== SUCCESS ===\n");
      console.log("REFRESH TOKEN:\n");
      console.log(data.refresh_token);
      console.log("\nScopes:", data.scope);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Error - no refresh token</h1><p>" + JSON.stringify(data) + "</p>");
      console.error("No refresh token:", JSON.stringify(data));
    }

    server.close();
    process.exit(0);
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<p>Waiting for OAuth callback...</p>");
});

server.listen(PORT, () => {
  console.log(`Callback server on port ${PORT}\n`);
  console.log("Open this URL in your browser:\n");
  console.log(authUrl.toString());
  console.log("\n(waiting...)\n");
});
