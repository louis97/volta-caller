import { randomUUID } from "node:crypto";
import type {
  AgentActivity,
  AgentConversation,
  AgentMessage,
  CreateMandateRequest,
  EvidenceCitation,
  Operation,
  ProposedAction
} from "@volta/contracts";
import OpenAI from "openai";
import { zodResponsesFunction, zodTextFormat } from "openai/helpers/zod";
import type {
  ParsedResponseOutputItem,
  ResponseInput,
  ResponseInputItem
} from "openai/resources/responses/responses";
import { z } from "zod";

import { createCentralBrainTools, type CentralBrainTool } from "./centralBrain";
import {
  type AgentRepository,
  type OrganizationContext,
  operationVersion
} from "./repository";

const groundedAnswerSchema = z.object({
  answer: z.string().min(1),
  citationIds: z.array(z.string()).max(12)
});

export const CENTRAL_BRAIN_INSTRUCTIONS = [
  "Eres Volta, el central brain operacional de una empresa de logística.",
  "Responde en el idioma de la pregunta y usa exclusivamente hechos devueltos por las tools.",
  "Antes de responder una pregunta factual, llama una o más tools de lectura.",
  "No inventes ubicación, estado, llamadas, negociaciones ni acciones.",
  "Cuando un dato no exista, dilo de forma directa.",
  "Cada afirmación factual debe respaldarse con los IDs de evidencia exactos.",
  "Las tools propose_* solo preparan acciones; nunca digas que una acción fue ejecutada.",
  "Cuando el usuario esté creando un mandato, recoge exactamente estos ocho campos del contrato CreateMandateRequest: presupuesto máximo en MXN, fecha y hora de entrega, lugar de entrega, tipo de contenido, peso en kg, medidas, dirección de recolección, y fecha y hora de recolección.",
  "Para un mandato no exijas BL, booking, DO, liberación, naviera, NIT, contactos, slot, seguro, devolución de vacío ni datos adicionales; esos datos no forman parte del contrato vigente.",
  "Conserva los valores ya confirmados en el historial y pregunta solo por campos faltantes o ambiguos, máximo tres por respuesta. Nunca repitas una pregunta ya resuelta.",
  "No conviertas monedas silenciosamente. budget_cap solo acepta MXN: si el usuario da USD u otra moneda, pide el tope en MXN o una autorización explícita con la tasa que debe usarse.",
  "Convierte expresiones relativas como hoy, mañana o pasado mañana a fechas exactas usando la fecha actual provista. Si no se indica otra zona horaria, usa America/Bogota (-05:00). Confirma cualquier ambigüedad antes de proponer.",
  "Si los ocho campos están completos, explícitos y sin ambigüedad, llama propose_create_mandate con fechas ISO 8601 con zona, peso en kg y presupuesto en MXN. Explica que queda pendiente de aprobación humana en Volta; no afirmes que se creó ni que se pidieron cotizaciones hasta que la acción se ejecute.",
  "Sé concreto y útil para un dispatcher."
].join("\n");

export const MAX_CONVERSATION_HISTORY = 20;

export type GroundedAnswer = z.infer<typeof groundedAnswerSchema> & {
  evidence: EvidenceCitation[];
  proposedActions: ProposedAction[];
};

export type AnswerRequest = {
  question: string;
  history: AgentMessage[];
  currentOperation: Operation;
  currentDateTime: string;
  tools: CentralBrainTool[];
  onActivity?: (activity: AgentActivity) => void;
};

export type AgentAnswerer = {
  answer(request: AnswerRequest): Promise<GroundedAnswer>;
};

export function createResponsesToolDefinitions(tools: CentralBrainTool[]) {
  return tools.map((tool) =>
    zodResponsesFunction({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    })
  );
}

