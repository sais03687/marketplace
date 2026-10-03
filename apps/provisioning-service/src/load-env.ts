/**
 * Load the service's env file before anything reads process.env.
 *
 * pm2's ecosystem config carried `env_file: "/opt/marketplace/.env.prod"`, which
 * pm2 does not support — it is Docker Compose syntax, silently ignored. So the
 * service only ever had whatever env the shell that started pm2 happened to
 * hold, and a restart from a plain shell dropped the rest.
 *
 * Found on 2026-10-03: the live process was missing LLM_BROKER_ENABLED, so new
 * agents would have been handed the platform's real model key instead of a
 * broker token, and VET_LLM_API_KEY, so reviewers could not test an agent's
 * real answers. Both were sitting correctly in .env.prod the whole time.
 *
 * Reading the file here means it cannot matter how the process was started.
 * Existing env wins, so a deliberate override on the command line still works,
 * and a missing file is fine — that is the normal case in development.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let done = false;

export function loadEnvFile(): void {
  if (done) return;
  done = true;

  const candidates = [
    process.env.ENV_FILE,
    resolve(process.cwd(), "../../.env.prod"),
    resolve(process.cwd(), "../../.env"),
  ].filter((p): p is string => Boolean(p));

  const path = candidates.find((p) => existsSync(p));
  if (!path) return;

  let loaded = 0;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    console.warn(`[env] could not read ${path}:`, err);
    return;
  }

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue; // a value already set wins
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loaded += 1;
  }

  // Names only. The point is to make a missing variable obvious in the log
  // without putting a secret in it.
  console.log(`[env] loaded ${loaded} variable(s) from ${path}`);
}

// Run on import, not on call: ES module imports are hoisted and evaluated
// before any statement in the importing module, so a function call placed at
// the top of index.ts would still run after config.ts had read process.env.
// Importing this module first is what makes the ordering true.
loadEnvFile();
