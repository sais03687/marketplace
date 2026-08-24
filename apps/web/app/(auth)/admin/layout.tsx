import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isAdminUser } from "@/lib/api-utils";
import { AdminShell } from "./admin-shell";
import { AdminAccessDenied } from "./access-denied";

/**
 * Gates the whole /admin surface in one place. A non-admin who is logged in sees
 * the access-denied screen rather than any admin page; a logged-out user is sent
 * to sign in (the middleware also protects /admin, this is the second line).
 * Admin membership is the ADMIN_USER_IDS allowlist — see isAdminUser.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) redirect("/");
  if (!isAdminUser(userId)) return <AdminAccessDenied />;

  return <AdminShell>{children}</AdminShell>;
}
