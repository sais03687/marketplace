/**
 * Upload test packages to the marketplace via the real upload API.
 * This uses your Vercel Blob token directly, bypassing auth, for seeding.
 *
 * Run from local: node scripts/upload-test-packages.mjs
 *
 * Requires: BLOB_READ_WRITE_TOKEN and DATABASE_URL in env (from .env.prod or set manually)
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import { put } from "@vercel/blob";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = resolve(__dirname, "../test-packages");

const prisma = new PrismaClient();

const CREATOR_CLERK_ID = process.env.CREATOR_CLERK_ID || "user_3BzJoQgX2xJi9MxFOrHoXfwie8z";
const CREATOR_EMAIL = "sai.suram07@gmail.com";
const CREATOR_NAME = "Sai";

const PACKAGES = [
  { file: "maya-tech-support.zip", slug: "maya-tech-support" },
  { file: "test-custom-langchain.zip", slug: "test-langchain-agent" },
  { file: "test-minimal-custom.zip", slug: "test-minimal-agent" },
];

async function uploadZipToBlob(slug, version, zipBuffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(zipBuffer);
  const prefix = `packages/${slug}/${version}`;

  const uploads = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const content = await entry.async("nodebuffer");
    uploads.push(
      put(`${prefix}/${path}`, content, {
        access: "public",
        addRandomSuffix: false,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      })
    );
  }
  await Promise.all(uploads);
  return `${prefix}/`;
}

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error("ERROR: BLOB_READ_WRITE_TOKEN not set.");
    process.exit(1);
  }

  // Ensure creator exists
  let creator = await prisma.creator.findUnique({ where: { clerkUserId: CREATOR_CLERK_ID } });
  if (!creator) {
    creator = await prisma.creator.create({
      data: { clerkUserId: CREATOR_CLERK_ID, displayName: CREATOR_NAME, email: CREATOR_EMAIL },
    });
  }
  console.log(`Creator: ${creator.displayName} (${creator.id})\n`);

  for (const { file, slug } of PACKAGES) {
    console.log(`Processing ${file}...`);
    const zipBuffer = readFileSync(resolve(PACKAGES_DIR, file));

    // Parse manifest
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(zipBuffer);
    const manifestText = await zip.file("marketplace.json").async("string");
    const manifest = JSON.parse(manifestText);
    const version = manifest.version;

    // Check if agent already exists
    let agent = await prisma.agent.findUnique({ where: { slug } });

    if (!agent) {
      agent = await prisma.$queryRawUnsafe(
        `INSERT INTO "Agent" (id, slug, name, tagline, description, category, "modelTier", "pricePerMonth", runtime, "creatorId", status, "currentVersion", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::\"AgentCategory\", $6::\"ModelTier\", $7, $8::\"AgentRuntime\", $9, 'IN_REVIEW'::"AgentStatus", $10, NOW(), NOW())
         RETURNING id`,
        slug,
        manifest.name,
        manifest.tagline || "",
        manifest.description || manifest.tagline || "",
        manifest.category,
        manifest.modelTier.toUpperCase(),
        manifest.pricePerMonth,
        (manifest.runtime || "custom").toUpperCase(),
        creator.id,
        version,
      );
      agent = { id: agent[0].id, slug };
      console.log(`  Created agent: ${manifest.name}`);

      // Insert capabilities
      if (manifest.capabilities?.length) {
        for (const cap of manifest.capabilities) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "Capability" (id, "agentId", name, description, "createdAt", "updatedAt")
             VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW())`,
            agent.id, cap.name, cap.description
          );
        }
      }
    } else {
      console.log(`  Agent already exists: ${slug}`);
    }

    // Upload files to Vercel Blob
    console.log(`  Uploading files to Vercel Blob...`);
    const storagePath = await uploadZipToBlob(slug, version, zipBuffer);
    console.log(`  Stored at: ${storagePath}`);

    // Check if version exists
    const existingVersion = await prisma.agentVersion.findFirst({
      where: { agentId: agent.id, version },
    });

    if (!existingVersion) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AgentVersion" (id, "agentId", version, "packageUrl", "storagePath", "manifestData", "vetStatus", "publishedAt", "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::jsonb, 'PENDING'::"VetStatus", NULL, NOW())`,
        agent.id,
        version,
        `storage://${slug}/${version}`,
        storagePath,
        JSON.stringify(manifest),
      );
      console.log(`  Created AgentVersion ${version} — vetStatus: PENDING`);
    } else {
      // Update storagePath on existing version
      await prisma.$executeRawUnsafe(
        `UPDATE "AgentVersion" SET "storagePath"=$1 WHERE id=$2`,
        storagePath,
        existingVersion.id,
      );
      console.log(`  Updated storagePath on existing version`);
    }

    console.log(`  ✓ ${slug} ready for vetting\n`);
  }

  console.log("All packages uploaded. Check /admin/vetting to review.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
