import { getDb } from "../db/client.ts";

const activeJobs = new Map<string, { proc: ReturnType<typeof Bun.spawn> }>();

export function startCrawl(auditId: string, url: string, config: Record<string, unknown>) {
  const fullConfig = { ...config, url };

  const proc = Bun.spawn([
    "bun", "run", `${import.meta.dir}/../../crawler/worker.ts`,
    auditId,
    JSON.stringify(fullConfig),
  ], {
    env: { ...process.env },
    stdout: "inherit",
    stderr: "inherit",
  });

  activeJobs.set(auditId, { proc });

  proc.exited.then(async (code) => {
    activeJobs.delete(auditId);
    if (code !== 0) {
      const db = getDb();
      await db`
        UPDATE audits SET status = 'failed', finished_at = NOW(),
        error = COALESCE(error, ${'Process exited with code ' + code})
        WHERE id = ${auditId} AND status = 'running'
      `.catch(console.error);
    }
  });
}

export function getActiveJobs(): string[] {
  return [...activeJobs.keys()];
}
