import { DEFAULT_OLLAMA_MODEL, resolveModel } from "./modelChoice.ts";
import { parseContextConfig, type ContextConfig } from "./contextSettings.ts";

export type Provider = "ollama" | "anthropic";

export interface Config {
  provider: Provider;
  ollamaModel: string;
  ollamaBaseUrl: string;
  /** The context window the harness assumes for local models, in tokens. Read from OLLAMA_CONTEXT_LENGTH, the same variable the Ollama server uses, so the two cannot drift apart. */
  ollamaContext: number;
  /** OLLAMA_TEMPERATURE: sent with every request to a local model; undefined leaves the model's own default. */
  ollamaTemperature?: number;
  anthropicModel: string;
  anthropicApiKey: string;
  workspaceDir: string;
  auditDir: string;
  allowCloudFiles: boolean;
  calcShape: "steps" | "expr";
  /** FILE_LIST_FIRST=off: do not put the file list in the first message (for A/B runs). */
  fileListFirst: boolean;
  /** STATEMENT_TOOL=on: add the get_line_item tool and its prompt sentence. Off by default: the first live run (2026-11-15) showed no net gain. */
  statementTool: boolean;
  /** FIGURE_FALLBACK: what happens to a figure that cannot be cited after the one repair: `redact` (default) removes the sentence, `warn` prints the answer and a warning line. */
  figureFallback: "redact" | "warn";
  /** READ_MIN_PAGES (0 to 5, default 3; 0 is off): an answer built on fewer distinct pages gets one message naming the next pages the search listed (src/readcheck.ts). */
  readMinPages: number;
  /** READ_SEARCH_FIRST=on (default off): also ask for a search when a long answer was given with no search in the question and the conversation is about a file. Costs a second reply and a search; no measured quality gain yet. */
  readSearchFirst: boolean;
  /** Override of the provider's reasoning-history policy (src/reasoning.ts); undefined means the profile default. */
  reasoningHistory?: "drop" | "latest" | "keep";
  /** How much of the earlier conversation the model is shown (src/contextSettings.ts). */
  context: ContextConfig;
  envFileFound: boolean;
}

/**
 * Whether a model server URL points at this machine (localhost, 127.x.x.x or ::1). A server anywhere else gets the same
 * privacy treatment as a cloud model: file tools stay off unless ALLOW_CLOUD_FILES=1, because file contents would leave the machine.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host === "localhost" || host === "[::1]" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** The URL without any user:password part, for the audit log; a text that is not a URL is not logged at all. */
export function withoutCredentials(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return "(not a valid URL)";
  }
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

/** Parses OLLAMA_TEMPERATURE: a number from 0 to 2; empty or unset means the model's own default (undefined). */
export function parseTemperature(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const n = Number(text);
  if (!/^\d+(?:\.\d+)?$/.test(text) || n > 2) throw new Error(`OLLAMA_TEMPERATURE must be a number from 0 to 2 (got "${text}").`);
  return n;
}

export const DEFAULT_READ_MIN_PAGES = 3;

/** Parses READ_MIN_PAGES: a whole number from 0 (off) to 5; empty or unset means the default. */
export function parseReadMinPages(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_READ_MIN_PAGES;
  if (!/^\d+$/.test(text) || Number(text) > 5) throw new Error(`READ_MIN_PAGES must be a whole number from 0 (off) to 5 (got "${text}").`);
  return Number(text);
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
    ollamaTemperature: provider === "ollama" ? parseTemperature(env.OLLAMA_TEMPERATURE) : undefined,
    anthropicModel: env.ANTHROPIC_MODEL?.trim() || "claude-haiku-5-5",
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || "",
    workspaceDir: env.WORKSPACE_DIR?.trim() || "workspace",
    auditDir: env.AUDIT_DIR?.trim() || "audit",
    allowCloudFiles: env.ALLOW_CLOUD_FILES?.trim() === "1",
    calcShape: env.CALC_SHAPE?.trim() === "expr" ? "expr" : "steps",
    fileListFirst: env.FILE_LIST_FIRST?.trim().toLowerCase() !== "off",
    statementTool: env.STATEMENT_TOOL?.trim().toLowerCase() === "on",
    figureFallback: env.FIGURE_FALLBACK?.trim().toLowerCase() === "warn" ? "warn" : "redact",
    readMinPages: parseReadMinPages(env.READ_MIN_PAGES),
    readSearchFirst: env.READ_SEARCH_FIRST?.trim().toLowerCase() === "on",
    reasoningHistory,
    context: parseContextConfig(env),
    envFileFound,
  };
}
