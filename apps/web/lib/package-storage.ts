import { put, list, head } from "@vercel/blob";
import { createHash } from "node:crypto";

const PREFIX = "packages";

/**
 * A short digest of everything in the package: names and bytes.
 *
 * It makes the upload path depend on the content, so re-uploading the same
 * version with different code cannot land on the same URL as the last attempt.
 */
export function packageFingerprint(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const relativePath of Array.from(files.keys()).sort()) {
    h.update(relativePath.replace(/\\/g, "/"));
    h.update("\0");
    h.update(files.get(relativePath)!);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * Upload all files from an extracted agent package to Vercel Blob.
 * Returns the blob prefix used as storagePath in the DB, e.g.:
 *   "packages/langchain-ops/1.0.0/9f2c1ab30e44/"
 *
 * The last segment is a digest of the package's contents. Without it every
 * upload of a given version wrote over the previous one at the same public
 * URL, and those URLs are served from a CDN: on 2026-09-21 a corrected package
 * was uploaded and the vetting run that started moments later downloaded the
 * PREVIOUS code, then reported a traceback from a line the new package does not
 * contain, plus a secret finding nothing in it matches. Re-running minutes
 * later passed 5/5 on the identical upload.
 *
 * Both directions of that are wrong, and the second is worse than a confusing
 * report: a package whose new code fails could be vetted as the old code that
 * passed, and approved on it. Content-addressed paths mean a URL never changes
 * meaning, so nothing cached under it can be stale.
 */
export async function storeExtractedPackage(
  slug: string,
  version: string,
  files: Map<string, Buffer>,
): Promise<string> {
  const prefix = `${PREFIX}/${slug}/${version}/${packageFingerprint(files)}`;

  await Promise.all(
    Array.from(files.entries()).map(([relativePath, content]) => {
      // Normalize Windows-style backslash separators to forward slashes so
      // blob keys are always consistent regardless of the OS that created
      // the zip archive.
      const normalizedPath = relativePath.replace(/\\/g, "/");
      return put(`${prefix}/${normalizedPath}`, content, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
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
