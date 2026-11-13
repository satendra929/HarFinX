// The one folder the harness may touch. Fixed at startup, never changeable at runtime.
// Tools get a Workspace handle by closure and can only use its methods; they never import node:fs
// for user data and the model never supplies the root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ReadOptions {
  signal?: AbortSignal;
  maxBytes?: number;
}

export interface Workspace {
  readonly root: string;
  /** Read a UTF-8 text file by path relative to the workspace root. */
  readText(rel: string, opts?: ReadOptions): Promise<string>;
  /** Read a file's raw bytes (for formats such as PDF). Same path checks as readText; default limit 50 MB. */
  readBytes(rel: string, opts?: ReadOptions): Promise<Buffer>;
  /** The files in the workspace (see listFiles). */
  list(opts?: ListOptions): FileListing;
}

export interface ListOptions {
  maxEntries?: number;
  maxDepth?: number;
}
export interface FileEntry {
  path: string; // relative, forward slashes
  size: number;
}
export interface FileListing {
  files: FileEntry[];
  truncated: boolean;
}
export const LIST_LIMITS = { maxEntries: 100, maxDepth: 4, maxVisited: 5_000 };

export const DEFAULT_TEXT_MAX_BYTES = 1_000_000;
export const DEFAULT_BYTES_MAX_BYTES = 50_000_000;

// One message for "missing" and "outside", so the model cannot probe what exists elsewhere.
const denied = () => new Error("not found or not allowed");

// Characters Windows forbids in names (also blocks NTFS streams `a:b`, `\\?\`, wildcards, NUL, control chars).
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

export const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/** True if `target` is strictly inside `root` (segment-wise, not a string-prefix check). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(fold(root), fold(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/** Lexical checks on a model-supplied relative path. Throws the generic denial. */
export function checkRelative(rel: unknown): string {
  if (typeof rel !== "string" || rel === "" || BAD_CHARS.test(rel)) throw denied();
  if (/^[\\/]/.test(rel) || path.win32.isAbsolute(rel) || path.isAbsolute(rel)) throw denied();
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw denied();
    if (/[. ]$/.test(seg)) throw denied(); // Windows strips trailing dots/spaces ("CON." == "CON")
    if (DEVICE_NAME.test(seg.split(".")[0].trim())) throw denied();
  }
  return rel;
}

function realOrNull(p: string | undefined): string | null {
  if (!p) return null;
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * First-run convenience: create the workspace folder if it is missing AND lies inside the project
 * folder (the default `workspace/`). A missing folder elsewhere is left alone, so a typo in
 * WORKSPACE_DIR still gets the normal refusal instead of silently creating directories.
 * Returns the created path, or undefined if nothing was created.
 */
export function ensureWorkspaceDir(dir: string, projectRoot: string = PROJECT_ROOT): string | undefined {
  const target = path.resolve(projectRoot, dir);
  if (fs.existsSync(target) || !isInside(projectRoot, target)) return undefined;
  try {
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch {
    return undefined; // e.g. a parent is a file; openWorkspace reports it
  }
}

/** Validate the folder at startup and return a handle. Throws a readable error on refusal. */
export function openWorkspace(
  dir: string,
  projectRoot: string = PROJECT_ROOT,
  homes: (string | undefined)[] = [os.homedir(), process.env.USERPROFILE],
): Workspace {
  const requested = path.resolve(projectRoot, dir); // relative paths resolve against the project, not the cwd
  const root = realOrNull(requested);
  if (!root || !fs.statSync(root).isDirectory()) {
    throw new Error(`Workspace folder not found or not a directory: ${requested}`);
  }
  if (path.parse(root).root === root) throw new Error(`Workspace cannot be a drive root: ${root}`);

  // Refuse the home folder, the project (holds .env and src/), and anything that contains them.
  for (const [label, p] of [["your home folder", homes[0]], ["your user profile", homes[1]], ["the project folder", projectRoot]] as const) {
    const real = realOrNull(p);
    if (real && (fold(real) === fold(root) || isInside(root, real))) {
      throw new Error(`Workspace ${root} is, or contains, ${label}. Pick a dedicated folder.`);
    }
  }

  // The one checked path to a file's bytes: every read goes through here, so every path attack is blocked once.
  const rootDir: string = root; // validated above (a nested function does not keep the narrowing of `root`)
  async function readChecked(rel: string, signal: AbortSignal | undefined, maxBytes: number): Promise<Buffer> {
    signal?.throwIfAborted();
    checkRelative(rel);
    const target = path.resolve(rootDir, rel);
    if (!isInside(rootDir, target)) throw denied();
    const real = realOrNull(target); // follows symlinks/junctions
    if (!real || !isInside(rootDir, real)) throw denied();
    // Residual risk: a path swapped between this check and open (TOCTOU). Not reachable with
    // read-only tools; revisit when a write or shell tool exists.
    let size: number;
    try {
      const st = fs.statSync(real);
      if (!st.isFile()) throw denied(); // directories, pipes, devices
      size = st.size;
    } catch {
      throw denied();
    }
    if (size > maxBytes) throw new Error(`file too large (${size} bytes, limit ${maxBytes})`);
    const buf = Buffer.alloc(size);
    const fh = await fs.promises.open(real, "r");
    try {
      let got = 0;
      while (got < size) {
        const { bytesRead } = await fh.read(buf, got, size - got, got);
        if (bytesRead === 0) break; // the file shrank after the size check: return what exists, never zero padding
        got += bytesRead;
      }
      signal?.throwIfAborted();
      return got === size ? buf : buf.subarray(0, got);
    } finally {
      await fh.close();
    }
  }

  return {
    root,
    async readText(rel, { signal, maxBytes = DEFAULT_TEXT_MAX_BYTES } = {}) {
      const buf = await readChecked(rel, signal, maxBytes);
      if (buf.includes(0)) throw new Error("binary file not supported");
      return buf.toString("utf8");
    },
    readBytes(rel, { signal, maxBytes = DEFAULT_BYTES_MAX_BYTES } = {}) {
      return readChecked(rel, signal, maxBytes);
    },
    list({ maxEntries = LIST_LIMITS.maxEntries, maxDepth = LIST_LIMITS.maxDepth } = {}) {
      // Regular files only. Symlinks and junctions are skipped, never followed (a link could point outside, and even
      // its size would leak). Dot-names are hidden. Names that the read path would refuse are left out, so everything
      // listed can be read, and no control characters reach the model or the terminal.
      const files: FileEntry[] = [];
      let visited = 0;
      let cut = false;
      const walk = (dir: string, prefix: string, depth: number) => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (++visited > LIST_LIMITS.maxVisited) {
            cut = true;
            return;
          }
          if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          try {
            checkRelative(rel);
          } catch {
            continue;
          }
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (depth < maxDepth) walk(full, rel, depth + 1);
            else cut = true;
          } else if (e.isFile()) {
            try {
              const st = fs.lstatSync(full);
              if (st.isFile()) files.push({ path: rel, size: st.size });
            } catch {
              /* vanished while listing */
            }
          }
        }
      };
      walk(rootDir, "", 1);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { files: files.slice(0, maxEntries), truncated: cut || files.length > maxEntries };
    },
  };
}
