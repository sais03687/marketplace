import { resolve, normalize } from "path";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
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
    select: { storagePath: true },
  });

  if (!version?.storagePath) {
    return jsonError("Version not found or no stored files", 404);
  }

  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action === "list") {
    const files = listPackageFiles(version.storagePath);
    return jsonSuccess({ files });
  }

  if (action === "read") {
    const filePath = searchParams.get("path");
    if (!filePath) {
      return jsonError("Missing 'path' query parameter", 400);
    }

    // Path traversal protection
    const root = resolve(process.cwd(), version.storagePath);
    const target = resolve(root, normalize(filePath));
    if (!target.startsWith(root)) {
      return jsonError("Invalid path", 400);
    }

    const content = readPackageFile(version.storagePath, filePath);
    if (!content) {
      return jsonError("File not found", 404);
    }

    return jsonSuccess({ content: content.toString("utf-8") });
  }

  return jsonError("Invalid action. Use ?action=list or ?action=read&path=...", 400);
}
