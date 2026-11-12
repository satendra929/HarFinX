export type Provider = "ollama" | "anthropic";

export interface Config {
  provider: Provider;
  ollamaModel: string;
  ollamaBaseUrl: string;
  anthropicModel: string;
  anthropicApiKey: string;
  workspaceDir: string;
  auditDir: string;
  allowCloudFiles: boolean;
  envFileFound: boolean;
}

export function loadConfig(): Config {
  let envFileFound = true;
  try {
    process.loadEnvFile();
  } catch {
    envFileFound = false; // missing .env is fine: fall back to defaults
  }

  const env = process.env;
  const provider = (env.PROVIDER?.trim() || "ollama").toLowerCase();
  if (provider !== "ollama" && provider !== "anthropic") {
    throw new Error(`PROVIDER must be "ollama" or "anthropic" (got "${provider}").`);
  }

  return {
    provider,
    ollamaModel: env.OLLAMA_MODEL?.trim() || "qwen3:14b",
    ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1",
    anthropicModel: env.ANTHROPIC_MODEL?.trim() || "claude-haiku-5-5",
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || "",
    workspaceDir: env.WORKSPACE_DIR?.trim() || "workspace",
    auditDir: env.AUDIT_DIR?.trim() || "audit",
    allowCloudFiles: env.ALLOW_CLOUD_FILES?.trim() === "1",
    envFileFound,
  };
}
