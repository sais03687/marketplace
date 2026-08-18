// Find a benchmark task by id, wherever it was defined.
//
// Tasks had accumulated across emails.json, emails_daily.json, emails_e1.json,
// emails_f1.json and emails_f3.json, each written for one round, and the sender
// that read each one differed too — send_wave.mjs handled a single `attachment`,
// send_f3.mjs handled an `attachments` array, and neither could send the other's
// tasks. Anything reaching for a task goes through here instead.
import fs from "node:fs";
import path from "node:path";

const DIR = "/root/bench";

export function allTasks() {
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!/^emails.*\.json$/.test(f)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
    } catch {
      continue; // a half-written round file is not a reason to fail every lookup
    }
    for (const t of Array.isArray(parsed) ? parsed : []) {
      if (t && t.id) out.push({ ...t, _file: f });
    }
  }
  return out;
}

export function findTask(id) {
  const hits = allTasks().filter((t) => t.id === id);
  if (!hits.length) {
    const known = [...new Set(allTasks().map((t) => t.id))].sort().join(" ");
    throw new Error(`no such task: ${id}\nknown: ${known}`);
  }
  if (hits.length > 1) {
    // Two rounds reusing one id is silent corruption: the harness would send
    // one task and score the other.
    throw new Error(
      `task ${id} is defined in more than one file: ${hits.map((h) => h._file).join(", ")}`
    );
  }
  return hits[0];
}

// Both shapes, because both exist in the files on disk.
export function attachmentsOf(task) {
  if (Array.isArray(task.attachments)) return task.attachments;
  if (task.attachment) return [task.attachment];
  return [];
}