export function responseOutputAsInput(
  output: ParsedResponseOutputItem<unknown>[]
): ResponseInputItem[] {
  return output.map((item) => {
    if (item.type !== "function_call") return item as ResponseInputItem;
    return {
      type: item.type,
      arguments: item.arguments,
      call_id: item.call_id,
      name: item.name,
      ...(item.id !== undefined ? { id: item.id } : {}),
      ...(item.caller !== undefined ? { caller: item.caller } : {}),
      ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
      ...(item.status !== undefined ? { status: item.status } : {})
    };
  });
}

export class OpenAIAgentAnswerer implements AgentAnswerer {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async answer(request: AnswerRequest): Promise<GroundedAnswer> {
    const definitions = createResponsesToolDefinitions(request.tools);
    let input: ResponseInput = request.history
      .slice(-MAX_CONVERSATION_HISTORY)
      .map((message) => ({
        role: message.role,
        content: message.content
      }));
    const evidence: EvidenceCitation[] = [];
    const proposedActions: ProposedAction[] = [];
    let toolCalls = 0;
    let allowTools = true;

    for (let round = 0; round < 8; round += 1) {
      const response = await this.client.responses.parse({
        model: this.model,
        store: false,
        include: ["reasoning.encrypted_content"],
        instructions: `${CENTRAL_BRAIN_INSTRUCTIONS}\nFecha y hora actual del servidor: ${request.currentDateTime}.`,
        input,
        parallel_tool_calls: false,
        tool_choice: allowTools ? "auto" : "none",
        tools: allowTools ? definitions : [],
        text: { format: zodTextFormat(groundedAnswerSchema, "grounded_answer") }
      });
      const calls = response.output.filter(
        (item) => item.type === "function_call"
      );
      if (calls.length === 0) {
        if (!response.output_parsed)
          throw new Error("agent_answer_unparseable");
        return {
          ...response.output_parsed,
          evidence: uniqueEvidence(evidence),
          proposedActions: uniqueActions(proposedActions)
        };
      }

      const outputs: ResponseInputItem[] = [];
      for (const call of calls) {
        const tool = request.tools.find((item) => item.name === call.name);
        if (!tool || toolCalls >= 6) {
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ error: "tool_budget_exhausted" })
          });
          allowTools = false;
          continue;
        }
        toolCalls += 1;
        request.onActivity?.(tool.activity);
        const argumentsValue = call.parsed_arguments;
        const result = await tool.execute(argumentsValue);
        evidence.push(...result.citations);
        if (result.proposedAction) proposedActions.push(result.proposedAction);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result.output)
        });
      }
      if (toolCalls >= 6) allowTools = false;
      input = [...input, ...responseOutputAsInput(response.output), ...outputs];
    }
    throw new Error("agent_tool_loop_exhausted");
  }
}

