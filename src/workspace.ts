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
}

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

  return {
    root,
    async readText(rel, { signal, maxBytes = 1_000_000 } = {}) {
      signal?.throwIfAborted();
      checkRelative(rel);
      const target = path.resolve(root, rel);
      if (!isInside(root, target)) throw denied();
      const real = realOrNull(target); // follows symlinks/junctions
      if (!real || !isInside(root, real)) throw denied();
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
        await fh.read(buf, 0, size, 0);
      } finally {
        await fh.close();
      }
      signal?.throwIfAborted();
      if (buf.includes(0)) throw new Error("binary file not supported");
      return buf.toString("utf8");
    },
  };
}
