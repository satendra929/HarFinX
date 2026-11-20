// A skill file (SKILL.md): the text rules and the frontmatter grammar. Pure: no I/O, no state.
//
// The grammar is a small strict subset of YAML on purpose. A skill must read the same in this harness and in any other client of the
// Agent Skills format, so this parser accepts only what real YAML reads identically and rejects the rest with a message that says
// what to change. It never evaluates anything, has no anchors, aliases, tags or flow collections, and does no backtracking pattern
// matching over unbounded input (line by line; the frontmatter is at most MAX_FRONT_LINES lines).
//
// Accepted: `key: value` on one line (plain, 'single-quoted' or "double-quoted" with only \" and \\ escapes); `description: >` or
// `>-` followed by lines with one common indentation (folded into one line); `metadata:` with indented `key: value` lines; any
// other key, with or without indented lines under it, is read past and reported (so `allowed-tools:` and its list never sink a skill).

/** Keys a map must never take, whatever the language does with them. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_FRONT_LINES = 100;
const MAX_METADATA = 20;

export type TextResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * The text of a skill file from its bytes, in a fixed order: not UTF-16, no NUL, strict UTF-8, one leading BOM removed, CRLF changed
 * to LF (a lone CR is refused), no control characters other than the line feed and the tab, no invisible format characters.
 * The result is what is hashed and what the model sees, so a checkout with LF and an editor that saves CRLF agree.
 */
export function skillText(bytes: Uint8Array): TextResult {
  const b = Buffer.from(bytes);
  const hint = "save the file as UTF-8 (PowerShell 5.1 `>` writes UTF-16)";
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return { ok: false, reason: `the file is UTF-16: ${hint}` };
  if (b.includes(0)) return { ok: false, reason: `the file contains NUL bytes: ${hint}` };
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    return { ok: false, reason: `the file is not valid UTF-8: ${hint}` };
  }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n/g, "\n");
  if (s.includes("\r")) return { ok: false, reason: "the file has a carriage return that is not part of a line end" };
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(s)) return { ok: false, reason: "the file has control characters" };
  if (/[\p{Cf}\p{Zl}\p{Zp}]/u.test(s)) return { ok: false, reason: "the file has zero-width, direction or other invisible format characters" };
  return { ok: true, text: s };
}

