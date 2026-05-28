import { put, list, head } from "@vercel/blob";

const PREFIX = "packages";

/**
 * Upload all files from an extracted agent package to Vercel Blob.
 * Returns the blob prefix used as storagePath in the DB, e.g.:
 *   "packages/langchain-ops/1.0.0/"
 */
export async function storeExtractedPackage(
  slug: string,
  version: string,
  files: Map<string, Buffer>,
): Promise<string> {
  const prefix = `${PREFIX}/${slug}/${version}`;

  await Promise.all(
    Array.from(files.entries()).map(([relativePath, content]) => {
      // Normalize Windows-style backslash separators to forward slashes so
      // blob keys are always consistent regardless of the OS that created
      // the zip archive.
      const normalizedPath = relativePath.replace(/\\/g, "/");
      return put(`${prefix}/${normalizedPath}`, content, {
        access: "public",
        addRandomSuffix: false,
      });
    }),
  );

  return `${prefix}/`;
}

/**
 * List all files under a blob storagePath prefix.
 * storagePath is e.g. "packages/langchain-ops/1.0.0/"
 */
export async function listPackageFiles(storagePath: string): Promise<string[]> {
  const blobs = await list({ prefix: storagePath });
  return blobs.blobs
    .map((b) => b.pathname.slice(storagePath.length))
    .filter(Boolean)
    .sort();
}

/**
 * Fetch a single file from blob storage.
 * Returns null if the file does not exist.
 */
export async function readPackageFile(
  storagePath: string,
  filename: string,
): Promise<Buffer | null> {
  try {
    // Normalize separators — zips created on Windows use backslashes
    const normalizedFilename = filename.replace(/\\/g, "/");
    // Verify the blob exists first
    const blobInfo = await head(`${storagePath}${normalizedFilename}`);
    if (!blobInfo) return null;

    const res = await fetch(blobInfo.url);
    if (!res.ok) return null;

    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Returns true when a storagePath value is a blob prefix
 * (as opposed to a legacy local relative path).
 */
export function isBlobStoragePath(storagePath: string): boolean {
  return storagePath.startsWith(`${PREFIX}/`);
}
