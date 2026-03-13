import { randomUUID } from "crypto";
import type { SpanRecord, SpanStatus } from "../types/pipeline";

export class Span {
  readonly spanId = randomUUID();
  readonly startedAt = new Date();
  private endedAt: Date | null = null;
  private status: SpanStatus = "ok";
  private errorMessage: string | null = null;
  private meta: Record<string, unknown> = {};

  constructor(
    readonly auditId: string,
    readonly traceId: string,
    readonly name: string,
    readonly parentSpanId: string | null = null,
  ) {}

  setMeta(data: Record<string, unknown>): this {
    Object.assign(this.meta, data);
    return this;
  }

  end(status: SpanStatus = "ok", error?: string): this {
    this.endedAt = new Date();
    this.status = status;
    this.errorMessage = error ?? null;
    return this;
  }

  toRecord(): SpanRecord {
    return {
      auditId: this.auditId,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      status: this.status,
      errorMessage: this.errorMessage,
      metadata: { ...this.meta },
    };
  }
}

type PersistFn = (spans: SpanRecord[]) => Promise<void>;

export class AuditTracer {
  readonly traceId = randomUUID();
  private spans: Span[] = [];

  constructor(
    readonly auditId: string,
    private readonly persistFn: PersistFn,
  ) {}

  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parent?: string,
  ): Promise<T> {
    const span = new Span(this.auditId, this.traceId, name, parent ?? null);
    this.spans.push(span);
    try {
      const result = await fn(span);
      span.end("ok");
      return result;
    } catch (err) {
      span.end("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async flush(): Promise<void> {
    if (this.spans.length === 0) return;
    await this.persistFn(this.spans.map((s) => s.toRecord()));
    this.spans = [];
  }
}
