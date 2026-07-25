import { isEmailAllowed } from "./server.js";

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  if (actual === expected) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} — got ${actual}, expected ${expected}`); }
};

const MANAGER = { managerEmail: "sai@agents.agentstore.it.com", allowedEmails: ["ok@acme.com", "@partner.com"] };
const EMPTY = { managerEmail: "sai@agents.agentstore.it.com", allowedEmails: [] };
const NO_MANAGER = { managerEmail: null, allowedEmails: ["ok@acme.com"] };

console.log("\n-- restriction configured --");
check("exact match allowed", isEmailAllowed("ok@acme.com", MANAGER), true);
check("exact match is case-insensitive", isEmailAllowed("OK@ACME.COM", MANAGER), true);
check("surrounding whitespace tolerated", isEmailAllowed("  ok@acme.com  ", MANAGER), true);
check("domain wildcard allowed", isEmailAllowed("anyone@partner.com", MANAGER), true);
check("manager always allowed", isEmailAllowed("sai@agents.agentstore.it.com", MANAGER), true);
check("unlisted sender DENIED", isEmailAllowed("intruder@evil.com", MANAGER), false);
check("empty email DENIED", isEmailAllowed("", MANAGER), false);
check("unidentified sender DENIED", isEmailAllowed("   ", MANAGER), false);

console.log("\n-- the subtle ones --");
// A naive endsWith() on a bare domain would let evilacme.com through.
check("lookalike domain DENIED", isEmailAllowed("me@evilacme.com", { allowedEmails: ["@acme.com"] }), false);
check("substring of allowed addr DENIED", isEmailAllowed("ok@acme.com.evil.io", MANAGER), false);
check("no manager configured, unlisted DENIED", isEmailAllowed("x@nope.com", NO_MANAGER), false);

console.log("\n-- no restriction configured (empty list = allow all) --");
check("empty list allows anyone", isEmailAllowed("anyone@anywhere.com", EMPTY), true);
check("empty list still denies empty email", isEmailAllowed("", EMPTY), false);

console.log(`\nRESULTS: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
