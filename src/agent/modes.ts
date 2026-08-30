import {
  confirmationPrompt,
  exceptionPrompt,
  negotiationPrompt
} from "./prompt";
import {
  checkMandateTool,
  confirmSelectedDealTool,
  registerQuoteTool,
  reviewDealTool,
  triggerEscalationTool,
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
