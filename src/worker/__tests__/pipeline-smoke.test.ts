// src/worker/__tests__/pipeline-smoke.test.ts
import { describe, test, expect } from "bun:test";

describe("pipeline module wiring", () => {
  test("all pipeline modules import without errors", async () => {
    const pipeline = await import("../pipeline");
    expect(typeof pipeline.runPipeline).toBe("function");

    const scan = await import("../scan");
    expect(typeof scan.runScanPhase).toBe("function");

    const probe = await import("../probe");
    expect(typeof probe.runProbePhase).toBe("function");

    const slotPool = await import("../slot-pool");
    expect(typeof slotPool.SlotPool).toBe("function");
    expect(typeof slotPool.ContextSlot).toBe("function");

    const probeCtx = await import("../probe-context");
    expect(typeof probeCtx.ProbeContextManager).toBe("function");

    const tracer = await import("../tracer");
    expect(typeof tracer.AuditTracer).toBe("function");
    expect(typeof tracer.Span).toBe("function");
  });

  test("all analyzer modules import without errors", async () => {
    const consent = await import("../../analyzer/consent-blocker");
    expect(typeof consent.installConsentBlocker).toBe("function");

    const resource = await import("../../analyzer/resource-blocker");
    expect(typeof resource.installResourceBlocker).toBe("function");

    const fingerprint = await import("../../analyzer/fingerprint");
    expect(typeof fingerprint.simhash).toBe("function");
    expect(typeof fingerprint.hammingDistance).toBe("function");
    expect(typeof fingerprint.inferUrlPattern).toBe("function");

    const classify = await import("../../analyzer/classify");
    expect(typeof classify.clusterPages).toBe("function");
    expect(typeof classify.buildTestPlan).toBe("function");
    expect(typeof classify.selectRepresentative).toBe("function");

    const wcag = await import("../../analyzer/wcag-tests");
    expect(typeof wcag.testReflow).toBe("function");
    expect(typeof wcag.testTextSpacing).toBe("function");
    expect(typeof wcag.testResizeText).toBe("function");
    expect(typeof wcag.testMultimedia).toBe("function");
    expect(typeof wcag.testTimedEvents).toBe("function");
  });
});
