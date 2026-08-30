import {
  confirmationPrompt,
  createExceptionPrompt,
  exceptionPrompt,
  negotiationPrompt
} from "./prompt";
import type { ExceptionCallContext } from "../core/exceptions";
import {
  checkMandateTool,
  confirmSelectedDealTool,
  getLeverageTool,
  registerQuoteTool,
  notifyDashboardTool,
  recordIncidentTool,
  reviewDealTool,
  triggerEscalationTool,
  updateOperationStatusTool,
  type AgentToolDefinition
} from "./tools";

export type CallMode = "negotiation" | "confirmation" | "exception";

export type ModeConfiguration = {
  instructions: string;
  tools: AgentToolDefinition[];
};

const configurations: Record<CallMode, ModeConfiguration> = {
  negotiation: {
    instructions: negotiationPrompt,
    tools: [
      checkMandateTool,
      // Cross-call leverage only makes sense while a market is open, so it is
      // absent from the confirmation and exception modes by construction.
      getLeverageTool,
      registerQuoteTool,
      reviewDealTool,
      triggerEscalationTool
    ]
  },
  confirmation: {
    instructions: confirmationPrompt,
    tools: [checkMandateTool, confirmSelectedDealTool, triggerEscalationTool]
  },
  exception: {
    instructions: exceptionPrompt,
    tools: []
  }
};

export function createModeConfiguration(mode: CallMode): ModeConfiguration {
  const configuration = configurations[mode];
  return {
    instructions: configuration.instructions,
    tools: [...configuration.tools]
  };
}

export function createExceptionModeConfiguration(
  context: ExceptionCallContext
): ModeConfiguration {
  return {
    instructions: createExceptionPrompt(context),
    tools: [
      recordIncidentTool,
      updateOperationStatusTool,
      notifyDashboardTool,
      triggerEscalationTool
    ]
  };
}
