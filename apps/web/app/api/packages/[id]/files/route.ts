import { prisma } from "@/lib/db";
import { isAdminUser, jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { listPackageFiles, readPackageFile } from "@/lib/package-storage";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;

  const version = await prisma.agentVersion.findUnique({
    where: { id },
    select: { storagePath: true, agent: { select: { creator: { select: { clerkUserId: true } } } } },
  });

  // A package is its creator's source code. Reviewers read it to vet it and the
  // creator may read their own; any other signed-in account — another creator,
  // a buyer — gets the same answer as for a version that does not exist.
  const isOwner = version?.agent?.creator?.clerkUserId === authResult.userId;
  if (!version?.storagePath || !(isOwner || isAdminUser(authResult.userId))) {
    return jsonError("Version not found or no stored files", 404);
  }

  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action === "list") {
    const files = await listPackageFiles(version.storagePath);
    return jsonSuccess({ files });
  }

  if (action === "read") {
    const filePath = searchParams.get("path");
    if (!filePath) {
      return jsonError("Missing 'path' query parameter", 400);
    }

    // Sanitise: reject any path that tries to escape the prefix
    if (filePath.includes("..") || filePath.startsWith("/")) {
      return jsonError("Invalid path", 400);
    }

    const content = await readPackageFile(version.storagePath, filePath);
    if (!content) {
      return jsonError("File not found", 404);
    }

    return jsonSuccess({ content: content.toString("utf-8") });
  }

  return jsonError("Invalid action. Use ?action=list or ?action=read&path=...", 400);
}
