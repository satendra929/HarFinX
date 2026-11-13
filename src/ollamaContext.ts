// Asks the Ollama server which context window it really loaded the model with, so the harness can notice when that
// differs from the window it assumes (OLLAMA_CONTEXT_LENGTH in .env or the environment). The two can drift apart: the
// Ollama app has its own settings, and a restart without the variable falls back to another size. When they differ,
// Ollama silently drops the oldest text of a long prompt, so the harness warns and uses the server's figure.
// Only the user's own Ollama server (the configured base URL) is contacted, and only after a model has answered once.

/** The server root from the OpenAI-style base URL the harness uses ("http://localhost:11434/v1" gives "http://localhost:11434"). */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** The context length of `modelId` in an /api/ps response, or undefined when the model is not listed or the shape is unexpected. */
export function contextFromPs(body: unknown, modelId: string): number | undefined {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return undefined;
  // Ollama lists a tag-less model as "name:latest"
  const ids = new Set([modelId, modelId.includes(":") ? modelId : `${modelId}:latest`]);
  for (const m of models as { name?: unknown; model?: unknown; context_length?: unknown }[]) {
    if ((ids.has(m?.name as string) || ids.has(m?.model as string)) && Number.isInteger(m.context_length) && (m.context_length as number) > 0) return m.context_length as number;
  }
  return undefined;
}

/** What the server reports for the model, or undefined when it cannot be found out (server down, slow, or an older API). Never throws. */
export async function serverContext(baseUrl: string, modelId: string, fetchFn: typeof fetch = fetch, timeoutMs = 2000): Promise<number | undefined> {
  try {
    const res = await fetchFn(`${ollamaRoot(baseUrl)}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return contextFromPs(await res.json(), modelId);
  } catch {
    return undefined;
  }
}

/** The warning for a difference, or undefined when the figures agree. */
export function contextMismatchWarning(assumed: number, actual: number | undefined, modelId: string): string | undefined {
  if (actual === undefined || actual === assumed) return undefined;
  return (
    `[context] Ollama is running ${modelId} with a ${actual}-token window, not the ${assumed} the harness expected (OLLAMA_CONTEXT_LENGTH). ` +
    `Using ${actual} for this session. To change it, set the same size in Ollama (its settings or the OLLAMA_CONTEXT_LENGTH variable), restart Ollama, and keep the harness setting equal; until then long prompts lose their oldest text silently.`
  );
}
