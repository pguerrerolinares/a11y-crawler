import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { initDb, getDb } from "../db/client.ts";

const BASE = "http://localhost:3000";
let createdAuditId: string;

beforeAll(async () => {
  await initDb();
});

afterAll(async () => {
  const db = getDb();
  // Clean up test data
  if (createdAuditId) {
    await db`DELETE FROM audits WHERE id = ${createdAuditId}`;
  }
});

describe("POST /api/audits", () => {
  test("creates an audit and returns 201", async () => {
    const res = await fetch(`${BASE}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", maxPages: 1, maxDepth: 1 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.url).toBe("https://example.com");
    expect(body.status).toBe("pending");
    createdAuditId = body.id;
  });

  test("returns 400 for invalid URL", async () => {
    const res = await fetch(`${BASE}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 for invalid JSON", async () => {
    const res = await fetch(`${BASE}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/audits", () => {
  test("lists audits with pagination", async () => {
    const res = await fetch(`${BASE}/api/audits?limit=10&offset=0`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
  });

  test("filters by status", async () => {
    const res = await fetch(`${BASE}/api/audits?status=pending`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    body.data.forEach((a: any) => expect(a.status).toBe("pending"));
  });
});

describe("GET /api/audits/:id", () => {
  test("returns audit detail", async () => {
    const res = await fetch(`${BASE}/api/audits/${createdAuditId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(createdAuditId);
    expect(body.url).toBe("https://example.com");
  });

  test("returns 404 for non-existent audit", async () => {
    const res = await fetch(`${BASE}/api/audits/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/audits/:id/pages", () => {
  test("returns pages for audit", async () => {
    const res = await fetch(`${BASE}/api/audits/${createdAuditId}/pages?limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
  });
});

describe("GET /api/audits/:id/issues", () => {
  test("returns issues for audit", async () => {
    const res = await fetch(`${BASE}/api/audits/${createdAuditId}/issues?limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
  });

  test("supports impact filter", async () => {
    const res = await fetch(`${BASE}/api/audits/${createdAuditId}/issues?impact=critical`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
  });
});

describe("GET /api/audits/:id/shared", () => {
  test("returns shared issues", async () => {
    const res = await fetch(`${BASE}/api/audits/${createdAuditId}/shared`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
  });
});

describe("GET /api/logs", () => {
  test("returns request logs", async () => {
    const res = await fetch(`${BASE}/api/logs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
  });

  test("supports path filter", async () => {
    const res = await fetch(`${BASE}/api/logs?path=/api/audits`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
  });
});

describe("DELETE /api/audits/:id", () => {
  test("deletes audit and returns 204", async () => {
    // Create a throwaway audit to delete
    const createRes = await fetch(`${BASE}/api/audits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://delete-me.example.com", maxPages: 1, maxDepth: 1 }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${BASE}/api/audits/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    // Verify it's gone
    const check = await fetch(`${BASE}/api/audits/${id}`);
    expect(check.status).toBe(404);
  });
});
