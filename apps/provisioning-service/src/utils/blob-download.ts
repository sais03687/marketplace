/**
 * Downloads a Vercel Blob package prefix into a local temp directory
 * so OpenClaw / Docker can use it as a regular filesystem path.
 *
 * Blob paths look like "packages/{slug}/{version}/"
 * The BLOB_BASE_URL env var points to the public blob store root,
 * e.g. "https://abc.public.blob.vercel-storage.com"
 *
 * Files are publicly accessible, so no auth token is needed here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const BLOB_BASE_URL = (process.env.BLOB_BASE_URL || "").replace(/\/$/, "");

export function isBlobStoragePath(storagePath: string): boolean {
  return storagePath.startsWith("packages/");
}

/**
 * Given a blob prefix like "packages/langchain-ops/1.0.0/", fetches
 * the file listing via the Vercel Blob list API, then downloads every
 * file into a fresh temp directory.
 *
 * Returns the temp directory path. Caller is responsible for cleanup.
 */
export async function downloadBlobPackage(storagePath: string): Promise<string> {
  if (!BLOB_BASE_URL) {
    throw new Error(
      "BLOB_BASE_URL is not set — cannot download package from blob storage. " +
      "Set it to your Vercel Blob store URL (e.g. https://abc.public.blob.vercel-storage.com)",
    );
  }

  // List files under the prefix via Vercel Blob's list API.
  // We need BLOB_READ_WRITE_TOKEN for the list endpoint even though
  // individual files are publicly readable.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not set — needed to list blob files");
  }

  const listUrl = `https://blob.vercel-storage.com?prefix=${encodeURIComponent(storagePath)}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!listRes.ok) {
    throw new Error(`Blob list failed (${listRes.status}): ${await listRes.text()}`);
  }

  const { blobs } = (await listRes.json()) as {
    blobs: Array<{ pathname: string; url: string }>;
  };

  if (blobs.length === 0) {
    throw new Error(`No files found in blob storage at prefix: ${storagePath}`);
  }

  // Create a unique temp directory for this download
  const tmpDir = join(tmpdir(), `agent-pkg-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Download all files in parallel
  await Promise.all(
    blobs.map(async ({ pathname, url }) => {
      const relativePath = pathname.slice(storagePath.length);
      if (!relativePath) return; // skip the prefix itself

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to download ${pathname} (${res.status})`);
      }

      const destPath = join(tmpDir, relativePath);
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
    }),
  );

  return tmpDir;
}
