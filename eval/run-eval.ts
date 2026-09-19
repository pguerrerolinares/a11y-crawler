#!/usr/bin/env bun
/**
 * Harness de evaluación del a11y-crawler contra un oracle de ground-truth.
 *
 * Corre el crawler sobre las rutas de un oracle, cruza los criterios WCAG
 * detectados contra el ground-truth verificado y calcula RECALL sobre lo
 * automatizable (la métrica honesta: de las violaciones reales que un motor
 * *puede* detectar, cuántas detecta el crawler). Guarda snapshot y muestra
 * delta vs la corrida anterior → loop de mejora medible.
 *
 * Uso:
 *   bun run eval/run-eval.ts --oracle <sitio> [--base http://localhost:4200] [--api http://localhost:3000]
 *   bun run eval/run-eval.ts --oracle <sitio> --label "baseline"
 *
 * Oráculos y snapshots son datos de cliente: viven fuera del repo, en
 * private/eval/{oracles,results}/ (gitignored) o en $A11Y_EVAL_DIR.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.A11Y_EVAL_DIR ?? join(HERE, "..", "private", "eval");

type Verdict = "VIOLATES" | "PASSES";
interface Entry {
  id: string; wcag: string; task: string; priority: string; category: string;
  verdict: Verdict; automatable: boolean; needsState?: boolean; pages: string[]; evidence: string;
}
interface Oracle {
  site: string; baseUrl: string; wcagLevel: "A" | "AA" | "AAA";
  source: string; auditRoutes: string[]; entries: Entry[];
}

// ---- args ----
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const oracleName = arg("oracle");
if (!oracleName) { console.error("uso: bun run eval/run-eval.ts --oracle <sitio> [--label x]"); process.exit(1); }
const label = arg("label", "run")!;
const apiUrl = arg("api", "http://localhost:3000")!.replace(/\/$/, "");

const oracle: Oracle = JSON.parse(readFileSync(join(DATA_DIR, "oracles", `${oracleName}.json`), "utf8"));
const baseUrl = (arg("base", oracle.baseUrl)!).replace(/\/$/, "");

// ---- mini CSV parser (respeta comillas) ----
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift(); if (!header) return [];
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function auditRoute(route: string): Promise<Set<string>> {
  const url = `${baseUrl}${route}`;
  const res = await fetch(`${apiUrl}/api/audits`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, wcagLevel: oracle.wcagLevel, maxPages: 1, maxDepth: 1 }),
  });
  const { id } = await res.json() as { id: string };
  // poll
  for (let i = 0; i < 120; i++) {
    const s = await (await fetch(`${apiUrl}/api/audits/${id}`)).json() as { status: string };
    if (["completed", "done", "failed", "error"].includes(s.status)) break;
    await sleep(2500);
  }
  const csv = await (await fetch(`${apiUrl}/api/audits/${id}/export/csv`)).text();
  const crit = new Set<string>();
  for (const r of parseCsv(csv)) {
    const c = (r.wcag_criterion || "").trim();
    if (c && /^\d/.test(c)) crit.add(c);
  }
  return crit;
}

// ---- run crawler over all routes ----
console.log(`\n▶ eval[${oracleName}] label="${label}"  base=${baseUrl}  api=${apiUrl}`);
const detectedByRoute = new Map<string, Set<string>>();
const allDetected = new Set<string>();
for (const route of oracle.auditRoutes) {
  process.stdout.write(`  crawling ${route} … `);
  try {
    const crit = await auditRoute(route);
    detectedByRoute.set(route, crit);
    crit.forEach(c => allDetected.add(c));
    console.log(`${crit.size} criterios`);
  } catch (e) {
    console.log(`ERROR ${(e as Error).message}`);
    detectedByRoute.set(route, new Set());
  }
}

// ---- cruce contra oracle ----
function isDetected(e: Entry): boolean {
  const wildcard = e.pages.includes("*");
  if (wildcard) return allDetected.has(e.wcag);
  return e.pages.some(p => detectedByRoute.get(p)?.has(e.wcag));
}

const results = oracle.entries.map(e => {
  if (!e.automatable) return { e, outcome: "SKIP_NONAUTO" as const, detected: false };
  const detected = isDetected(e);
  let outcome: "TP" | "FN" | "TN" | "FP";
  if (e.verdict === "VIOLATES") outcome = detected ? "TP" : "FN";
  else outcome = detected ? "FP" : "TN"; // PASSES
  return { e, outcome, detected };
});

const count = (o: string) => results.filter(r => r.outcome === o).length;
const TP = count("TP"), FN = count("FN"), TN = count("TN"), FP = count("FP"), SKIP = count("SKIP_NONAUTO");
const recall = TP + FN ? TP / (TP + FN) : 0;
const specificity = TN + FP ? TN / (TN + FP) : 0; // aciertos al callar cuando el sitio cumple

// ---- reporte ----
console.log(`\n── ${oracle.site} · ${TP + FN + TN + FP} entradas automatizables (+${SKIP} no-automatizables excluidas) ──`);
console.log(`ID          WCAG    VEREDICTO   OUTCOME  ${"tarea".padEnd(30)}`);
for (const r of results) {
  const mark = { TP: "✅ TP", FN: "❌ FN", TN: "· TN", FP: "⚠ FP", SKIP_NONAUTO: "— n/a" }[r.outcome];
  console.log(`${r.e.id.padEnd(11)} ${r.e.wcag.padEnd(7)} ${r.e.verdict.padEnd(10)} ${mark.padEnd(7)} ${r.e.task.slice(0, 30)}`);
}

console.log(`\n── MÉTRICAS ──`);
console.log(`  RECALL (automatizable):     ${(recall * 100).toFixed(1)}%   (${TP}/${TP + FN} violaciones detectadas)`);
console.log(`  Especificidad (sitio-cumple → callar): ${(specificity * 100).toFixed(1)}%   (${TN}/${TN + FP})`);
const fns = results.filter(r => r.outcome === "FN");
if (fns.length) console.log(`  FN (gaps): ${fns.map(r => `${r.e.id}(${r.e.wcag})`).join(", ")}`);
const fps = results.filter(r => r.outcome === "FP");
if (fps.length) console.log(`  FP a revisar: ${fps.map(r => `${r.e.id}(${r.e.wcag})`).join(", ")}`);

// ---- snapshot + delta ----
const resultsDir = join(DATA_DIR, "results");
mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const snapshot = {
  oracle: oracleName, label, timestamp: new Date().toISOString(), baseUrl,
  metrics: { recall, specificity, TP, FN, TN, FP, skipped: SKIP },
  outcomes: results.map(r => ({ id: r.e.id, wcag: r.e.wcag, outcome: r.outcome })),
};

// delta vs snapshot previo
const prev = readdirSync(resultsDir).filter(f => f.startsWith(`${oracleName}-`) && f.endsWith(".json")).sort().pop();
if (prev) {
  const p = JSON.parse(readFileSync(join(resultsDir, prev), "utf8"));
  const dR = (recall - p.metrics.recall) * 100;
  console.log(`\n── DELTA vs "${p.label}" (${p.timestamp.slice(0, 16)}) ──`);
  console.log(`  recall: ${(p.metrics.recall * 100).toFixed(1)}% → ${(recall * 100).toFixed(1)}%  (${dR >= 0 ? "+" : ""}${dR.toFixed(1)} pts)`);
  const prevFN = new Set(p.outcomes.filter((o: any) => o.outcome === "FN").map((o: any) => o.id));
  const nowFN = new Set(results.filter(r => r.outcome === "FN").map(r => r.e.id));
  const fixed = [...prevFN].filter(id => !nowFN.has(id));
  const regressed = [...nowFN].filter(id => !prevFN.has(id));
  if (fixed.length) console.log(`  ✅ FN resueltos: ${fixed.join(", ")}`);
  if (regressed.length) console.log(`  🔺 regresiones (nuevos FN): ${regressed.join(", ")}`);
  if (!fixed.length && !regressed.length) console.log(`  (sin cambios en cobertura de criterios)`);
}

writeFileSync(join(resultsDir, `${oracleName}-${stamp}.json`), JSON.stringify(snapshot, null, 2));
console.log(`\n✔ snapshot → ${resultsDir}/${oracleName}-${stamp}.json\n`);
