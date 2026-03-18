// src/server/routes/screenshots.ts
import { join, resolve } from "node:path";

const reportsDir = process.env.REPORTS_DIR || "./reports";

export async function handleScreenshots(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET") return Response.json({ error: "Method Not Allowed" }, { status: 405 });

  // GET /api/audits/:auditId/screenshots/:filename
  const fileMatch = url.pathname.match(/^\/api\/audits\/([^/]+)\/screenshots\/([^/]+)$/);
  if (fileMatch) {
    const [, auditId, filename] = fileMatch;

    // Validate filename (prevent path traversal)
    if (!/^[\w-]+\.png$/.test(filename)) {
      return new Response("Invalid filename", { status: 400 });
    }

    const filePath = resolve(join(reportsDir, auditId, "screenshots", filename));
    const expectedPrefix = resolve(join(reportsDir, auditId, "screenshots"));
    if (!filePath.startsWith(expectedPrefix)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    if (!await file.exists()) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(file, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
    });
  }

  // GET /api/audits/:auditId/screenshots — list available screenshots
  const listMatch = url.pathname.match(/^\/api\/audits\/([^/]+)\/screenshots$/);
  if (listMatch) {
    const [, auditId] = listMatch;
    const dir = join(reportsDir, auditId, "screenshots");

    try {
      const glob = new Bun.Glob("*.png");
      const files: string[] = [];
      for await (const file of glob.scan({ cwd: dir })) {
        files.push(file);
      }
      return Response.json({ screenshots: files });
    } catch {
      return Response.json({ screenshots: [] });
    }
  }

  return Response.json({ error: "Not Found" }, { status: 404 });
}
