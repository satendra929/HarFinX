// Settings for the conversation memory trim (src/context.ts): named levels, each a preset of numbers, plus a choice
// that follows the model's context window. Pure: parsing and resolving only.

import { DEFAULT_LIMITS } from "./guard.ts";

export type ContextLevel = "strict" | "balanced" | "lenient";
export type ContextMode = ContextLevel | "auto" | "off";
export const CONTEXT_MODES: readonly ContextMode[] = ["auto", "strict", "balanced", "lenient", "off"];

export interface ContextKnobs {
  /** The most of the window the earlier conversation may use (0 to 0.9). */
  historyShare: number;
  /** Finished questions kept whole (their large tool results shortened); older ones keep only question and answer. */
  recentGroups: number;
  /** The last finished question keeps its tool results whole when they fit. */
  keepPrevPages: boolean;
  /** A tool result of a finished question longer than this many characters is shortened to one line. */
  stubOver: number;
  /** Tokens kept free for the reply. */
  replyReserve: number;
  /** Estimator: characters per token. */
  charsPerToken: number;
  /** What older finished questions keep: question and answer ("qa"), or nothing ("none"). */
  olderForm: "qa" | "none";
  /** Show the dim line under an answer when the view was trimmed. */
  trimLine: boolean;
}

export const CONTEXT_LEVELS: Record<ContextLevel, ContextKnobs> = {
  // strict is for small windows (under 12,000 tokens), where a 4,096-token reserve would leave no room for any history
  strict: { historyShare: 0.2, recentGroups: 1, keepPrevPages: false, stubOver: 300, replyReserve: 2048, charsPerToken: 2.5, olderForm: "qa", trimLine: true },
  balanced: { historyShare: 0.25, recentGroups: 2, keepPrevPages: true, stubOver: 400, replyReserve: 4096, charsPerToken: 2.5, olderForm: "qa", trimLine: true },
  // above the per-result cap of the guard, so nothing is shortened
  lenient: { historyShare: 0.5, recentGroups: 4, keepPrevPages: true, stubOver: DEFAULT_LIMITS.maxOutputChars + 1000, replyReserve: 4096, charsPerToken: 2.5, olderForm: "qa", trimLine: true },
};

/** `auto` picks a level from the model's context window (tokens): below the first number strict, below the second balanced, else lenient. */
export const AUTO_BALANCED_FROM = 12_000;
export const AUTO_LENIENT_FROM = 48_000;

export interface ContextConfig {
  mode: ContextMode;
  /** Single settings given on their own; they win over the level's preset. */
  overrides: Partial<ContextKnobs>;
}

export interface ResolvedContext {
  mode: ContextMode;
  /** The level in force ("off": the full history is sent). */
  level: ContextLevel | "off";
  knobs: ContextKnobs;
  /** Names of the knobs set on their own. */
  overridden: (keyof ContextKnobs)[];
}

export function autoLevel(window: number): ContextLevel {
  if (!(window > 0)) return "balanced";
  return window < AUTO_BALANCED_FROM ? "strict" : window < AUTO_LENIENT_FROM ? "balanced" : "lenient";
}

export function resolveContext(cfg: ContextConfig, window: number): ResolvedContext {
  const level: ContextLevel | "off" = cfg.mode === "off" ? "off" : cfg.mode === "auto" ? autoLevel(window) : cfg.mode;
  const base = CONTEXT_LEVELS[level === "off" ? "balanced" : level];
  return { mode: cfg.mode, level, knobs: { ...base, ...cfg.overrides }, overridden: Object.keys(cfg.overrides) as (keyof ContextKnobs)[] };
}

function number(name: string, raw: string, min: number, max: number, whole: boolean): number {
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || (whole && !/^\d+$/.test(raw)) || !(n >= min && n <= max)) {
    throw new Error(`${name} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max} (got "${raw}").`);
  }
  return n;
}

function flag(name: string, raw: string): boolean {
  if (raw !== "0" && raw !== "1") throw new Error(`${name} must be 0 or 1 (got "${raw}").`);
  return raw === "1";
}

/** Reads CONTEXT_MEMORY and the single-knob settings from the environment. Unset or blank means the default; a bad value stops startup with a plain message. */
export function parseContextConfig(env: Record<string, string | undefined>): ContextConfig {
  const get = (name: string) => env[name]?.trim() || undefined;
  const mode = (get("CONTEXT_MEMORY") ?? "auto").toLowerCase();
  if (!CONTEXT_MODES.includes(mode as ContextMode)) throw new Error(`CONTEXT_MEMORY must be one of ${CONTEXT_MODES.join(", ")} (got "${mode}").`);

  const overrides: Partial<ContextKnobs> = {};
  const share = get("CONTEXT_HISTORY_SHARE");
  if (share !== undefined) {
    overrides.historyShare = number("CONTEXT_HISTORY_SHARE", share, 0.05, 0.9, false);
  }
  const recent = get("CONTEXT_RECENT_GROUPS");
  if (recent !== undefined) overrides.recentGroups = number("CONTEXT_RECENT_GROUPS", recent, 0, 20, true);
  const prev = get("CONTEXT_KEEP_PREV_PAGES");
  if (prev !== undefined) overrides.keepPrevPages = flag("CONTEXT_KEEP_PREV_PAGES", prev);
  const stub = get("CONTEXT_STUB_OVER");
  if (stub !== undefined) overrides.stubOver = number("CONTEXT_STUB_OVER", stub, 100, 100_000, true);
  const reserve = get("CONTEXT_REPLY_RESERVE");
  if (reserve !== undefined) overrides.replyReserve = number("CONTEXT_REPLY_RESERVE", reserve, 512, 100_000, true);
  const cpt = get("CONTEXT_CHARS_PER_TOKEN");
  if (cpt !== undefined) overrides.charsPerToken = number("CONTEXT_CHARS_PER_TOKEN", cpt, 1, 6, false);
  const older = get("CONTEXT_OLDER_FORM")?.toLowerCase();
  if (older !== undefined) {
    if (older !== "qa" && older !== "none") throw new Error(`CONTEXT_OLDER_FORM must be "qa" or "none" (got "${older}").`);
    overrides.olderForm = older;
  }
  const trim = get("CONTEXT_TRIM_LINE");
  if (trim !== undefined) overrides.trimLine = flag("CONTEXT_TRIM_LINE", trim);
  return { mode: mode as ContextMode, overrides };
}
