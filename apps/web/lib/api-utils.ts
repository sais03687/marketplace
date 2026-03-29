import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ZodSchema, ZodError } from "zod";
import { prisma } from "./db";
import type { Company, Deployment, Agent } from "@prisma/client";

type ApiError = { error: NextResponse };

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function jsonSuccess<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export async function parseBody<T>(
  request: Request,
  schema: ZodSchema<T>,
): Promise<{ data: T } | ApiError> {
  try {
    const body = await request.json();
    const data = schema.parse(body);
    return { data };
  } catch (e) {
    if (e instanceof ZodError) {
      return {
        error: NextResponse.json(
          { error: "Validation failed", details: e.errors },
          { status: 400 },
        ),
      };
    }
    return { error: jsonError("Invalid request body", 400) };
  }
}

export function parseSearchParams<T>(
  url: string,
  schema: ZodSchema<T>,
): { data: T } | ApiError {
  const { searchParams } = new URL(url);
  const raw: Record<string, string> = {};
  searchParams.forEach((v, k) => {
    raw[k] = v;
  });
  try {
    const data = schema.parse(raw);
    return { data };
  } catch (e) {
    if (e instanceof ZodError) {
      return {
        error: NextResponse.json(
          { error: "Invalid query parameters", details: e.errors },
          { status: 400 },
        ),
      };
    }
    return { error: jsonError("Invalid query parameters", 400) };
  }
}

export async function requireAuth(): Promise<
  { userId: string; orgId: string | undefined } | ApiError
> {
  const { userId, orgId } = await auth();
  if (!userId) {
    return { error: jsonError("Unauthorized", 401) };
  }
  return { userId, orgId: orgId ?? undefined };
}

export async function requireOrg(): Promise<
  { userId: string; orgId: string; company: Company } | ApiError
> {
  const result = await requireAuth();
  if ("error" in result) return result;

  const { userId, orgId } = result;
  if (!orgId) {
    return { error: jsonError("Organization required", 403) };
  }

  let company = await prisma.company.findUnique({
    where: { clerkOrgId: orgId },
  });

  if (!company) {
    company = await prisma.company.create({
      data: {
        clerkOrgId: orgId,
        name: "My Company",
        domain: "company.com",
      },
    });
  }

  return { userId, orgId, company };
}

export async function requireDeploymentAccess(
  deploymentId: string,
  companyId: string,
): Promise<{ deployment: Deployment & { agent: Agent } } | ApiError> {
  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, companyId },
    include: { agent: true },
  });

  if (!deployment) {
    return { error: jsonError("Deployment not found", 404) };
  }

  return { deployment };
}
