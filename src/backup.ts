import { closeSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup } from "node:sqlite";
import type { SqliteDatabase } from "./sqlite.js";
import { DepoError } from "./errors.js";

/** SQLite overwrites backup destinations, so reserve a new file before calling it. */
export async function backupDatabase(db: SqliteDatabase, target: string): Promise<void> {
  if (typeof target !== "string" || target.trim().length === 0 || target.includes("\0")) {
    throw new DepoError("Backup target must be a non-empty file path without null bytes");
  }
  if (target === ":memory:") throw new DepoError("Backup target must be a file, not :memory:");
  let destination: string;
  let fd: number;
  try {
    // Resolve the parent, not the destination itself: existing and dangling leaf
    // symlinks must still reach exclusive creation and be rejected untouched.
    const absoluteTarget = resolve(target);
    destination = join(realpathSync(dirname(absoluteTarget)), basename(absoluteTarget));
    // SQLite's opened filename is absolute; Store.path may be relative to a
    // working directory that the caller has since changed.
    const source = db.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get()?.["file"];
    if (typeof source === "string" && source !== "") {
      const sourcePaths = [realpathSync(source), source];
      const comparableTarget = process.platform === "win32" ? destination.toLowerCase() : destination;
      for (const sourcePath of sourcePaths) {
        const comparableSource = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
        if ([comparableSource, `${comparableSource}-wal`, `${comparableSource}-shm`, `${comparableSource}-journal`].includes(comparableTarget)) {
          throw new DepoError("Backup target must not be the source database or one of its SQLite sidecar files");
        }
      }
    }
    fd = openSync(destination, "wx", 0o600);
  } catch (error) {
    if (error instanceof DepoError) throw error;
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const hint = code === "EEXIST"
      ? "Target already exists; choose a new file (backups never overwrite)."
      : "Choose a new writable file in an existing parent directory; directories are not created.";
    throw new DepoError(`Cannot reserve backup target ${JSON.stringify(target)}. ${hint} ${errorMessage(error)}`, { cause: error });
  }

  try {
    await backup(db, destination);
  } catch (error) {
    // Do not delete a replacement installed by another process while backup was running.
    // Keep the descriptor open until this check so its file identity cannot be recycled.
    try {
      const reserved = fstatSync(fd, { bigint: true });
      const current = lstatSync(destination, { bigint: true });
      if (current.dev === reserved.dev && current.ino === reserved.ino && current.isFile()) unlinkSync(destination);
    } catch (cleanupError) {
      if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
        throw new DepoError(
          `Backup to ${JSON.stringify(target)} failed: ${errorMessage(error)}. Could not remove the incomplete target: ${errorMessage(cleanupError)}`,
          { cause: new AggregateError([error, cleanupError], "Backup and target cleanup failed") },
        );
      }
    }
    throw new DepoError(`Backup to ${JSON.stringify(target)} failed: ${errorMessage(error)}`, { cause: error });
  } finally {
    closeSync(fd);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
