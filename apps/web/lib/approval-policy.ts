/**
 * Push a changed approval policy into a running agent container.
 *
 * Both callers — the settings route and the onboarding route — used to POST
 * `deployment.containerName` directly. That value is "http://localhost:32793":
 * an address that means the VPS the container runs on. These routes run on
 * Vercel, where localhost is Vercel's own loopback and nothing is listening, so
 * the request could never arrive. Both wrapped it in `.catch(() => {})`, so the
 * failure was invisible: the policy was written to the database, the settings
 * page reported success, and the running agent kept enforcing the old rule
 * until it was next provisioned.
 *
 * Which way that fails matters. A buyer moving from "never ask" to "always ask"
 * — the direction people take after something goes wrong — was told the change
 * had been applied while the agent carried on acting unsupervised.
 *
 * The provisioning service can reach the container and this app cannot, so the
 * push goes through it, the same way approval resolutions already do. The
 * return value says whether the agent actually picked it up; it is not a
 * throw, because the database write is still valid and still takes effect at
 * the next provision.
 */

const PROVISIONING_URL =
  process.env.PROVISIONING_SERVICE_URL ||
  process.env.PROVISIONING_URL ||
  "https://api.agentstore.it.com";
const PROVISIONING_SECRET = process.env.PROVISIONING_SECRET || "";

export async function pushApprovalPolicy(
  containerName: string,
  policy: Record<string, unknown>,
): Promise<boolean> {
  if (!containerName || Object.keys(policy).length === 0) return false;

  if (!PROVISIONING_SECRET) {
    console.error(
      "[approval-policy] PROVISIONING_SECRET is not set; cannot reach the " +
        "container. The policy is saved but the running agent still has the old one.",
    );
    return false;
  }

  try {
    const resp = await fetch(`${PROVISIONING_URL}/internal/forward-policy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PROVISIONING_SECRET}`,
      },
      body: JSON.stringify({ containerName, policy }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(
        `[approval-policy] Container refused the update (${resp.status}): ${detail.slice(0, 300)}. ` +
          "Saved to the database; the running agent still has the old policy.",
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[approval-policy] Could not reach the provisioning service: ${
        err instanceof Error ? err.message : String(err)
      }. Saved to the database; the running agent still has the old policy.`,
    );
    return false;
  }
}
