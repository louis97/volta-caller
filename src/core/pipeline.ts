import type { Operation, PipelineStage } from "@volta/contracts";

export type { PipelineStage } from "@volta/contracts";

/** The indexed stage is a projection of canonical operation state. */
export function derivePipelineStage(operation: Operation): PipelineStage {
  if (operation.status === "committed") return "committed";
  if (operation.status === "escalated") return "escalated";
  if (operation.status === "failed") return "failed";
  if (operation.status === "awaiting_approval") return "awaiting_approval";
  if (operation.closingAuthorization) return "closing";
  if (operation.quotes.length > 0) return "quoting";
  if (operation.callSessions.length > 0) return "calling";
  return "open";
}
