import type { Operation, Quote } from "@volta/contracts";
import { describe, expect, it } from "vitest";

import { createCentralBrainTools } from "../../src/agent/centralBrain";
import {
  DeterministicAgentAnswerer,
  createOperationalAgent
} from "../../src/agent/operationalAgent";
import {
  MemoryAgentRepository,
  type OrganizationContext
} from "../../src/agent/repository";
import { seedOperation, THURSDAY_PICKUP } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";

const context: OrganizationContext = {
  organizationId: "textiles-pacifico",
  userId: "dispatcher-001"
};
const NOW = "2026-09-01T15:10:00.000Z";

describe("central brain tools", () => {
  it("compares real quotes against the canonical mandate", async () => {
    const operation = quoteRound();
    const repository = new MemoryAgentRepository();
    await repository.syncOperation(context.organizationId, operation);
    const tools = createCentralBrainTools({
      context,
      conversationId: "conversation-001",
      repository,
      getCurrentOperation: () => operation,
      now: () => NOW
    });

    const result = await tool(tools, "compare_quotes").execute({
      operationId: operation.id
    });

    expect(result.output).toEqual([
      expect.objectContaining({
        id: "quote-approved",
        mandateStatus: "APPROVED"
      }),
      expect.objectContaining({
        id: "quote-over-cap",
        mandateStatus: "REQUIRES_ESCALATION",
        mandateReason: "price_cap_exceeded"
      })
    ]);
    expect(result.citations.map((item) => item.sourceId)).toEqual([
      "quote-approved",
      "quote-over-cap"
    ]);
  });

  it("keeps historical reads isolated by organization", async () => {
    const repository = new MemoryAgentRepository();
    const visible = quoteRound();
    const hidden = { ...quoteRound(), id: "operation-secret" };
    await repository.syncOperation(context.organizationId, visible);
    await repository.syncOperation("another-organization", hidden);
    const tools = createCentralBrainTools({
      context,
      conversationId: "conversation-001",
      repository,
      getCurrentOperation: () => visible,
      now: () => NOW
    });

    const result = await tool(tools, "search_operational_records").execute({
      query: "operation",
      operationId: null,
      sourceTypes: null
    });

    expect(result.citations.length).toBeGreaterThan(0);
    expect(
      result.citations.every((item) => item.operationId === visible.id)
    ).toBe(true);
  });

  it("proposes and safely executes a carrier selection", async () => {
    const operation = quoteRound();
    const store = createOperationStore(operation);
    const repository = new MemoryAgentRepository();
    await repository.syncOperation(context.organizationId, operation);
    const conversation = await repository.createConversation(context);
    const tools = createCentralBrainTools({
      context,
      conversationId: conversation.id,
      repository,
      getCurrentOperation: () => store.getOperation(),
      now: () => NOW
    });
    const proposal = await tool(tools, "propose_carrier_selection").execute({
      approvalId: "approval-001",
      selectedQuoteId: "quote-approved",
      rationale: "Within mandate and lowest compliant price."
    });
    const action = proposal.proposedAction;
    expect(action).toMatchObject({
      type: "resolve_carrier_selection",
      status: "pending",
      payload: {
        approvalId: "approval-001",
        selectedQuoteId: "quote-approved"
      }
    });

    const agent = createOperationalAgent({
      repository,
      answerer: new DeterministicAgentAnswerer(),
      getCurrentOperation: () => store.getOperation(),
      executeCloseApprovedDeal: async () => false,
      resolveCarrierSelection: (input) => {
        store.resolveApproval({ ...input, action: "approve" });
        return true;
      },
      now: () => NOW
    });
    const decided = await agent.decideAction(
      context,
      action?.id ?? "missing",
      "approve"
    );

    expect(decided.status).toBe("executed");
    expect(store.getOperation().approvals[0]).toMatchObject({
      status: "approved",
      selectedQuoteId: "quote-approved",
      decidedBy: context.userId
    });
  });

  it("expires a proposal when the active operation changes", async () => {
    const operation = quoteRound();
    const store = createOperationStore(operation);
    const repository = new MemoryAgentRepository();
    await repository.syncOperation(context.organizationId, operation);
    const conversation = await repository.createConversation(context);
    const tools = createCentralBrainTools({
      context,
      conversationId: conversation.id,
      repository,
      getCurrentOperation: () => store.getOperation(),
      now: () => NOW
    });
    const proposal = await tool(tools, "propose_carrier_selection").execute({
      approvalId: "approval-001",
      selectedQuoteId: "quote-approved",
      rationale: null
    });
    store.registerQuote({
      ...operation.quotes[0],
      id: "quote-late",
      priceMxn: 8200
    });
    const agent = createOperationalAgent({
      repository,
      answerer: new DeterministicAgentAnswerer(),
      getCurrentOperation: () => store.getOperation(),
      executeCloseApprovedDeal: async () => false,
      resolveCarrierSelection: () => true,
      now: () => NOW
    });

    const decided = await agent.decideAction(
      context,
      proposal.proposedAction?.id ?? "missing",
      "approve"
    );

    expect(decided).toMatchObject({
      status: "expired",
      failureReason: "operation_changed"
    });
    expect(store.getOperation().approvals[0].status).toBe("pending");
  });
});

function quoteRound(): Operation {
  const operation = seedOperation();
  const quotes: Quote[] = [
    {
      id: "quote-approved",
      carrierId: "carrier-ruta-occidente",
      carrierName: "Ruta Occidente",
      priceMxn: 8500,
      etaMinutes: 75,
      pickupTime: THURSDAY_PICKUP,
      callId: "call-approved",
      createdAt: "2026-09-01T15:00:00.000Z"
    },
    {
      id: "quote-over-cap",
      carrierId: "carrier-costa-pacifico",
      carrierName: "Transportes Costa Pacífico",
      priceMxn: 9500,
      etaMinutes: 65,
      pickupTime: THURSDAY_PICKUP,
      callId: "call-over-cap",
      createdAt: "2026-09-01T15:01:00.000Z"
    }
  ];
  return {
    ...operation,
    status: "awaiting_approval",
    quotes,
    approvals: [
      {
        id: "approval-001",
        operationId: operation.id,
        type: "carrier_selection",
        status: "pending",
        quoteIds: quotes.map((quote) => quote.id),
        recommendedQuoteId: "quote-approved",
        createdAt: "2026-09-01T15:02:00.000Z"
      }
    ]
  };
}

function tool(
  tools: ReturnType<typeof createCentralBrainTools>,
  name: ReturnType<typeof createCentralBrainTools>[number]["name"]
) {
  const selected = tools.find((item) => item.name === name);
  if (!selected) throw new Error(`Missing tool: ${name}`);
  return selected;
}
