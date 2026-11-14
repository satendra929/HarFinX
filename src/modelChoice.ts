// Choosing the local model: short names, the --model flag, and the list of models installed in Ollama.
// Pure helpers (no I/O) except listInstalledModels(), which asks the local Ollama server.
import { ollamaRoot } from "./ollamaContext.ts";

/** Short names for models we have set up. Any other Ollama tag also works as typed. */
export const MODEL_ALIASES: Record<string, string> = {
  qwen: "qwen3:14b",
  gemma: "gemma4:12b",
};

export const DEFAULT_OLLAMA_MODEL = MODEL_ALIASES.gemma;

/** A short name becomes its Ollama tag; anything else is returned as typed (trimmed). */
export function resolveModel(name: string): string {
  const n = name.trim();
  return MODEL_ALIASES[n.toLowerCase()] ?? n;
}

/** The short name of a tag, if it has one (for display). */
export function aliasOf(tag: string): string | undefined {
  return Object.entries(MODEL_ALIASES).find(([, t]) => t === tag)?.[0];
}

export interface ParsedArgs {
  /** Value of --model, as typed (resolve it with resolveModel). */
  model?: string;
  /** The rest, joined: the question for one-off mode. Empty means chat mode. */
  prompt: string;
  error?: string;
}

/** Options are read only at the start (`--model gemma` or `--model=gemma`); everything after is the question. */
export function parseArgs(argv: string[]): ParsedArgs {
  let model: string | undefined;
  let i = 0;
  while (i < argv.length && argv[i].startsWith("--")) {
    const a = argv[i];
    if (a === "--model") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) return { prompt: "", error: "--model needs a model name, for example: --model gemma" };
      model = v;
      i += 2;
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
      if (!model.trim()) return { prompt: "", error: "--model needs a model name, for example: --model gemma" };
      i += 1;
    } else {
      return { prompt: "", error: `Unknown option ${a}. The only option is --model <name>.` };
    }
  }
  return { model, prompt: argv.slice(i).join(" ") };
}

/** Names of the models in the JSON body of Ollama's /api/tags, in the server's order. */
export function parseInstalled(body: unknown): string[] {
  const models = (body as { models?: { name?: unknown }[] } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models.map((m) => m?.name).filter((n): n is string => typeof n === "string");
}

/**
 * Finds what the user typed among the installed models: a list number (1-based), a short name, a full tag, or a
 * name without a tag when the server lists it with ":latest". Undefined when nothing matches.
 */
export function findInstalled(arg: string, installed: string[]): string | undefined {
  const a = arg.trim();
  if (/^\d+$/.test(a)) return installed[Number(a) - 1];
  const tag = resolveModel(a);
  return installed.find((m) => m === tag) ?? installed.find((m) => m === `${tag}:latest`);
}

/** Asks the local Ollama server which models are installed. Throws if it cannot be reached. */
export async function listInstalledModels(baseUrl: string, timeoutMs = 5000): Promise<string[]> {
  const res = await fetch(`${ollamaRoot(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Ollama answered ${res.status} to the model list request`);
  return parseInstalled(await res.json());
}
