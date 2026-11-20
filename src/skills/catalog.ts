// Skills: find them once at startup, check each one, keep what passed. A skill is a folder `<SKILLS_DIR>/<name>/SKILL.md` (depth 1).
// Strict and fail-soft: a bad skill is skipped and reported, the session starts; a misplaced skills folder is a configuration error
// and stops startup, like the workspace and the audit folder. The text of each valid skill is read, checked and hashed HERE, once; the
// tool serves that cached text, so a file edited after startup can never get past the limits or the checks (src/tools/readSkill.ts).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fold, isInside, PROJECT_ROOT } from "../workspace.ts";
import { extractNumbers, normalise } from "../provenance.ts";
import { parseSkill, skillText } from "./parse.ts";

/** Limits chosen for a small local model with a 16k window: every catalog token is paid on every model call. */
export const SKILL_LIMITS = {
  maxSkills: 8,
  maxEntries: 50, // directory entries read in the skills folder
  fileBytes: 20_000,
  nameChars: 64,
  descriptionChars: 300,
  bodyChars: 4_000, // plus the wrapper this stays under the guard's 5,000-character cut of a tool result
  catalogChars: 1_600,
  compatibilityChars: 500,
};

/** Folder names git ignores at any depth (.gitignore and .git/info/exclude): a skill with such a name would silently miss a commit. */
const GIT_IGNORED_NAMES = new Set(["build", "dist", "docs", "tmp", "logs", "sessions", "coverage", "workspace", "audit", "testspace", "node_modules"]);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillLint {
  /** Money, percent, scale-word and decimal numbers in the skill: a skill must hold none (the harness checks figures, a skill is not a source). */
  figures: string[];
  /** Other bare numbers that are not list numbers or years. The constants 0 to 12, 100, 360, 365, 1000 are exempt from citation, so a skill that says "multiply by 8" would let the model state a cited figure resting on an assumption the skill supplied. */
  numbers: string[];
  /** Paths such as references/x.md or scripts/run.py: the model could go and read a same-named user file. */
  relativeFiles: string[];
}

export interface Skill {
  name: string;
  description: string;
  /** The text the model gets (body only), cached at startup. */
  body: string;
  /** sha256 of the whole file as text (BOM removed, CRLF as LF): the evidence in the audit log of what was loaded. */
  sha256: string;
  descriptionSha256: string;
  license?: string;
  compatibility?: string;
  metadata: Map<string, string>;
  /** Things read past or ignored: keys, scripts/ and references/ folders. */
  notes: string[];
  lint: SkillLint;
}

export interface RejectedSkill {
  /** The folder name as it appears on disk. */
  dir: string;
  reason: string;
}

export interface SkillCatalog {
  /** The folder skills were read from; undefined when there is none. */
  dir?: string;
  skills: Skill[];
  rejected: RejectedSkill[];
  /** Messages about the folder as a whole (missing, more entries than were read). */
  notes: string[];
  /** One line per listed skill: `- name: description`. Empty when there are no skills. */
  catalogText: string;
}

export const EMPTY_CATALOG: SkillCatalog = { skills: [], rejected: [], notes: [], catalogText: "" };

export const catalogLine = (s: Pick<Skill, "name" | "description">): string => `- ${s.name}: ${s.description}`;

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * What a skill must not hold, by the gate's own number rules (labels such as Item 7, 10-K or ASC 606 are blanked first, as everywhere).
 * `isNonFigure` is not used: it also exempts the constants, and those are exactly what the second list is for.
 */
export function lintSkillText(text: string): SkillLint {
  const figures: string[] = [];
  const numbers: string[] = [];
  for (const t of extractNumbers(normalise(text))) {
    const bare = t.decimals === 0 && !t.percent && !t.money && !t.scale;
    if (!bare) figures.push(t.raw);
    else if (t.lineStart && t.followedByListMark && Number(t.canon) <= 30) continue; // a list number
    else if (/^(19|20)\d\d$/.test(t.canon) && !t.raw.includes(",")) continue; // a year
    else numbers.push(t.raw);
  }
  const files = new Set<string>();
  for (const m of text.matchAll(/\b(?:references|scripts|assets)\/[\w./-]*|[\w-]+\.(?:md|py|js|ts|sh|json|csv|txt|pdf)\b/g)) files.add(m[0]);
  return { figures, numbers, relativeFiles: [...files].slice(0, 5) };
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}
const overlaps = (a: string, b: string): boolean => fold(a) === fold(b) || isInside(a, b) || isInside(b, a);

