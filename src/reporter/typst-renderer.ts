import type { ReportData } from "./report-data";
import { randomUUID } from "crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

const MAX_CONCURRENT = 2;
let activeCount = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  return new Promise(resolve => {
    if (activeCount < MAX_CONCURRENT) {
      activeCount++;
      resolve();
    } else {
      queue.push(() => { activeCount++; resolve(); });
    }
  });
}

function release(): void {
  activeCount--;
  const next = queue.shift();
  if (next) next();
}

// Resolve templates directory relative to this file
const TEMPLATES_DIR = new URL("../../templates/report", import.meta.url).pathname;

export async function renderPdf(data: ReportData): Promise<Buffer> {
  await acquire();

  const uid = randomUUID();
  // Write temp files to OS tmpdir (not the templates directory)
  const dataPath = `${tmpdir()}/typst-data-${uid}.json`;
  const outPath = `${tmpdir()}/typst-out-${uid}.pdf`;

  try {
    await Bun.write(dataPath, JSON.stringify(data));

    // Use --root / so Typst can access both templates (source) and /tmp (data/output)
    const result = await Bun.$`typst compile --root / --font-path ${TEMPLATES_DIR}/fonts --input datafile=${dataPath} ${TEMPLATES_DIR}/main.typ ${outPath}`.quiet();

    if (result.exitCode !== 0) {
      throw new Error(`Typst compilation failed: ${result.stderr.toString()}`);
    }

    const pdfBytes = await Bun.file(outPath).arrayBuffer();
    return Buffer.from(pdfBytes);
  } finally {
    for (const p of [dataPath, outPath]) {
      try { await unlink(p); } catch (e: any) {
        if (e?.code !== "ENOENT") console.warn(`Failed to clean up ${p}:`, e);
      }
    }
    release();
  }
}
