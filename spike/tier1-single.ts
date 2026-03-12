/**
 * Run axe-core+jsdom on a single site to avoid OOM accumulation
 * Usage: bun run spike/tier1-single.ts <url>
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.argv[2];
if (!url) { console.log("Usage: bun run spike/tier1-single.ts <url>"); process.exit(1); }

const axeSource = readFileSync(join(import.meta.dir, "../node_modules/axe-core/axe.min.js"), "utf-8");

function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const memBefore = process.memoryUsage().heapUsed;
const start = performance.now();

const html = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(10_000) }).then(r => r.text());
const fetchMs = Math.round(performance.now() - start);
const cleanHtml = stripScripts(html);

console.log(`Fetched: ${html.length} bytes (${cleanHtml.length} after script strip) in ${fetchMs}ms`);

const domStart = performance.now();
const dom = new JSDOM(cleanHtml, { url, pretendToBeVisual: true, runScripts: "dangerously" });
dom.window.eval(axeSource);

const results: any = await new Promise((resolve, reject) => {
  (dom.window as any).axe.run(
    dom.window.document.documentElement,
    { rules: { "color-contrast": { enabled: false }, "color-contrast-enhanced": { enabled: false } } },
    (err: any, res: any) => err ? reject(err) : resolve(res),
  );
});

const timeMs = Math.round(performance.now() - domStart);
const memMB = Math.round((process.memoryUsage().heapUsed - memBefore) / 1024 / 1024 * 10) / 10;

const total = results.passes.length + results.violations.length + results.incomplete.length + results.inapplicable.length;
console.log(`✅ ${total} rules | ${results.violations.length} violations | ${results.passes.length} passes | ${results.incomplete.length} incomplete | ${results.inapplicable.length} N/A`);
console.log(`Violations: ${results.violations.map((v: any) => `${v.id}(${v.nodes.length})`).join(", ") || "none"}`);
console.log(`Time: ${timeMs}ms (axe+jsdom) | Memory: ${memMB}MB | Total: ${fetchMs + timeMs}ms`);

dom.window.close();
