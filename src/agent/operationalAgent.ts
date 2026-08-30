import { randomUUID } from "node:crypto";
import type {
  AgentConversation,
  AgentMessage,
  EvidenceCitation,
  Operation,
  ProposedAction
} from "@volta/contracts";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  type AgentRepository,
  type OrganizationContext,
  operationVersion
} from "./repository";

const groundedAnswerSchema = z.object({
  answer: z.string().min(1),
  citationIds: z.array(z.string()).max(12)
});

export type GroundedAnswer = z.infer<typeof groundedAnswerSchema>;

export type AnswerRequest = {
  question: string;
  evidence: EvidenceCitation[];
  history: AgentMessage[];
};

export type AgentAnswerer = {
  answer(request: AnswerRequest): Promise<GroundedAnswer>;
};

export class OpenAIAgentAnswerer implements AgentAnswerer {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async answer(request: AnswerRequest) {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      instructions: [
        "Eres Volta, el asistente operacional de una empresa de logística.",
        "Responde en el idioma de la pregunta y usa exclusivamente la evidencia suministrada.",
        "No inventes ubicación, estado, llamadas, negociaciones ni acciones.",
        "Cuando un dato no exista, dilo de forma directa.",
        "Cada afirmación factual debe respaldarse con los IDs de evidencia exactos.",
        "No afirmes que ejecutaste acciones; las acciones requieren aprobación humana por separado.",
        "Sé concreto y útil para un dispatcher."
      ].join("\n"),
      input: JSON.stringify({
        question: request.question,
        recentHistory: request.history.slice(-8).map(({ role, content }) => ({
          role,
          content
        })),
        evidence: request.evidence.map((item) => ({
          id: item.id,
          title: item.title,
          excerpt: item.excerpt,
          occurredAt: item.occurredAt
        }))
      }),
      text: { format: zodTextFormat(groundedAnswerSchema, "grounded_answer") }
    });
    if (!response.output_parsed) throw new Error("agent_answer_unparseable");
    return response.output_parsed;
  }
}

export class DeterministicAgentAnswerer implements AgentAnswerer {
  async answer(request: AnswerRequest): Promise<GroundedAnswer> {
    if (request.evidence.length === 0) {
      return {
        answer:
          "No encontré información autoritativa para responder esa pregunta.",
        citationIds: []
      };
    }
    const selected = request.evidence.slice(0, 4);
    return {
      answer: selected.map((item) => item.excerpt).join(" "),
      citationIds: selected.map((item) => item.id)
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
  executeCloseApprovedDeal(): Promise<boolean>;
  now?: () => string;
};

export function createOperationalAgent({
  repository,
  answerer,
  getCurrentOperation,
  executeCloseApprovedDeal,
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

    async ask(
      context: OrganizationContext,
      conversationId: string,
      question: string
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

      const evidence = await repository.searchEvidence(context, question);
      const rawAnswer = await answerer.answer({
        question,
        evidence,
        history: [...conversation.messages, userMessage]
      });
      const citations = validateCitations(rawAnswer.citationIds, evidence);
      const proposedActions = await proposeActions({
        context,
        conversationId,
        question,
        operation,
        repository,
        now
      });
      const assistantMessage: AgentMessage = {
        id: randomUUID(),
        conversationId,
        role: "assistant",
        content: rawAnswer.answer,
        citations,
        proposedActions,
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
      if (operationVersion(operation) !== action.expectedOperationVersion) {
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
        const executed = await executeCloseApprovedDeal();
        const result: ProposedAction = {
          ...approved,
          status: executed ? "executed" : "failed",
          executedAt: now(),
          failureReason: executed ? undefined : "closing_authorization_required"
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

async function proposeActions(input: {
  context: OrganizationContext;
  conversationId: string;
  question: string;
  operation: Operation;
  repository: AgentRepository;
  now: () => string;
}) {
  const requestsClosing =
    /(cerrar|cierra|confirmar|confirma|ejecutar|ejecuta|call back|closing call)/i.test(
      input.question
    );
  if (
    !requestsClosing ||
    !input.operation.closingAuthorization ||
    input.operation.commitment
  ) {
    return [];
  }
  const action: ProposedAction = {
    id: randomUUID(),
    organizationId: input.context.organizationId,
    conversationId: input.conversationId,
    operationId: input.operation.id,
    type: "close_approved_deal",
    status: "pending",
    summary: "Realizar la llamada de cierre con los términos ya autorizados.",
    expectedOperationVersion: operationVersion(input.operation),
    requestedBy: input.context.userId,
    createdAt: input.now()
  };
  await input.repository.saveAction(action);
  return [action];
}

export type OperationalAgent = ReturnType<typeof createOperationalAgent>;

export function conversationTitle(question: string) {
  const cleaned = question.trim().replace(/\s+/g, " ");
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}…` : cleaned;
}

export function serializeConversation(conversation: AgentConversation) {
  return structuredClone(conversation);
}
