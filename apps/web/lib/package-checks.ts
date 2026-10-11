import type JSZip from "jszip";

const USES_GRAPH = /\bgraph_fn\b/;

/**
 * Refuse a package whose code reaches Microsoft 365 without saying what for.
 *
 * graphScopes is what tells a buyer what an agent reaches, and what decides
 * whether it can be hired on Email only — where it gets no Microsoft 365 access
 * at all. An agent that calls graph_fn but declares nothing would be listed as
 * working on Email only and then fail there at the first call. Undeclared is
 * still accepted for code that never touches Graph: nothing to declare.
 *
 * Returns the problem in words for the creator, or null.
 */
export async function undeclaredGraphUse(
  zip: JSZip,
  manifest: Record<string, unknown>,
): Promise<string | null> {
  if (Array.isArray(manifest.graphScopes)) return null;
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir || !name.endsWith(".py")) continue;
    const text = await entry.async("string");
    if (USES_GRAPH.test(text)) {
      return (
        `${name} uses graph_fn, but marketplace.json declares no graphScopes. Declare what ` +
        `the agent reaches in the buyer's Microsoft 365 — for example ` +
        `"graphScopes": ["files.read", "files.write"] — so buyers can see it and it is ` +
        `offered on the right hire tier. Agents that only need email declare ["mail.send"].`
      );
    }
  }
  return null;
}
