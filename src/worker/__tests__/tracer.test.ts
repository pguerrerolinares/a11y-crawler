import { test, expect, describe, mock } from "bun:test";
import { Span, AuditTracer } from "../tracer";
import type { SpanRecord } from "../../types/pipeline";

describe("Span", () => {
  const auditId = "audit-1";
  const traceId = "trace-1";
  const name = "crawl-page";

  test("creates with required fields", () => {
    const span = new Span(auditId, traceId, name);
    expect(span.auditId).toBe(auditId);
    expect(span.traceId).toBe(traceId);
    expect(span.name).toBe(name);
    expect(span.spanId).toBeTruthy();
    expect(span.startedAt).toBeInstanceOf(Date);
    expect(span.parentSpanId).toBeNull();
  });

  test("end() sets endedAt, status, and error", () => {
    const span = new Span(auditId, traceId, name);
    span.end("error", "something broke");
    const record = span.toRecord();
    expect(record.endedAt).toBeInstanceOf(Date);
    expect(record.status).toBe("error");
    expect(record.errorMessage).toBe("something broke");
  });

  test("setMeta() accumulates metadata", () => {
    const span = new Span(auditId, traceId, name);
    span.setMeta({ url: "https://example.com" });
    span.setMeta({ depth: 2 });
    const record = span.toRecord();
    expect(record.metadata).toEqual({ url: "https://example.com", depth: 2 });
  });

  test("toRecord() returns a SpanRecord", () => {
    const span = new Span(auditId, traceId, name, "parent-1");
    span.setMeta({ foo: "bar" });
    span.end("ok");
    const record = span.toRecord();
    expect(record).toEqual({
      auditId,
      traceId,
      spanId: span.spanId,
      parentSpanId: "parent-1",
      name,
      startedAt: span.startedAt,
      endedAt: expect.any(Date),
      status: "ok",
      errorMessage: null,
      metadata: { foo: "bar" },
    });
  });
});

describe("AuditTracer", () => {
  test("trace() creates span, runs fn, and ends on success", async () => {
    const persisted: SpanRecord[][] = [];
    const persistFn = async (spans: SpanRecord[]) => {
      persisted.push(spans);
    };
    const tracer = new AuditTracer("audit-1", persistFn);

    const result = await tracer.trace("test-op", async (span) => {
      span.setMeta({ key: "value" });
      return 42;
    });

    expect(result).toBe(42);
    await tracer.flush();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toHaveLength(1);
    const record = persisted[0][0];
    expect(record.name).toBe("test-op");
    expect(record.status).toBe("ok");
    expect(record.endedAt).toBeInstanceOf(Date);
    expect(record.metadata).toEqual({ key: "value" });
  });

  test("trace() ends span with error on throw and re-throws", async () => {
    const persisted: SpanRecord[][] = [];
    const persistFn = async (spans: SpanRecord[]) => {
      persisted.push(spans);
    };
    const tracer = new AuditTracer("audit-1", persistFn);

    await expect(
      tracer.trace("fail-op", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await tracer.flush();
    expect(persisted[0][0].status).toBe("error");
    expect(persisted[0][0].errorMessage).toBe("boom");
  });

  test("flush() calls persistFn with span records and clears buffer", async () => {
    const persistFn = mock(async (_spans: SpanRecord[]) => {});
    const tracer = new AuditTracer("audit-1", persistFn);

    await tracer.trace("op-1", async () => "a");
    await tracer.trace("op-2", async () => "b");
    await tracer.flush();

    expect(persistFn).toHaveBeenCalledTimes(1);
    const calls = persistFn.mock.calls;
    expect(calls[0][0]).toHaveLength(2);
  });

  test("second flush() is a no-op", async () => {
    const persistFn = mock(async (_spans: SpanRecord[]) => {});
    const tracer = new AuditTracer("audit-1", persistFn);

    await tracer.trace("op-1", async () => "a");
    await tracer.flush();
    await tracer.flush();

    expect(persistFn).toHaveBeenCalledTimes(1);
  });
});
