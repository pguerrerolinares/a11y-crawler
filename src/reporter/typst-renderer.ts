import type { ReportData } from "./report-data";
import { randomUUID } from "crypto";
import { unlink } from "node:fs/promises";

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
  const dataFilename = `data-${uid}.json`;
  const dataPath = `${TEMPLATES_DIR}/${dataFilename}`;
  const outPath = `${TEMPLATES_DIR}/out-${uid}.pdf`;

  try {
    await Bun.write(dataPath, JSON.stringify(data));

    const result = await Bun.$`typst compile --root ${TEMPLATES_DIR} --font-path ${TEMPLATES_DIR}/fonts --input datafile=${dataFilename} ${TEMPLATES_DIR}/main.typ ${outPath}`.quiet();

    if (result.exitCode !== 0) {
      throw new Error(`Typst compilation failed: ${result.stderr.toString()}`);
    }

    const pdfBytes = await Bun.file(outPath).arrayBuffer();
    return Buffer.from(pdfBytes);
  } finally {
    for (const p of [dataPath, outPath]) {
      try { await unlink(p); } catch {}
    }
    release();
  }
}
