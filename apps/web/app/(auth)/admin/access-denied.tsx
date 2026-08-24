import Link from "next/link";
import { ShieldAlert } from "lucide-react";

/**
 * Shown when a logged-in user who is not an admin lands on any /admin page.
 * The admin surface is gated in the layout, so this covers every admin page at
 * once — vetting, creator requests, AgentMind.
 */
export function AdminAccessDenied() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <ShieldAlert className="h-12 w-12 text-muted-foreground" />
      <h1 className="text-2xl font-bold">You don&apos;t have access to this page</h1>
      <p className="max-w-md text-muted-foreground">
        The admin area is restricted. If you think you should have access, contact the platform
        administrator.
      </p>
      <Link href="/" className="mt-2 text-sm font-medium text-primary underline">
        Go back home
      </Link>
    </div>
  );
}