export class DeterministicAgentAnswerer implements AgentAnswerer {
  async answer(request: AnswerRequest): Promise<GroundedAnswer> {
    const evidence: EvidenceCitation[] = [];
    const proposedActions: ProposedAction[] = [];
    const execute = async (
      name: CentralBrainTool["name"],
      argumentsValue: unknown
    ) => {
      const tool = request.tools.find((item) => item.name === name);
      if (!tool) return undefined;
      request.onActivity?.(tool.activity);
      const result = await tool.execute(argumentsValue);
      evidence.push(...result.citations);
      if (result.proposedAction) proposedActions.push(result.proposedAction);
      return result.output;
    };

    await execute("search_operational_records", {
      query: request.question,
      operationId: null,
      sourceTypes: null
    });
    if (
      /(pendiente|atenci[oó]n|attention|bloque|triage|prioridad|qu[eé] pasa|needs me)/i.test(
        request.question
      )
    ) {
      await execute("list_attention_items", { operationId: null });
    }
    if (
      /(cotiz|quote|carrier|transportista|oferta|compar)/i.test(
        request.question
      )
    ) {
      await execute("compare_quotes", {
        operationId: request.currentOperation.id
      });
    }
    if (
      /(selecciona|resuelve|autoriza|prepara la selecci[oó]n)/i.test(
        request.question
      )
    ) {
      const approval = request.currentOperation.approvals.find(
        (item) => item.type === "carrier_selection" && item.status === "pending"
      );
      const selectedQuoteId =
        approval?.recommendedQuoteId ??
        request.currentOperation.quotes
          .filter((quote) => approval?.quoteIds.includes(quote.id))
          .sort((left, right) => left.priceMxn - right.priceMxn)[0]?.id;
      if (approval && selectedQuoteId) {
        await execute("propose_carrier_selection", {
          approvalId: approval.id,
          selectedQuoteId,
          rationale: "Mejor opción disponible en la ronda registrada."
        });
      }
    }
    if (
      /(cerrar|cierra|confirmar|confirma|ejecutar|ejecuta|call back|closing call)/i.test(
        request.question
      )
    ) {
      await execute("propose_close_approved_deal", {});
    }

    const selected = uniqueEvidence(evidence).slice(0, 4);
    return {
      answer:
        selected.length === 0
          ? "No encontré información autoritativa para responder esa pregunta."
          : selected.map((item) => item.excerpt).join(" "),
      citationIds: selected.map((item) => item.id),
      evidence: uniqueEvidence(evidence),
      proposedActions: uniqueActions(proposedActions)
    };
  }
}

export class UnavailableAgentAnswerer implements AgentAnswerer {
  async answer(): Promise<GroundedAnswer> {
    throw new Error("agent_model_unavailable");
  }
}

export type OperationalAgentDependencies = {
  repository: AgentRepository;
  answerer: AgentAnswerer;
  getCurrentOperation(): Operation;
  executeCreateMandate(
    input: CreateMandateRequest,
    context: OrganizationContext
  ): Promise<boolean>;
  executeCloseApprovedDeal(): Promise<boolean>;
  resolveCarrierSelection(input: {
    approvalId: string;
    selectedQuoteId: string;
    decidedBy: string;
    decidedAt: string;
  }): Promise<boolean> | boolean;
  now?: () => string;
};

