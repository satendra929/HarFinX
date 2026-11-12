// Turns provider/transport error text into a message a person can act on. Unknown errors pass through, cleaned
// of terminal control characters (error text can contain server-controlled content).
import { cleanForTerminal } from "./guard.ts";

export function friendlyError(raw: string, provider: string, model: string): string {
  const m = raw.toLowerCase();
  if (/body timeout|headers timeout|und_err_|timed out|timeout/.test(m)) {
    return provider === "ollama"
      ? "The model stopped responding (no data for several minutes). Ollama may be overloaded or the model got stuck. Try the question again; if it keeps happening, restart Ollama."
      : "The request to the model provider timed out. Try again in a moment.";
  }
  if (m.includes("econnrefused") || m.includes("fetch failed") || m.includes("connection")) {
    return provider === "ollama"
      ? "Cannot reach Ollama. Is it running? (start the Ollama app, then try again)"
      : "Cannot reach the Anthropic API. Check your network connection.";
  }
  if (m.includes("not found") || m.includes("404")) {
    return provider === "ollama"
      ? `Model not found. Run: ollama pull ${model}`
      : `Model "${model}" was not found. Check ANTHROPIC_MODEL.`;
  }
  if (m.includes("401") || m.includes("unauthorized") || m.includes("api key")) {
    return "Authentication failed. Check ANTHROPIC_API_KEY.";
  }
  return cleanForTerminal(raw);
}
