import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

/**
 * Turns whatever the caller typed into an absolute path to a real file.
 *
 * `~` is expanded here because Claude passes user-written paths through
 * verbatim and there is no shell in between to do it.
 */
export function resolveVideoPath(input: string): string {
  const trimmed = input.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(
      `Only local files are supported, got "${trimmed}". Download the video first and pass its path.`,
    );
  }

  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? resolve(homedir(), trimmed.slice(2))
    : trimmed;

  const path = resolve(expanded);

  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  if (!statSync(path).isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }

  return path;
}
