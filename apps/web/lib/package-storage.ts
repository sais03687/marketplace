import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, dirname, relative } from "path";

const STORAGE_ROOT = join(process.cwd(), "storage", "packages");

export function storeExtractedPackage(
  slug: string,
  version: string,
  files: Map<string, Buffer>,
): string {
  const storagePath = join(STORAGE_ROOT, slug, version);
  mkdirSync(storagePath, { recursive: true });

  for (const [relativePath, content] of files) {
    const fullPath = join(storagePath, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  return `storage/packages/${slug}/${version}/`;
}

export function listPackageFiles(storagePath: string): string[] {
  const root = join(process.cwd(), storagePath);
  if (!existsSync(root)) return [];

  const results: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        results.push(relative(root, full).replace(/\\/g, "/"));
      }
    }
  }

  walk(root);
  return results.sort();
}

export function readPackageFile(
  storagePath: string,
  filename: string,
): Buffer | null {
  const fullPath = join(process.cwd(), storagePath, filename);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath);
}
