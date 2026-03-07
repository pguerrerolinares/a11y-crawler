import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url(),
  LLM_API_KEY: z.string().min(1),
  LLM_API_BASE_URL: z.url().default("https://api.moonshot.ai/v1"),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}
