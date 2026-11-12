// Audit log v0: one append-only JSONL file per session, one record per line.
// Record = { v, seq, ts, session, type, ...data }. `seq` counts up from 1 within the session.
// Local only, git-ignored (audit/). `v` is the record format version.
// A failed write throws: the caller must stop the run (fail closed, see cli.ts).
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fold, isInside, PROJECT_ROOT } from "./workspace.ts";

export interface AuditLog {
  /** Absolute path of this session's file. */
  readonly path: string;
  readonly session: string;
  /** Append one record. Throws if the record cannot be written. */
  write(type: string, data?: Record<string, unknown>): void;
}

const ENVELOPE = ["v", "seq", "ts", "session", "type"];

/**
 * Create the audit folder if needed and open a new session file inside it.
 * Refuses a folder that is, contains, or sits inside the workspace: the model's read_file could
 * otherwise read the log (which holds earlier file contents).
 */
export function createAuditLog(dir: string, workspaceRoot: string, projectRoot: string = PROJECT_ROOT): AuditLog {
  const requested = path.resolve(projectRoot, dir); // relative paths resolve against the project, not the cwd
  fs.mkdirSync(requested, { recursive: true });
  const root = fs.realpathSync.native(requested);
  const ws = fs.realpathSync.native(workspaceRoot);
  if (fold(root) === fold(ws) || isInside(ws, root) || isInside(root, ws)) {
    throw new Error(`Audit folder ${root} overlaps the workspace ${ws}. Pick a separate folder (AUDIT_DIR).`);
  }

  const session = randomBytes(3).toString("hex");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(root, `session-${stamp}-${session}.jsonl`);
  fs.writeFileSync(file, "", { flag: "wx" }); // "wx": never overwrite or reuse an existing log

  let seq = 0;
  return {
    path: file,
    session,
    write(type, data = {}) {
      for (const k of ENVELOPE) {
        if (k in data) throw new Error(`audit data may not use the reserved key "${k}"`);
      }
      // JSON.stringify escapes newlines and control characters, so a record is always exactly one line.
      const line = JSON.stringify({ v: 1, seq: seq + 1, ts: new Date().toISOString(), session, type, ...data });
      fs.appendFileSync(file, line + "\n");
      seq++; // only counted once the line is on disk
    },
  };
}
