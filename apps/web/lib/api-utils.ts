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
        // Empty, not "company.com". That default was a real registered domain,
        // and Company.domain was being used as an email allowlist — so every
        // auto-created company authorised its agent to start conversations with
        // strangers there. The boundary now reads Company.verifiedDomains.
        domain: "",
      },
    });
  }

  return { userId, orgId, company };
}

/**
 * Is this Clerk user an admin?
 *
 * Admins are an allowlist of Clerk user IDs in the ADMIN_USER_IDS env var
 * (comma-separated). This is used rather than a Clerk role claim because
 * sessionClaims.publicMetadata is empty unless the Clerk session token is
 * customised, so the role check silently failed for everyone — the platform's
 * admin surface was effectively gated on "logged in" alone.
 *
 * Fail-open when UNSET: if ADMIN_USER_IDS is empty, every logged-in user is
 * treated as admin — the pre-existing behaviour, so shipping this cannot lock the
 * operator out before they configure it. Set ADMIN_USER_IDS to activate the lock.
 */
export function isAdminUser(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const raw = process.env.ADMIN_USER_IDS?.trim();
  if (!raw) {
    // Not configured — do not lock anyone out. Announce it so an unconfigured
    // production is visible in the logs rather than silently wide open.
    console.warn("[admin] ADMIN_USER_IDS is not set — admin pages are open to any logged-in user. Set it to lock them down.");
    return true;
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(userId);
}

export async function requireAdmin(): Promise<
  { userId: string } | ApiError
> {
  const result = await requireAuth();
  if ("error" in result) return result;

  const { userId } = result;
  if (!isAdminUser(userId)) {
    return { error: jsonError("Admin access required", 403) };
  }
  return { userId };
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
