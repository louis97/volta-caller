import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

const extractionSchema = z.object({
  finalPriceMxn: z.number().nonnegative().nullable(),
  currency: z.literal("MXN").nullable(),
  agreedAt: z.string().datetime({ offset: true }).nullable(),
  summary: z.string().min(1).max(500).nullable()
});

export type QuoteExtractionResult = z.infer<typeof extractionSchema>;

export class OpenAIQuoteExtractor {
  private readonly client: OpenAI;
  constructor(
    apiKey: string,
    private readonly model: string
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async extract(transcript: string): Promise<QuoteExtractionResult> {
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      instructions:
        "Extract only a clearly agreed final carrier price in MXN and its exact ISO transcript timestamp. If no final agreement exists, return null fields and a concise factual summary. Never infer values.",
      input: transcript,
      text: { format: zodTextFormat(extractionSchema, "quote_extraction") }
    });
    if (!response.output_parsed)
      throw new Error("quote_extraction_unparseable");
    return response.output_parsed;
  }
}
