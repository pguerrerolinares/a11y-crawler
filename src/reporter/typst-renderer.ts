import type { ReportData } from "./report-data";
import { randomUUID } from "crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

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

export async function renderPdf(data: ReportData): Promise<Uint8Array> {
  await acquire();

  // Write data JSON inside templates dir (Typst --root must contain all files).
  // Unique name prevents conflicts from concurrent renders.
  const uid = randomUUID();
  const dataPath = join(TEMPLATES_DIR, `_data-${uid}.json`);
  const outPath = join(TEMPLATES_DIR, `_out-${uid}.pdf`);

  try {
    await Bun.write(dataPath, JSON.stringify(data));

    // Pass relative filename since Typst resolves json() paths relative to --root
    const dataFilename = `_data-${uid}.json`;
    // 30s timeout to prevent blocking semaphore slots indefinitely
    const result = await Bun.$`timeout 30 typst compile --root ${TEMPLATES_DIR} --font-path ${TEMPLATES_DIR}/fonts --input datafile=${dataFilename} ${TEMPLATES_DIR}/main.typ ${outPath}`.quiet();

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString();
      if (result.exitCode === 124) {
        throw new Error("Typst compilation timed out after 30s");
      }
      throw new Error(`Typst compilation failed: ${stderr}`);
    }

    return new Uint8Array(await Bun.file(outPath).arrayBuffer());
  } finally {
    // Clean up temp files
    for (const p of [dataPath, outPath]) {
      try { await unlink(p); } catch (e: any) {
        if (e?.code !== "ENOENT") console.warn(`Failed to clean up ${p}:`, e);
      }
    }
    release();
  }
}
