import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/creator(.*)",
  "/admin(.*)",
]);

// These routes authenticate with their own mechanism (CRON_SECRET, etc.)
// and must NOT be protected by Clerk — their Bearer tokens are not Clerk JWTs.
const isInternalRoute = createRouteMatcher([
  "/api/cron/(.*)",
  "/api/webhooks/(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isInternalRoute(req)) return; // bypass Clerk for internal routes
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip static files and Next.js internals
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
