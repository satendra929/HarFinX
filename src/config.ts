import { DEFAULT_OLLAMA_MODEL, resolveModel } from "./modelChoice.ts";

export type Provider = "ollama" | "anthropic";

export interface Config {
  provider: Provider;
  ollamaModel: string;
  ollamaBaseUrl: string;
  /** The context window the harness assumes for local models, in tokens. Read from OLLAMA_CONTEXT_LENGTH, the same variable the Ollama server uses, so the two cannot drift apart. */
  ollamaContext: number;
  anthropicModel: string;
  anthropicApiKey: string;
  workspaceDir: string;
  auditDir: string;
  allowCloudFiles: boolean;
  calcShape: "steps" | "expr";
  /** Override of the provider's reasoning-history policy (src/reasoning.ts); undefined means the profile default. */
  reasoningHistory?: "drop" | "latest" | "keep";
  envFileFound: boolean;
}

export const DEFAULT_OLLAMA_CONTEXT = 16384;
const MIN_CONTEXT = 2048;
const MAX_CONTEXT = 1_048_576;

/** Parses OLLAMA_CONTEXT_LENGTH: a whole number of tokens; empty or unset means the default. */
export function parseContextLength(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_OLLAMA_CONTEXT;
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < MIN_CONTEXT || n > MAX_CONTEXT) {
    throw new Error(`OLLAMA_CONTEXT_LENGTH must be a whole number of tokens between ${MIN_CONTEXT} and ${MAX_CONTEXT} (got "${text}").`);
  }
  return n;
}

/** `overrides.model` (the --model flag) wins over OLLAMA_MODEL; either may be a short name such as "gemma". */
export function loadConfig(overrides: { model?: string } = {}): Config {
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

  const reasoningHistory = env.REASONING_HISTORY?.trim().toLowerCase() || undefined;
  if (reasoningHistory !== undefined && reasoningHistory !== "drop" && reasoningHistory !== "latest" && reasoningHistory !== "keep") {
    throw new Error(`REASONING_HISTORY must be "drop", "latest" or "keep" (got "${reasoningHistory}").`);
  }

  return {
    provider,
    ollamaModel: resolveModel(overrides.model?.trim() || env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL),
    ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1",
    ollamaContext: parseContextLength(env.OLLAMA_CONTEXT_LENGTH),
    anthropicModel: env.ANTHROPIC_MODEL?.trim() || "claude-haiku-5-5",
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || "",
    workspaceDir: env.WORKSPACE_DIR?.trim() || "workspace",
    auditDir: env.AUDIT_DIR?.trim() || "audit",
    allowCloudFiles: env.ALLOW_CLOUD_FILES?.trim() === "1",
    calcShape: env.CALC_SHAPE?.trim() === "expr" ? "expr" : "steps",
    reasoningHistory,
    envFileFound,
  };
}
