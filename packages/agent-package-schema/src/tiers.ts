/**
 * Which hire tiers an agent can be hired on, and what connecting adds.
 *
 * The two tiers, in the vocabulary the manifest already uses for onboarding
 * questions:
 *   "platform"   Email only. The agent's mailbox is on the platform; work
 *                arrives as email and replies go out through the platform. It
 *                gets no Microsoft Graph credential at all, so the only scope it
 *                can honour is sending as itself.
 *   "buyer_org"  Connected. The agent lives in the buyer's Microsoft 365 and can
 *                reach what it declares in graphScopes.
 *
 * A creator says which with `hireTiers`. Left out, it is derived: an agent that
 * declares any scope beyond mail.send is taken to need the connected tier,
 * because that is the safe reading — one that also works by email, and only does
 * more when connected, says so with ["platform", "buyer_org"]. An agent that
 * never declared graphScopes predates the field and keeps working on both.
 */
import { GRAPH_SCOPES, type GraphScope } from "./types.js";

export const HIRE_TIERS = ["platform", "buyer_org"] as const;
export type HireTier = (typeof HIRE_TIERS)[number];

/** The scopes an agent on the email tier can actually use. */
export const EMAIL_TIER_SCOPES: readonly GraphScope[] = ["mail.send"];

type ManifestLike = { graphScopes?: unknown; hireTiers?: unknown } | null | undefined;

function declaredScopes(manifest: unknown): GraphScope[] {
  const raw = (manifest as ManifestLike)?.graphScopes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is GraphScope => (GRAPH_SCOPES as readonly string[]).includes(s as string));
}

/** The declared scopes that only the connected tier provides. */
export function orgOnlyScopes(manifest: unknown): GraphScope[] {
  return declaredScopes(manifest).filter((s) => !EMAIL_TIER_SCOPES.includes(s));
}

/** The tiers a buyer may hire this agent on: declared, or derived from its scopes. */
export function supportedTiers(manifest: unknown): HireTier[] {
  const raw = (manifest as ManifestLike)?.hireTiers;
  if (Array.isArray(raw)) {
    const tiers = HIRE_TIERS.filter((t) => raw.includes(t));
    if (tiers.length > 0) return tiers;
  }
  return orgOnlyScopes(manifest).length > 0 ? ["buyer_org"] : ["platform", "buyer_org"];
}

/** True when the agent cannot be hired on Email only. */
export function requiresOrgTier(manifest: unknown): boolean {
  return !supportedTiers(manifest).includes("platform");
}

/** Problems with a manifest's `hireTiers`, for validation. Empty when fine or absent. */
export function hireTiersProblems(manifest: unknown): string[] {
  const raw = (manifest as ManifestLike)?.hireTiers;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return ['hireTiers must be a non-empty list: ["platform"], ["buyer_org"] or both'];
  }
  const unknown = raw.filter((t) => !(HIRE_TIERS as readonly unknown[]).includes(t));
  return unknown.length
    ? [`hireTiers has unknown value(s) ${unknown.map(String).join(", ")} — use "platform" (Email only) and/or "buyer_org" (Connect Microsoft 365)`]
    : [];
}
