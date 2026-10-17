/**
 * Platform-owned regression tasks, run against every new version in vetting.
 *
 * Not the golden-task gate removed on 2026-08-21. That one read tasks from the
 * creator's own package, so a creator could pick three inputs the agent handles
 * and hide the ones it fails. These are written by the platform, kept here and
 * never in a package, and grow from real failures: the first set is the
 * 2026-10-17 client-style email battery, where 4 of 7 Route Planner tasks lost a
 * stop to an inline depot. An agent with no file here is vetted as before.
 *
 * Each task is an email body sent through /internal/run-sync; the reply must
 * contain every `expect` string (case-insensitive; "1,984,000" matches
 * "1984000").
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface RegressionTask {
  name: string;
  input: string;
  expect: string[];
  /** Strings the reply must NOT contain - a known wrong answer. */
  reject?: string[];
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "regression");

export function regressionTasksFor(slug: string): RegressionTask[] {
  const file = join(DIR, `${slug}.json`);
  if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(file)) return [];
  const tasks = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(tasks) ? tasks : [];
}

/** Lower-cased, with digit-group separators removed ("1,984,000" -> "1984000"). */
export function normaliseAnswer(text: string): string {
  return String(text || "").toLowerCase().replace(/(\d)[,\s](?=\d{3}\b)/g, "$1");
}

/** Known-wrong strings present in a reply. */
export function rejectedIn(reply: string, reject: string[] = []): string[] {
  const have = normaliseAnswer(reply);
  return reject.filter((r) => have.includes(normaliseAnswer(r)));
}

/** The expected strings missing from a reply. */
export function missingFrom(reply: string, expect: string[]): string[] {
  const have = normaliseAnswer(reply);
  return expect.filter((e) => !have.includes(normaliseAnswer(e)));
}
