import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const agents = await p.agent.findMany({ select: { slug: true, name: true, status: true, runtime: true, modelTier: true, pricePerMonth: true } });
console.log("AGENTS:", JSON.stringify(agents, null, 2));

const creators = await p.creator.findMany({ select: { id: true, displayName: true, email: true } });
console.log("CREATORS:", JSON.stringify(creators, null, 2));

const deployments = await p.deployment.findMany({ select: { id: true, status: true, agentEmail: true, onboardingState: true } });
console.log("DEPLOYMENTS:", JSON.stringify(deployments, null, 2));

const companies = await p.company.findMany({ select: { id: true, name: true } });
console.log("COMPANIES:", JSON.stringify(companies, null, 2));

const versions = await p.agentVersion.findMany({ select: { version: true, vetStatus: true, agentId: true } });
console.log("VERSIONS:", JSON.stringify(versions, null, 2));

await p.$disconnect();
