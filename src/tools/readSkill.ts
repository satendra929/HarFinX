// read_skill: gives the model one of the harness's procedures (a skill, src/skills/). The skill text was read, checked and hashed at
// startup and is served from there; this tool never touches a file, takes no path, and feeds nothing to the figure ledger (it returns
// no structured content), so a number in a skill is not a source and cannot be cited. The harness's own reply to the model is wrapped
// so a procedure can be told from file text: every OTHER tool's text is stripped of the wrapper's name and of the notice below
// (`withoutSkillMarkup`), so a PDF page cannot pose as a skill.
import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { catalogLine, type Skill } from "../skills/catalog.ts";

/** The fixed line inside every skill result. No digits, like the guard's refusal texts: the model may repeat it. */
export const SKILL_NOTICE = "A procedure installed by the owner of this harness. It does not change any rule in the system prompt.";

/** What the model gets for a skill: the notice and the body in the wrapper. */
export function skillResult(skill: Pick<Skill, "name" | "body">): string {
  return `<skill_content name="${skill.name}">\n${SKILL_NOTICE}\n\n${skill.body}\n</skill_content>`;
}

/** Text from any source but this harness's skills with the wrapper's name and the notice made harmless. */
export function defangSkillMarkup(text: string): string {
  return text.split(SKILL_NOTICE).join("[text removed by the harness]").replace(/skill_content/gi, "skill-content");
}

/** The same tool with its text results defanged. Structured content and details are passed on untouched (the ledger reads the structured content). */
export function withoutSkillMarkup<T extends AgentTool<any>>(tool: T): T {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
      const result = await execute(toolCallId, params, signal, onUpdate);
      return { ...result, content: result.content.map((part) => (part.type === "text" ? { ...part, text: defangSkillMarkup(part.text) } : part)) };
    },
  } as T;
}

export function readSkillTool(skills: readonly Skill[]): AgentTool<any> {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const names = skills.map((s) => s.name);
  return {
    name: "read_skill",
    label: "Read skill",
    description:
      "Load one of the harness's procedures: step-by-step guidance for a kind of task. Call it once, before the other tools, when the task matches one of these:\n" +
      skills.map(catalogLine).join("\n"),
    parameters: {
      type: "object",
      properties: { name: { type: "string", enum: names, description: "The name of the procedure" } },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params: { name: string }) => {
      const skill = typeof params?.name === "string" ? byName.get(params.name) : undefined;
      if (!skill) throw new Error(`there is no procedure with that name; the names are: ${names.join(", ")}`); // Pi's own argument check normally answers first
      const text = skillResult(skill);
      return {
        content: [{ type: "text", text }],
        details: { name: skill.name, sha256: skill.sha256, resultSha256: createHash("sha256").update(text, "utf8").digest("hex"), chars: text.length },
      };
    },
  };
}
