import type { CallBrief } from "@volta/contracts";

export type CallBriefInput = CallBrief;

export function createCallBrief(input: CallBriefInput): CallBrief {
  return structuredClone(input);
}
