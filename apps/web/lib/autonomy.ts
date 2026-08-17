/**
 * How much rope a task type has earned, and the one task type that can never
 * earn any.
 *
 * Autonomy is scored per task type from approval history, which is right for
 * actions: an agent that has uploaded a hundred workbooks correctly should stop
 * asking before each one. It is meaningless for a question. `request_decision`
 * exists precisely because the agent cannot proceed without a human, so
 * "approving" one resolves it with no answer and the graph resumes knowing
 * exactly as much as it did when it stopped to ask. Promote it to auto_execute
 * and the agent asks into the void and carries on, which is worse than never
 * having asked — it looks like it consulted someone.
 *
 * On 2026-08-17 `decision_request` sat at 50% and `always_queue`, so nothing had
 * gone wrong yet. Two more approvals would have taken it to 0.8 and
 * queue_if_stakes_gt_7, at which point a low-stakes question stops being shown.
 *
 * The threshold arithmetic lives here too, because it was written out three
 * times — resolve, cron, and the manual override — and a floor added to one of
 * them would have been a floor in name only.
 */

export const AUTONOMY_LEVELS = [
  "always_queue",
  "queue_if_stakes_gt_5",
  "queue_if_stakes_gt_7",
  "auto_execute",
] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** Task types that must always reach a human, whatever their history says. */
const ALWAYS_HUMAN = new Set(["decision_request", "request_decision"]);

export function isQuestionTaskType(taskType: string): boolean {
  return ALWAYS_HUMAN.has((taskType || "").trim());
}

/**
 * The autonomy a task type has earned. `total` is every resolved approval,
 * including edits and rejections.
 */
export function autonomyFor(
  taskType: string,
  score: number,
  total: number,
): AutonomyLevel {
  if (isQuestionTaskType(taskType)) return "always_queue";
  if (score >= 0.95 && total >= 20) return "auto_execute";
  if (score >= 0.8) return "queue_if_stakes_gt_7";
  if (score >= 0.6) return "queue_if_stakes_gt_5";
  return "always_queue";
}

/**
 * A buyer setting the level by hand. Their choice is honoured everywhere except
 * on a question, where every level above always_queue means the same thing —
 * the agent asks and nobody answers.
 */
export function clampManualAutonomy(
  taskType: string,
  requested: AutonomyLevel,
): AutonomyLevel {
  return isQuestionTaskType(taskType) ? "always_queue" : requested;
}