export function createOperationalAgent({
  repository,
  answerer,
  getCurrentOperation,
  executeCreateMandate,
  executeCloseApprovedDeal,
  resolveCarrierSelection,
  now = () => new Date().toISOString()
}: OperationalAgentDependencies) {
  async function sync(context: OrganizationContext) {
    const operation = getCurrentOperation();
    await repository.syncOperation(context.organizationId, operation);
    return operation;
  }

  return {
    createConversation(context: OrganizationContext, title?: string) {
      return repository.createConversation({ ...context, title });
    },

    getConversation(context: OrganizationContext, conversationId: string) {
      return repository.getConversation(context, conversationId);
    },

    listConversations(context: OrganizationContext) {
      return repository.listConversations(context);
    },

    renameConversation(
      context: OrganizationContext,
      conversationId: string,
      title: string
    ) {
      return repository.renameConversation(context, conversationId, title);
    },

    deleteConversation(context: OrganizationContext, conversationId: string) {
      return repository.deleteConversation(context, conversationId);
    },

    async recordChannelMessage(
      context: OrganizationContext,
      conversationId: string,
      role: "assistant" | "user",
      content: string
    ) {
      const message: AgentMessage = {
        id: randomUUID(),
        conversationId,
        role,
        content,
        citations: [],
        proposedActions: [],
        createdAt: now()
      };
      await repository.appendMessage(context, message);
      return message;
    },

    async ask(
      context: OrganizationContext,
      conversationId: string,
      question: string,
      onActivity?: (activity: AgentActivity) => void
    ): Promise<AgentMessage> {
      const conversation = await repository.getConversation(
        context,
        conversationId
      );
      if (!conversation) throw new Error("conversation_not_found");
      const operation = await sync(context);
      const createdAt = now();
      const userMessage: AgentMessage = {
        id: randomUUID(),
        conversationId,
        role: "user",
        content: question,
        citations: [],
        proposedActions: [],
        createdAt
      };
      await repository.appendMessage(context, userMessage);

      const tools = createCentralBrainTools({
        context,
        conversationId,
        repository,
        getCurrentOperation,
        now
      });
      const rawAnswer = await answerer.answer({
        question,
        history: [...conversation.messages, userMessage],
        currentOperation: operation,
        currentDateTime: createdAt,
        tools,
        onActivity
      });
      onActivity?.({ stage: "answering", label: "Preparing the answer" });
      const citations = validateCitations(
        rawAnswer.citationIds,
        rawAnswer.evidence
      );
      const assistantMessage: AgentMessage = {
        id: randomUUID(),
        conversationId,
        role: "assistant",
        content: rawAnswer.answer,
        citations,
        proposedActions: rawAnswer.proposedActions,
        createdAt: now()
      };
      await repository.appendMessage(context, assistantMessage);
      return assistantMessage;
    },

    async decideAction(
      context: OrganizationContext,
      actionId: string,
      decision: "approve" | "decline"
    ): Promise<ProposedAction> {
      const action = await repository.getAction(context, actionId);
      if (!action) throw new Error("agent_action_not_found");
      if (action.status !== "pending")
        throw new Error("agent_action_not_pending");
      const decidedAt = now();
      if (decision === "decline") {
        const declined: ProposedAction = {
          ...action,
          status: "declined",
          decidedBy: context.userId,
          decidedAt
        };
        await repository.updateAction(declined);
        return declined;
      }

      const operation = await sync(context);
      if (
        operation.id !== action.operationId ||
        operationVersion(operation) !== action.expectedOperationVersion
      ) {
        const expired: ProposedAction = {
          ...action,
          status: "expired",
          decidedBy: context.userId,
          decidedAt,
          failureReason: "operation_changed"
        };
        await repository.updateAction(expired);
        return expired;
      }

      const approved: ProposedAction = {
        ...action,
        status: "approved",
        decidedBy: context.userId,
        decidedAt
      };
      await repository.updateAction(approved);
      try {
        const executed =
          approved.type === "create_mandate"
            ? await executeCreateMandate(approved.payload, context)
            : approved.type === "close_approved_deal"
              ? await executeCloseApprovedDeal()
              : await resolveCarrierSelection({
                  approvalId: approved.payload.approvalId,
                  selectedQuoteId: approved.payload.selectedQuoteId,
                  decidedBy: context.userId,
                  decidedAt
                });
        const result: ProposedAction = {
          ...approved,
          status: executed ? "executed" : "failed",
          executedAt: now(),
          failureReason: executed ? undefined : "action_preconditions_failed"
        };
        await repository.updateAction(result);
        await sync(context);
        return result;
      } catch {
        const failed: ProposedAction = {
          ...approved,
          status: "failed",
          executedAt: now(),
          failureReason: "execution_failed"
        };
        await repository.updateAction(failed);
        return failed;
      }
    }
  };
}

function validateCitations(ids: string[], evidence: EvidenceCitation[]) {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const valid = [...new Set(ids)].flatMap((id) => {
    const citation = byId.get(id);
    return citation ? [citation] : [];
  });
  if (valid.length > 0 || evidence.length === 0) return valid;
  return evidence.slice(0, 3);
}

function uniqueEvidence(evidence: EvidenceCitation[]) {
  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}

function uniqueActions(actions: ProposedAction[]) {
  return [...new Map(actions.map((item) => [item.id, item])).values()];
}

export type OperationalAgent = ReturnType<typeof createOperationalAgent>;

export function conversationTitle(question: string) {
  const cleaned = question.trim().replace(/\s+/g, " ");
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}…` : cleaned;
}

export function serializeConversation(conversation: AgentConversation) {
  return structuredClone(conversation);
}
