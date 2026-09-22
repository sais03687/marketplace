/**
 * vet-broker.ts — which vetting runs may currently use the LLM broker.
 *
 * Vetting runs creator code we have not reviewed yet, so the sandbox is handed a
 * broker token instead of the real model key (see vet-package.ts). That token is
 * derived, not random, so it stays valid forever once issued — and the creator
 * can read it, because the platform writes it into the container's env as
 * LLM_API_KEY and the vetting report shows them the container's output.
 *
 * So the broker accepts a vet token only while its run is in flight. The job
 * registers the run before starting the container and clears it in the same
 * finally block that removes the container, which makes a token copied out of a
 * report useless by the time the creator could read it.
 *
 * In-memory on purpose: the worker and the broker are the same process
 * (index.ts starts both), and a restart ends every run in flight anyway.
 */

/** Vet deployment ids are minted as `vet-<hex>` by vetPackageJob. */
export function isVetDeploymentId(deploymentId: string): boolean {
  return deploymentId.startsWith("vet-");
}

const activeVetRuns = new Map<string, { model: string }>();

/** Called before the vet container starts. `model` is the package's declared one. */
export function registerVetRun(deploymentId: string, model: string): void {
  activeVetRuns.set(deploymentId, { model });
}

/** Called from the job's cleanup, whether the run passed, failed or threw. */
export function endVetRun(deploymentId: string): void {
  activeVetRuns.delete(deploymentId);
}

export function vetRunActive(deploymentId: string): boolean {
  return activeVetRuns.has(deploymentId);
}

/** The model this run is pinned to, or undefined if the run is not active. */
export function vetRunModel(deploymentId: string): string | undefined {
  return activeVetRuns.get(deploymentId)?.model;
}
