/**
 * An upload's blob path depends on what is in the package.
 *
 * Re-running the fingerprint is cheap; the property it protects is not. See the
 * comment on storeExtractedPackage for the run this came from.
 */
import assert from "node:assert";
import { packageFingerprint } from "../apps/web/lib/package-storage.ts";

let passed = 0;
function check(name, fn) {
  fn();
  console.log(`ok   ${name}`);
  passed++;
}

const pkg = (entries) =>
  new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v, "utf8")]));

const BASE = pkg({
  "agent.py": "llm = ChatOpenAI(model=os.environ['LLM_MODEL'])\n",
  "marketplace.json": '{"slug":"action-items"}',
});

check("the same package fingerprints the same", () => {
  assert.strictEqual(packageFingerprint(BASE), packageFingerprint(pkg({
    "agent.py": "llm = ChatOpenAI(model=os.environ['LLM_MODEL'])\n",
    "marketplace.json": '{"slug":"action-items"}',
  })));
});

check("changing a byte of code changes the path", () => {
  // The case that mattered: one line of agent.py corrected, everything else
  // identical, same version number.
  const fixed = pkg({
    "agent.py": "llm = StructuredLLM(model=os.environ['LLM_MODEL'])\n",
    "marketplace.json": '{"slug":"action-items"}',
  });
  assert.notStrictEqual(packageFingerprint(BASE), packageFingerprint(fixed));
});

check("adding a file changes the path", () => {
  const extra = pkg({
    "agent.py": "llm = ChatOpenAI(model=os.environ['LLM_MODEL'])\n",
    "marketplace.json": '{"slug":"action-items"}',
    "requirements.txt": "langchain-openai\n",
  });
  assert.notStrictEqual(packageFingerprint(BASE), packageFingerprint(extra));
});

check("renaming a file changes the path", () => {
  // Same bytes, different name: the package is not the same package.
  const a = pkg({ "agent.py": "x", "b.py": "y" });
  const b = pkg({ "agent.py": "y", "b.py": "x" });
  assert.notStrictEqual(packageFingerprint(a), packageFingerprint(b));
});

check("insertion order does not change the path", () => {
  // Zip readers do not promise an order, and an upload that fingerprinted
  // differently for the same files would defeat the dedupe.
  const a = new Map([["a.py", Buffer.from("1")], ["b.py", Buffer.from("2")]]);
  const b = new Map([["b.py", Buffer.from("2")], ["a.py", Buffer.from("1")]]);
  assert.strictEqual(packageFingerprint(a), packageFingerprint(b));
});

check("a path separator difference does not change the path", () => {
  // The upload normalises backslashes; the fingerprint must agree, or a zip
  // built on Windows would store under a different prefix than the same
  // package built anywhere else.
  const win = new Map([["onboarding\\questions.json", Buffer.from("{}")]]);
  const posix = new Map([["onboarding/questions.json", Buffer.from("{}")]]);
  assert.strictEqual(packageFingerprint(win), packageFingerprint(posix));
});

check("the fingerprint is short enough to live in a path", () => {
  const fp = packageFingerprint(BASE);
  assert.match(fp, /^[0-9a-f]{12}$/);
});

console.log(`\n${passed} checks passed`);
