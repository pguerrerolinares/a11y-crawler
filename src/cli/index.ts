// CLI is deprecated in v3 — audits are created via API and processed by the worker.
// Use: POST /api/audits to create an audit, or run the worker directly.
console.log("The CLI is deprecated in v3.");
console.log("Audits are now created via API (POST /api/audits) and processed by the worker.");
console.log("");
console.log("To run the worker: bun run src/worker/index.ts");
console.log("To start the API server: bun run src/server/index.ts");
process.exit(0);
