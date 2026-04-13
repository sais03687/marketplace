import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const prisma = new PrismaClient();

function readOptionalFile(path: string): string | null {
  if (existsSync(path)) {
    return readFileSync(path, "utf-8");
  }
  return null;
}

function readOptionalJson(path: string): unknown | null {
  const content = readOptionalFile(path);
  if (content) {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return null;
}

async function main() {
  console.log("Seeding database...");

  // Read marketplace.json from v5 agent package
  const manifestPath = join(
    __dirname,
    "..",
    "agents",
    "v5-agent-package",
    "marketplace.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  // Read onboarding files
  const onboardingDir = join(__dirname, "..", "agents", "v5-agent-package", "onboarding");
  const onboardingQuestions = readOptionalJson(join(onboardingDir, "questions.json"));
  const memoryTemplate = readOptionalFile(join(onboardingDir, "MEMORY_TEMPLATE.md"));

  // Create or find a seed creator
  const creator = await prisma.creator.upsert({
    where: { email: "creator@marketplace.dev" },
    update: {},
    create: {
      clerkUserId: "seed_creator_001",
      displayName: "Marketplace Team",
      email: "creator@marketplace.dev",
    },
  });

  console.log(`Creator: ${creator.displayName} (${creator.id})`);

  // Upsert the agent
  const agent = await prisma.agent.upsert({
    where: { slug: manifest.slug },
    update: {
      name: manifest.name,
      tagline: manifest.tagline,
      description: manifest.description,
      category: manifest.category,
      pricePerMonth: manifest.pricePerMonth,
      modelTier: manifest.modelTier.toUpperCase(),
      currentVersion: manifest.version,
      status: "LIVE",
      onboardingQuestions: onboardingQuestions ?? undefined,
      memoryTemplate: memoryTemplate ?? undefined,
    },
    create: {
      slug: manifest.slug,
      name: manifest.name,
      tagline: manifest.tagline,
      description: manifest.description,
      category: manifest.category,
      pricePerMonth: manifest.pricePerMonth,
      modelTier: manifest.modelTier.toUpperCase(),
      creatorId: creator.id,
      currentVersion: manifest.version,
      status: "LIVE",
      onboardingQuestions: onboardingQuestions ?? undefined,
      memoryTemplate: memoryTemplate ?? undefined,
    },
  });

  console.log(`Agent: ${agent.name} (${agent.slug})`);

  // Delete existing capabilities and re-create
  await prisma.capability.deleteMany({ where: { agentId: agent.id } });
  for (const cap of manifest.capabilities) {
    await prisma.capability.create({
      data: {
        agentId: agent.id,
        name: cap.name,
        description: cap.description,
      },
    });
  }

  console.log(`Created ${manifest.capabilities.length} capabilities`);

  // Create agent version
  await prisma.agentVersion.upsert({
    where: {
      id: `${agent.id}_${manifest.version}`,
    },
    update: {
      version: manifest.version,
      vetStatus: "MANUALLY_APPROVED",
      publishedAt: new Date(),
    },
    create: {
      agentId: agent.id,
      version: manifest.version,
      packageUrl: "local://agents/v5-agent-package",
      vetStatus: "MANUALLY_APPROVED",
      publishedAt: new Date(),
    },
  });

  console.log(`Version ${manifest.version} created`);

  // ─── Seed LangChain Starter (custom runtime) ─────────────────────────────

  const lcManifestPath = join(
    __dirname,
    "..",
    "agents",
    "langchain-starter",
    "marketplace.json",
  );

  if (existsSync(lcManifestPath)) {
    const lcManifest = JSON.parse(readFileSync(lcManifestPath, "utf-8"));

    // Read onboarding files for langchain-starter
    const lcOnboardingDir = join(__dirname, "..", "agents", "langchain-starter", "onboarding");
    const lcOnboardingQuestions = readOptionalJson(join(lcOnboardingDir, "questions.json"));
    const lcMemoryTemplate = readOptionalFile(join(lcOnboardingDir, "MEMORY_TEMPLATE.md"));

    const lcAgent = await prisma.agent.upsert({
      where: { slug: lcManifest.slug },
      update: {
        name: lcManifest.name,
        tagline: lcManifest.tagline,
        description: lcManifest.description,
        category: lcManifest.category,
        pricePerMonth: lcManifest.pricePerMonth,
        modelTier: lcManifest.modelTier.toUpperCase(),
        currentVersion: lcManifest.version,
        runtime: "CUSTOM",
        status: "LIVE",
        onboardingQuestions: lcOnboardingQuestions ?? undefined,
        memoryTemplate: lcMemoryTemplate ?? undefined,
      },
      create: {
        slug: lcManifest.slug,
        name: lcManifest.name,
        tagline: lcManifest.tagline,
        description: lcManifest.description,
        category: lcManifest.category,
        pricePerMonth: lcManifest.pricePerMonth,
        modelTier: lcManifest.modelTier.toUpperCase(),
        creatorId: creator.id,
        currentVersion: lcManifest.version,
        runtime: "CUSTOM",
        status: "LIVE",
        onboardingQuestions: lcOnboardingQuestions ?? undefined,
        memoryTemplate: lcMemoryTemplate ?? undefined,
      },
    });

    console.log(`Agent: ${lcAgent.name} (${lcAgent.slug}) [custom runtime]`);

    // Capabilities
    await prisma.capability.deleteMany({ where: { agentId: lcAgent.id } });
    for (const cap of lcManifest.capabilities) {
      await prisma.capability.create({
        data: {
          agentId: lcAgent.id,
          name: cap.name,
          description: cap.description,
        },
      });
    }

    console.log(`Created ${lcManifest.capabilities.length} capabilities for ${lcAgent.slug}`);

    // Version
    await prisma.agentVersion.upsert({
      where: {
        id: `${lcAgent.id}_${lcManifest.version}`,
      },
      update: {
        version: lcManifest.version,
        vetStatus: "MANUALLY_APPROVED",
        publishedAt: new Date(),
      },
      create: {
        agentId: lcAgent.id,
        version: lcManifest.version,
        packageUrl: "local://agents/langchain-starter",
        vetStatus: "MANUALLY_APPROVED",
        publishedAt: new Date(),
      },
    });

    console.log(`Version ${lcManifest.version} created for ${lcAgent.slug}`);
  } else {
    console.log("Skipping langchain-starter seed (marketplace.json not found)");
  }

  console.log("Seed complete!");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
