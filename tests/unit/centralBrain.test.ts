import type { Operation, Quote } from "@volta/contracts";
import { describe, expect, it } from "vitest";

import { createCentralBrainTools } from "../../src/agent/centralBrain";
import {
  DeterministicAgentAnswerer,
  createResponsesToolDefinitions,
  createOperationalAgent,
  responseOutputAsInput
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
  it("exports strict Responses schemas with every property required", () => {
    const operation = quoteRound();
    const tools = createCentralBrainTools({
      context,
      conversationId: "conversation-001",
      repository: new MemoryAgentRepository(),
      getCurrentOperation: () => operation,
      now: () => NOW
    });

    expect(() => createResponsesToolDefinitions(tools)).not.toThrow();
    for (const definition of createResponsesToolDefinitions(tools)) {
      const parameters = definition.parameters as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(new Set(parameters.required)).toEqual(
        new Set(Object.keys(parameters.properties ?? {}))
      );
    }
  });

  it("removes SDK-only parsed arguments before the next Responses request", () => {
    const input = responseOutputAsInput([
      {
        type: "function_call",
        arguments: '{"operationId":null}',
        call_id: "call-001",
        name: "list_attention_items",
        parsed_arguments: { operationId: null },
        status: "completed"
      }
    ]);

    expect(input).toEqual([
      {
        type: "function_call",
        arguments: '{"operationId":null}',
        call_id: "call-001",
        name: "list_attention_items",
        status: "completed"
      }
    ]);
    expect(input[0]).not.toHaveProperty("parsed_arguments");
  });

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
      executeCreateMandate: async () => false,
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
      executeCreateMandate: async () => false,
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

  it("proposes a complete mandate and executes it only after approval", async () => {
    const operation = quoteRound();
    const repository = new MemoryAgentRepository();
    await repository.syncOperation(context.organizationId, operation);
    const conversation = await repository.createConversation(context);
    await repository.appendMessage(context, {
      id: "message-budget-confirmed",
      conversationId: conversation.id,
      role: "user",
      content: "Confirmo un presupuesto máximo de 40000000 MXN.",
      citations: [],
      proposedActions: [],
      createdAt: NOW
    });
    const tools = createCentralBrainTools({
      context,
      conversationId: conversation.id,
      repository,
      getCurrentOperation: () => operation,
      now: () => NOW
    });
    const mandate = {
      budget_cap: 40000000,
      destination_datetime: "2026-09-01T17:00:00-05:00",
      destination_place: "Calle 87B #6-10, Medellín",
      type_of_content: "Carga general no frágil",
      weight: 20000,
      measures: "Contenedor de 20 pies",
      pickup_address: "Sociedad Portuaria de Santa Marta",
      pickup_datetime: "2026-08-31T08:00:00-05:00"
    };

    const proposal = await tool(tools, "propose_create_mandate").execute(
      mandate
    );
    expect(proposal.proposedAction).toMatchObject({
      type: "create_mandate",
      status: "pending",
      payload: mandate
    });

    let executedPayload: typeof mandate | undefined;
    const agent = createOperationalAgent({
      repository,
      answerer: new DeterministicAgentAnswerer(),
      getCurrentOperation: () => operation,
      executeCreateMandate: async (input) => {
        executedPayload = input;
        return true;
      },
      executeCloseApprovedDeal: async () => false,
      resolveCarrierSelection: () => false,
      now: () => NOW
    });
    const decided = await agent.decideAction(
      context,
      proposal.proposedAction?.id ?? "missing",
      "approve"
    );

    expect(decided.status).toBe("executed");
    expect(executedPayload).toEqual(mandate);
  });

  it("rejects a model-invented minimum budget without user evidence", async () => {
    const operation = quoteRound();
    const repository = new MemoryAgentRepository();
    const conversation = await repository.createConversation(context);
    await repository.appendMessage(context, {
      id: "message-without-budget",
      conversationId: conversation.id,
      role: "user",
      content:
        "Mueve mañana el contenedor de Santa Marta a Medellín; todavía no te he dado presupuesto.",
      citations: [],
      proposedActions: [],
      createdAt: NOW
    });
    const tools = createCentralBrainTools({
      context,
      conversationId: conversation.id,
      repository,
      getCurrentOperation: () => operation,
      now: () => NOW
    });

    const result = await tool(tools, "propose_create_mandate").execute({
      budget_cap: 1,
      destination_datetime: "2026-09-01T17:00:00-05:00",
      destination_place: "Medellín",
      type_of_content: "Carga general",
      weight: 40000,
      measures: "20 m x 20 m x 10 m",
      pickup_address: "Puerto de Santa Marta",
      pickup_datetime: "2026-08-31T08:00:00-05:00"
    });

    expect(result.output).toMatchObject({ error: "budget_not_confirmed" });
    expect(result.proposedAction).toBeUndefined();
  });

  it("rejects ambiguous or inverted mandate dates before proposing", async () => {
    const operation = quoteRound();
    const repository = new MemoryAgentRepository();
    const tools = createCentralBrainTools({
      context,
      conversationId: "conversation-001",
      repository,
      getCurrentOperation: () => operation,
      now: () => NOW
    });

    const result = await tool(tools, "propose_create_mandate").execute({
      budget_cap: 40000000,
      destination_datetime: "2026-08-31T07:00:00-05:00",
      destination_place: "Medellín",
      type_of_content: "Carga general",
      weight: 20000,
      measures: "20 pies",
      pickup_address: "Santa Marta",
      pickup_datetime: "2026-08-31T08:00:00-05:00"
    });

    expect(result.output).toEqual({ error: "invalid_arguments" });
    expect(result.proposedAction).toBeUndefined();
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
