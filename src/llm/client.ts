import OpenAI from "openai";

export interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel?: string; // e.g. "moonshot-v1-32k-vision-preview"
  rateLimitRpm: number;
}

export interface LLMResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMUsageTracker {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  navigationCalls: number;
  enrichmentCalls: number;
  visionCalls: number;
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private visionModel: string | null;
  private bucket: TokenBucket;
  private maxRetries = 5;
  private circuitBreakerFailures = 0;
  private circuitBreakerThreshold = 3;
  public usage: LLMUsageTracker = {
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    navigationCalls: 0,
    enrichmentCalls: 0,
    visionCalls: 0,
  };

  constructor(config: LLMConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
    this.visionModel = config.visionModel ?? null;
    this.bucket = new TokenBucket(config.rateLimitRpm);
  }

  async chat(
    messages: OpenAI.ChatCompletionMessageParam[],
    purpose: "navigation" | "enrichment",
  ): Promise<LLMResponse | null> {
    if (this.circuitBreakerFailures >= this.circuitBreakerThreshold) {
      return null;
    }

    await this.bucket.waitForToken();

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages,
          temperature: 0.1,
        });

        this.circuitBreakerFailures = 0;
        const result: LLMResponse = {
          content: response.choices[0]?.message?.content || "",
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        };

        this.usage.totalCalls++;
        this.usage.totalInputTokens += result.inputTokens;
        this.usage.totalOutputTokens += result.outputTokens;
        if (purpose === "navigation") this.usage.navigationCalls++;
        else this.usage.enrichmentCalls++;

        return result;
      } catch {
        const waitMs = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    this.circuitBreakerFailures++;
    return null;
  }

  /** Chat using vision model (for screenshot analysis). Falls back to null if no vision model configured. */
  async chatVision(
    messages: OpenAI.ChatCompletionMessageParam[],
  ): Promise<LLMResponse | null> {
    if (!this.visionModel) return null;
    if (this.circuitBreakerFailures >= this.circuitBreakerThreshold) return null;

    await this.bucket.waitForToken();

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.visionModel,
          messages,
          temperature: 0.1,
          max_tokens: 500,
        });

        this.circuitBreakerFailures = 0;
        const result: LLMResponse = {
          content: response.choices[0]?.message?.content || "",
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        };

        this.usage.totalCalls++;
        this.usage.totalInputTokens += result.inputTokens;
        this.usage.totalOutputTokens += result.outputTokens;
        this.usage.enrichmentCalls++;

        return result;
      } catch {
        const waitMs = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    this.circuitBreakerFailures++;
    return null;
  }

  async chatVisionBatch(
    messages: OpenAI.ChatCompletionMessageParam[],
    maxTokens = 1500,
  ): Promise<LLMResponse | null> {
    if (this.circuitBreakerFailures >= this.circuitBreakerThreshold) {
      return null;
    }

    await this.bucket.waitForToken();

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.visionModel ?? this.model,
          messages,
          temperature: 0.1,
          max_tokens: maxTokens,
        });

        this.circuitBreakerFailures = 0;
        const result: LLMResponse = {
          content: response.choices[0]?.message?.content || "",
          inputTokens: response.usage?.prompt_tokens || 0,
          outputTokens: response.usage?.completion_tokens || 0,
        };

        this.usage.totalCalls++;
        this.usage.totalInputTokens += result.inputTokens;
        this.usage.totalOutputTokens += result.outputTokens;
        this.usage.visionCalls++;

        return result;
      } catch (err: unknown) {
        const isRateLimit = err instanceof Error && (err.message.includes("429") || err.message.includes("rate"));
        if (isRateLimit && attempt < this.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        this.circuitBreakerFailures++;
        return null;
      }
    }
    return null;
  }

  get hasVision(): boolean {
    return this.visionModel !== null;
  }
}

export class TokenBucket {
  private tokens: number;
  private capacity: number;
  private refillIntervalMs: number;
  private lastRefill: number;

  constructor(rpm: number) {
    this.capacity = rpm;
    this.tokens = rpm;
    this.refillIntervalMs = (60 * 1000) / rpm;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }

  async waitForToken(): Promise<void> {
    while (!this.tryConsume()) {
      await new Promise((r) => setTimeout(r, this.refillIntervalMs));
    }
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Safely extract and parse JSON from LLM freeform text response.
 * Tries to find a JSON object or array in the response.
 */
export function extractJsonFromLlm(text: string): unknown | null {
  try {
    const match = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Build a multimodal user message with text + base64 images.
 */
export function buildMultimodalMessage(
  text: string,
  images: string[], // base64 PNG strings
): OpenAI.ChatCompletionMessageParam {
  const content: OpenAI.ChatCompletionContentPart[] = [
    { type: "text", text },
    ...images.map((b64): OpenAI.ChatCompletionContentPart => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${b64}` },
    })),
  ];
  return { role: "user", content };
}

