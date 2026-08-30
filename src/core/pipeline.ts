import type { Operation, PipelineStage } from "@volta/contracts";

export type { PipelineStage } from "@volta/contracts";

/** The indexed stage is a projection of canonical operation state. */
export function derivePipelineStage(operation: Operation): PipelineStage {
  if (operation.status === "committed") return "committed";
  if (operation.status === "escalated") return "escalated";
  if (operation.status === "failed") return "failed";
  // The branch's selection flow and main's approval flow mean the same thing
  // to the board: work has stopped until a human decides.
  if (
    operation.status === "awaiting_approval" ||
    operation.status === "awaiting_client_selection"
  ) {
    return "awaiting_approval";
  }
  if (
    operation.status === "carrier_selected" ||
    operation.status === "confirming_selected_carrier"
  ) {
    return "closing";
  }
  if (
    operation.status === "selection_expired" ||
    operation.status === "confirmation_failed"
  ) {
    return "failed";
  }
  if (operation.closingAuthorization) return "closing";
  if (operation.quotes.length > 0) return "quoting";
  if (operation.callSessions.length > 0) return "calling";
  return "open";
}
