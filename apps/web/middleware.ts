import { NextResponse } from "next/server";

// Clerk auth temporarily disabled — dev instance only works on localhost.
// Re-enable once a custom domain is configured in Clerk production instance.
export default function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip static files and Next.js internals
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
