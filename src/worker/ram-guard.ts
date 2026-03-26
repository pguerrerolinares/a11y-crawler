import { readFileSync } from "node:fs";

/**
 * Get total system available memory in bytes.
 * Reads /proc/meminfo on Linux (accounts for Chromium child processes).
 * Returns Infinity on non-Linux (always allows batching in dev).
 *
 * Note: MemAvailable includes reclaimable filesystem cache — intentionally
 * conservative. False degradation to sequential is better than OOM.
 */
function defaultGetAvailableMemory(): number {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf-8");
    const match = meminfo.match(/MemAvailable:\s+(\d+)/);
    if (match) return parseInt(match[1]) * 1024; // kB to bytes
  } catch {
    // Not Linux or no access
  }
  return Infinity;
}

const BATCH_MEMORY_THRESHOLD = 400 * 1024 * 1024; // 400MB minimum available

/**
 * Returns true if there's enough memory for 2 concurrent pages.
 * Uses system available memory (not just process RSS) because
 * Chromium renderers are separate processes.
 *
 * @param getAvailableMemory - injectable for testing
 */
export function shouldBatch(
  getAvailableMemory: () => number = defaultGetAvailableMemory,
): boolean {
  const available = getAvailableMemory();
  return available > BATCH_MEMORY_THRESHOLD;
}