export interface ParsedSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Raw strings (YAML would read 1.10 as a number; here it stays "1.10"). Kept for the listing, no behaviour. */
  metadata: Map<string, string>;
  /** Keys that were read past without effect (allowed-tools, disable-model-invocation, anything unknown). */
  ignoredKeys: string[];
  /** Everything after the closing `---`, trimmed. */
  body: string;
}
export type ParseResult = { ok: true; value: ParsedSkill } | { ok: false; reason: string };

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/; // a leading underscore is read so that __proto__ gets its own message
const PLAIN_START_BAD = /^[-?:,[\]{}#&*!%@`|>]/;
// A plain value that YAML would read as null, a boolean or a number: quote it to keep it text.
const NOT_A_STRING = /^(?:~|null|true|false|yes|no|on|off|y|n|[-+]?\d[\d_]*(?:\.\d*)?(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i;

/** A one-line scalar: plain, single-quoted or double-quoted. A string is an error message. */
function scalar(raw: string): { value: string; quoted: boolean } | string {
  const v = raw.trim();
  if (v === "") return { value: "", quoted: false };
  const first = v[0];
  if (first === "'" || first === '"') {
    let out = "";
    let i = 1;
    for (;;) {
      if (i >= v.length) return "a quoted value must close on the same line";
      const c = v[i];
      if (first === "'") {
        if (c === "'") {
          if (v[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          break;
        }
        out += c;
        i++;
      } else {
        if (c === '"') break;
        if (c === "\\") {
          const n = v[i + 1];
          if (n !== '"' && n !== "\\") return 'in a double-quoted value only \\" and \\\\ are allowed after a backslash';
          out += n;
          i += 2;
          continue;
        }
        out += c;
        i++;
      }
    }
    if (!/^\s*(?:#.*)?$/.test(v.slice(i + 1))) return "there is text after the closing quote";
    return { value: out, quoted: true };
  }
  if (PLAIN_START_BAD.test(v)) return `a plain value cannot start with "${first}": put the value in quotes`;
  if (/ #/.test(v)) return 'a "#" after a space starts a comment in YAML: put the value in quotes';
  if (/: |:$/.test(v)) return 'a colon followed by a space is not allowed in a plain value: put the value in quotes (for example description: "Use when: ...")';
  return { value: v, quoted: false };
}

/** Parses a skill's text (already through skillText) into its fields and body. */
export function parseSkill(text: string): ParseResult {
  const fail = (reason: string): ParseResult => ({ ok: false, reason });
  const lines = text.split("\n");
  if (lines[0] !== "---") return fail("the file must start with a line that holds only ---");
  let close = -1;
  for (let i = 1; i < lines.length && i <= MAX_FRONT_LINES + 1; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return fail(`the frontmatter is not closed by a line that holds only --- within ${MAX_FRONT_LINES} lines`);
  if (close === 1) return fail("the frontmatter is empty: name and description are required");
  for (let i = 1; i < close; i++) if (/^ *\t/.test(lines[i])) return fail(`line ${i + 1}: a tab in the indentation (use spaces)`);

  const fields = new Map<string, string>();
  const metadata = new Map<string, string>();
  const ignored: string[] = [];
  const seen = new Set<string>();
  let mode: "none" | "metadata" | "skip" = "none"; // what an indented line means right now

  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const at = `line ${i + 1}`;
    if (/^\s*$/.test(line) || line.trimStart().startsWith("#")) continue;
    if (line.startsWith(" ")) {
      if (mode === "skip") continue;
      if (mode === "metadata") {
        const m = /^ +([A-Za-z0-9_.-]+):(?: (.*))?$/.exec(line);
        if (!m) continue; // a line of the map we cannot read: ignored, never a failure
        if (FORBIDDEN_KEYS.has(m[1])) return fail(`${at}: the key "${m[1]}" is not allowed`);
        if (metadata.has(m[1])) return fail(`${at}: duplicate metadata key "${m[1]}"`);
        if (metadata.size >= MAX_METADATA) continue;
        const raw = (m[2] ?? "").trim();
        const s = raw.startsWith("'") || raw.startsWith('"') ? scalar(raw) : { value: raw, quoted: false };
        metadata.set(m[1], typeof s === "string" ? raw : s.value);
        continue;
      }
      return fail(`${at}: an indented line under a value (a multi-line value is not supported; for a long description use "description: >")`);
    }
    const m = KEY.exec(line);
    if (!m) return fail(`${at}: not a "key: value" line`);
    const key = m[1];
    if (m[2] !== "" && !m[2].startsWith(" ")) return fail(`${at}: put a space after "${key}:"`);
    if (FORBIDDEN_KEYS.has(key)) return fail(`${at}: the key "${key}" is not allowed`);
    if (seen.has(key)) return fail(`${at}: duplicate key "${key}"`);
    seen.add(key);
    const value = m[2].trim();
    mode = "none";

    if (key === "metadata") {
      if (value !== "") return fail(`${at}: metadata must be a map (put its entries on indented lines)`);
      mode = "metadata";
      continue;
    }
    if (key !== "name" && key !== "description" && key !== "license" && key !== "compatibility") {
      ignored.push(key); // allowed-tools, disable-model-invocation, anything else: read past, no effect
      mode = "skip";
      continue;
    }
    if (key === "description" && (value === ">" || value === ">-")) {
      const block: string[] = [];
      let indent = -1;
      let j = i + 1;
      while (j < close) {
        const l = lines[j];
        if (/^\s*$/.test(l)) {
          let k = j + 1;
          while (k < close && /^\s*$/.test(lines[k])) k++;
          if (k < close && lines[k].startsWith(" ")) return fail(`line ${j + 1}: a blank line inside the description (write it as one paragraph)`);
          break;
        }
        if (!l.startsWith(" ")) break;
        const lead = l.length - l.trimStart().length;
        if (indent === -1) indent = lead;
        else if (lead !== indent) return fail(`line ${j + 1}: the lines of the description must all be indented the same`);
        block.push(l.trim());
        j++;
      }
      if (block.length === 0) return fail(`${at}: the description block is empty`);
      fields.set("description", block.join(" "));
      i = j - 1;
      continue;
    }
    if (value.startsWith("|") || value.startsWith(">")) return fail(`${at}: a block value is only allowed for the description, as ">"`);
    if (value === "") return fail(`${at}: "${key}" has no value`);
    const s = scalar(value);
    if (typeof s === "string") return fail(`${at} (${key}): ${s}`);
    if (!s.quoted && NOT_A_STRING.test(s.value)) return fail(`${at} (${key}): "${s.value}" would be read by YAML as a number, a boolean or null: put it in quotes`);
    fields.set(key, s.value);
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (!name) return fail("name is required");
  if (!description) return fail("description is required");
  return {
    ok: true,
    value: {
      name,
      description,
      license: fields.get("license"),
      compatibility: fields.get("compatibility"),
      metadata,
      ignoredKeys: ignored,
      body: lines.slice(close + 1).join("\n").trim(),
    },
  };
}
