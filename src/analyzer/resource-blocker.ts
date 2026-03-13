import type { BrowserContext } from "playwright";

export async function installResourceBlocker(
  context: BrowserContext,
  phase: "scan" | "probe",
): Promise<void> {
  const blocked =
    phase === "scan"
      ? ["image", "media", "font"]
      : ["font"];

  await context.route("**/*", (route) => {
    if (blocked.includes(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });
}
