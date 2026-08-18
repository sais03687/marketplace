// Print a task's subject verbatim, so the harness never retypes it.
// Matching is a plain substring downstream, which is why nothing is escaped
// here: a subject with "(" in it is not a regex, and treating it as one is a bug
// waiting for the first task whose title has a bracket.
import { findTask } from "./tasks.mjs";

try {
  process.stdout.write(findTask(process.argv[2]).subject);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
