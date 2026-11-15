// What a reading tool hands back for the host besides the text for the model: the text the model has now seen, and where
// it sits (file, page, page lines). It travels as the tool result's `structuredContent`, which Pi gives to the host
// (the `tool_execution_end` event) and never to the model, so the figure-provenance ledger is fed by the engine from the
// result and a tool needs no callback into the host.
import type { JsonValue } from "@earendil-works/pi-ai";
import type { SourceMeta } from "./provenance.ts";

export interface ShownText {
  label: string;
  text: string;
  meta: SourceMeta;
}

/** The structured result of a reading tool. */
export function shownContent(shown: readonly ShownText[]): JsonValue {
  return { shown } as unknown as JsonValue;
}

/** The shown texts in a tool result (empty for any other result). */
export function shownOf(result: unknown): ShownText[] {
  const shown = (result as { structuredContent?: { shown?: unknown } } | undefined)?.structuredContent?.shown;
  if (!Array.isArray(shown)) return [];
  return shown.filter((s): s is ShownText => typeof s?.label === "string" && typeof s?.text === "string" && typeof s?.meta?.file === "string");
}
