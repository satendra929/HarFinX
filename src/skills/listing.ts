// What /skills and the start-up banner say about the skills. Pure. Everything that came from a file or a folder name goes through
// oneLine, so a name or a reason cannot carry terminal control or direction characters.
import { oneLine } from "../feedback.ts";
import type { SkillCatalog } from "./catalog.ts";

/** The lines of /skills. `active` is false when skills were found but are not offered to the model (a model that is not on this machine). */
export function skillsListing(catalog: SkillCatalog, active: boolean): string[] {
  const out: string[] = [];
  if (!catalog.dir) {
    out.push(catalog.notes.length ? oneLine(catalog.notes[0], 200) : "No skills folder is in use (SKILLS_DIR=off or the folder does not exist).");
    return out;
  }
  out.push(`Skills folder: ${oneLine(catalog.dir, 120)}`);
  for (const n of catalog.notes) out.push(oneLine(n, 200));
  if (!active && catalog.skills.length) out.push("Not offered to the model: file access is off for it, and skills follow the same rule.");
  if (!catalog.skills.length && !catalog.rejected.length) out.push("The folder holds no skills.");
  for (const s of catalog.skills) {
    const l = s.lint;
    const flags = [l.figures.length ? `${l.figures.length} figure${l.figures.length === 1 ? "" : "s"}` : "", l.numbers.length ? `${l.numbers.length} bare number${l.numbers.length === 1 ? "" : "s"}` : "", l.relativeFiles.length ? "file paths" : ""].filter(Boolean);
    out.push(`  ${oneLine(s.name, 64)}  (${s.body.length} characters, sha256 ${s.sha256.slice(0, 12)})${flags.length ? `  lint: ${flags.join(", ")}` : ""}`);
    out.push(`    ${oneLine(s.description, 300)}`);
    for (const n of s.notes) out.push(`    note: ${oneLine(n, 200)}`);
  }
  for (const r of catalog.rejected) out.push(`  not loaded: ${oneLine(r.dir, 64)}: ${oneLine(r.reason, 240)}`);
  return out;
}

/** One line for the start-up banner, or undefined when there is nothing to say. */
export function skillsBanner(catalog: SkillCatalog, active: boolean): string | undefined {
  if (!catalog.dir && !catalog.notes.length) return undefined;
  if (!catalog.dir) return oneLine(catalog.notes[0], 200);
  if (!catalog.skills.length && !catalog.rejected.length) return undefined;
  const names = catalog.skills.map((s) => oneLine(s.name, 40)).join(", ");
  const parts = [`Skills: ${catalog.skills.length} loaded${names ? ` (${names})` : ""}`];
  if (catalog.rejected.length) parts.push(`${catalog.rejected.length} not loaded`);
  if (!active && catalog.skills.length) parts.push("not offered to this model");
  return parts.join("; ") + ". /skills shows the details.";
}
