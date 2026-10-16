import { runHealthChecks, cachedHealth, isHealthzRequest, type HealthProbes } from "./health.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const healthy = (): HealthProbes => ({
  database: async () => {},
  queue: async () => {},
  diskUsed: async () => 0.46,
  staleAgents: async () => 0,
  agentsWithoutPoller: async () => 0,
});

// Something a real failure might carry, which must never reach the public answer.
const SECRET = "postgres://admin:hunter2@ep-secret-host.neon.tech/db";

console.log("\n-- outcomes --");
{
  const r = await runHealthChecks(healthy());
  check("all healthy -> ok", r.status === "ok" && r.failing.length === 0, JSON.stringify(r));
}
{
  const r = await runHealthChecks({ ...healthy(), diskUsed: async () => 0.85 });
  check("disk at 85% -> down [disk]", r.status === "down" && r.failing.join() === "disk", JSON.stringify(r));
}
{
  const r = await runHealthChecks({ ...healthy(), diskUsed: async () => 0.84 });
  check("disk at 84% -> ok", r.status === "ok", JSON.stringify(r));
}
{
  const r = await runHealthChecks({ ...healthy(), database: async () => { throw new Error(SECRET); } });
  check("database error -> down [database]", r.status === "down" && r.failing.join() === "database", JSON.stringify(r));
}
{
  const r = await runHealthChecks({ ...healthy(), staleAgents: async () => 2 });
  check("stale agents -> down [agents]", r.failing.join() === "agents", JSON.stringify(r));
}
{
  const r = await runHealthChecks({ ...healthy(), agentsWithoutPoller: async () => 1 });
  check("agent without mail reader -> down [mail]", r.failing.join() === "mail", JSON.stringify(r));
}
{
  const t0 = Date.now();
  const r = await runHealthChecks({ ...healthy(), queue: () => new Promise(() => {}) }, 200);
  check("hung queue times out -> down [queue]", r.failing.join() === "queue" && Date.now() - t0 < 1000, JSON.stringify(r));
}
{
  const r = await runHealthChecks({
    database: async () => { throw new Error(SECRET); },
    queue: async () => { throw new Error(SECRET); },
    diskUsed: async () => 0.99,
    staleAgents: async () => 7,
    agentsWithoutPoller: async () => 3,
  });
  check("everything failing -> all five named", r.failing.length === 5, JSON.stringify(r));
}

console.log("\n-- what the public answer may contain --");
{
  const r = await runHealthChecks({
    database: async () => { throw new Error(SECRET); },
    queue: async () => {},
    diskUsed: async () => 0.93,
    staleAgents: async () => 7,
    agentsWithoutPoller: async () => 3,
  });
  const body = JSON.stringify(r);
  check("only status and failing keys", Object.keys(r).sort().join() === "failing,status", body);
  check("no error text", !body.includes("hunter2") && !body.includes("neon.tech"), body);
  check("no numbers at all", !/\d/.test(body), body);
}

console.log("\n-- caching --");
{
  let calls = 0;
  const probes = { ...healthy(), database: async () => { calls++; } };
  const get = cachedHealth(probes, 60_000);
  await get(); await get(); await get();
  check("three requests inside the window -> one check", calls === 1, `calls=${calls}`);
}
{
  let calls = 0;
  const probes = { ...healthy(), database: async () => { calls++; await new Promise((r) => setTimeout(r, 50)); } };
  const get = cachedHealth(probes, 60_000);
  await Promise.all(Array.from({ length: 20 }, () => get()));
  check("20 simultaneous requests -> one check", calls === 1, `calls=${calls}`);
}
{
  let calls = 0;
  const probes = { ...healthy(), database: async () => { calls++; } };
  const get = cachedHealth(probes, 0);
  await get(); await get();
  check("expired cache -> checks again", calls === 2, `calls=${calls}`);
}

console.log("\n-- which requests are the health check --");
check("GET /healthz", isHealthzRequest("GET", "/healthz"));
check("HEAD /healthz (UptimeRobot)", isHealthzRequest("HEAD", "/healthz"));
check("GET /healthz?cachebust=123", isHealthzRequest("GET", "/healthz?cachebust=123"));
check("POST /healthz refused", !isHealthzRequest("POST", "/healthz"));
check("GET /healthz/extra refused", !isHealthzRequest("GET", "/healthz/extra"));
check("GET /health (the locked one) not matched", !isHealthzRequest("GET", "/health"));
check("missing url refused", !isHealthzRequest("GET", undefined));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