export interface DiscoverOptions {
  /** SKILLS_DIR: relative paths resolve against the project folder. "off" (any case) means no skills. */
  dir: string;
  projectRoot?: string;
  /** Folders the skills folder must not overlap (the model's file tools read the workspace; the audit log holds earlier file text). */
  workspaceRoot?: string;
  auditDir?: string;
  /** The folder was named by the user (a missing folder is then said, not silent). */
  explicit?: boolean;
}

/** Reads the skills folder. Throws only for a folder that must not be used (outside the project, or overlapping the workspace, the audit folder or the eval data). */
export function discoverSkills(opts: DiscoverOptions): SkillCatalog {
  if (opts.dir.trim().toLowerCase() === "off") return { ...EMPTY_CATALOG, notes: [] };
  const projectRoot = realOrNull(opts.projectRoot ?? PROJECT_ROOT) ?? path.resolve(opts.projectRoot ?? PROJECT_ROOT);
  const requested = path.resolve(opts.projectRoot ?? PROJECT_ROOT, opts.dir);
  const root = realOrNull(requested);
  if (!root) {
    return { skills: [], rejected: [], notes: opts.explicit ? [`The skills folder ${requested} was not found: no skills are loaded.`] : [], catalogText: "" };
  }
  if (!fs.statSync(root).isDirectory()) throw new Error(`SKILLS_DIR ${root} is not a folder.`);
  if (!isInside(projectRoot, root)) throw new Error(`SKILLS_DIR ${root} must be a folder inside the project (${projectRoot}), and not the project itself.`);
  const keepApart: [string, string | undefined][] = [
    ["the workspace", opts.workspaceRoot],
    ["the audit folder", opts.auditDir],
    ["the eval data folder", path.join(projectRoot, "eval", "data")],
  ];
  for (const [label, p] of keepApart) {
    if (!p) continue;
    const real = realOrNull(p) ?? path.resolve(p);
    if (overlaps(root, real)) throw new Error(`SKILLS_DIR ${root} overlaps ${label} ${real}. Pick a separate folder.`);
  }

  const notes: string[] = [];
  const rejected: RejectedSkill[] = [];
  const found: Skill[] = [];
  let entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.length > SKILL_LIMITS.maxEntries) {
    notes.push(`The skills folder has ${entries.length} entries; only the first ${SKILL_LIMITS.maxEntries} were read.`);
    entries = entries.slice(0, SKILL_LIMITS.maxEntries);
  }

  for (const entry of entries) {
    const dir = entry.name;
    if (dir.startsWith(".")) continue;
    const reject = (reason: string) => void rejected.push({ dir, reason });
    if (entry.isSymbolicLink()) {
      reject("a link (symlink or junction) is not followed");
      continue;
    }
    if (!entry.isDirectory()) continue; // a README.md or notes beside the skills
    if (dir.length > SKILL_LIMITS.nameChars || !NAME.test(dir)) {
      reject(`the folder name must be lowercase letters, digits and single hyphens, at most ${SKILL_LIMITS.nameChars} characters`);
      continue;
    }
    if (GIT_IGNORED_NAMES.has(dir)) {
      reject("git ignores a folder with this name, so the skill would silently miss a commit: pick another name");
      continue;
    }

    const skillDir = path.join(root, dir);
    const inner = fs.readdirSync(skillDir, { withFileTypes: true });
    const file = inner.find((e) => e.name === "SKILL.md"); // the exact name: NTFS would also find skill.md
    if (!file) {
      reject(inner.some((e) => e.name.toLowerCase() === "skill.md") ? "the file must be named exactly SKILL.md" : "there is no SKILL.md");
      continue;
    }
    if (file.isSymbolicLink() || !file.isFile()) {
      reject("SKILL.md must be a regular file (a link is not followed)");
      continue;
    }
    const filePath = path.join(skillDir, "SKILL.md");
    const realFile = realOrNull(filePath);
    if (!realFile || !isInside(root, realFile)) {
      reject("SKILL.md resolves outside the skills folder");
      continue;
    }
    if (fs.statSync(realFile).size > SKILL_LIMITS.fileBytes) {
      reject(`SKILL.md is larger than ${SKILL_LIMITS.fileBytes} bytes`);
      continue;
    }
    const bytes = fs.readFileSync(realFile);
    if (bytes.length > SKILL_LIMITS.fileBytes) {
      reject(`SKILL.md is larger than ${SKILL_LIMITS.fileBytes} bytes`);
      continue;
    }

    const text = skillText(bytes);
    if (!text.ok) {
      reject(text.reason);
      continue;
    }
    const parsed = parseSkill(text.text);
    if (!parsed.ok) {
      reject(parsed.reason);
      continue;
    }
    const p = parsed.value;
    const problem = fieldProblem(p, dir);
    if (problem) {
      reject(problem);
      continue;
    }

    const skillNotes: string[] = [];
    for (const k of p.ignoredKeys) skillNotes.push(`the key "${k}" is read past and has no effect here`);
    for (const e of inner) {
      if (e.isDirectory() && (e.name === "scripts" || e.name === "assets")) skillNotes.push(`${e.name}/ is ignored (no shell or write tool exists)`);
      if (e.isDirectory() && e.name === "references") skillNotes.push("references/ is not read in this version");
    }
    found.push({
      name: p.name,
      description: p.description,
      body: p.body,
      sha256: sha256(text.text),
      descriptionSha256: sha256(p.description),
      license: p.license,
      compatibility: p.compatibility,
      metadata: p.metadata,
      notes: skillNotes,
      lint: lintSkillText(`${p.description}\n${p.body}`),
    });
  }

  // The caps, in name order so which skills are kept never depends on the directory order.
  const skills: Skill[] = [];
  let catalogChars = 0;
  for (const s of found) {
    const line = catalogLine(s);
    if (skills.length >= SKILL_LIMITS.maxSkills) {
      rejected.push({ dir: s.name, reason: `more than ${SKILL_LIMITS.maxSkills} skills: this one is not listed` });
    } else if (catalogChars + line.length + 1 > SKILL_LIMITS.catalogChars) {
      rejected.push({ dir: s.name, reason: `the list of skills would pass ${SKILL_LIMITS.catalogChars} characters: this one is not listed` });
    } else {
      skills.push(s);
      catalogChars += line.length + 1;
    }
  }
  return { dir: root, skills, rejected, notes, catalogText: skills.map(catalogLine).join("\n") };
}

/** The rules about the fields of a parsed skill; a message when one is broken. */
function fieldProblem(p: { name: string; description: string; body: string; compatibility?: string }, dir: string): string | undefined {
  if (p.name !== dir) return `name "${p.name}" must be the same as the folder name "${dir}"`;
  if (p.description.length > SKILL_LIMITS.descriptionChars) return `the description is ${p.description.length} characters; the limit is ${SKILL_LIMITS.descriptionChars}`;
  if (p.description.includes("<")) return 'the description cannot contain "<" (it is text the model reads on every call)';
  if (p.body.length === 0) return "the skill has no instructions after the frontmatter";
  if (p.body.length > SKILL_LIMITS.bodyChars) return `the instructions are ${p.body.length} characters; the limit is ${SKILL_LIMITS.bodyChars}`;
  if (/skill_content/i.test(p.body) || /skill_content/i.test(p.description)) return "the text cannot contain skill_content (the harness's own wrapper)";
  if (p.compatibility !== undefined && p.compatibility.length > SKILL_LIMITS.compatibilityChars) return `compatibility is longer than ${SKILL_LIMITS.compatibilityChars} characters`;
  return undefined;
}
