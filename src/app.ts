// The Herdr window (`herdr-app`): spaces, tabs and panes. Driven through its CLI, which
// talks to the running window; nothing here opens a window.

import { execFile } from "node:child_process";

export const appBin = (): string => process.env.HERDR_MCP_APP ?? "herdr-app";

export interface AppResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runApp(args: string[], timeoutMs = 30_000): Promise<AppResult> {
  return new Promise((resolve, reject) => {
    execFile(
      appBin(),
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const e = err as NodeJS.ErrnoException | null;
        if (e && e.code === "ENOENT") {
          reject(
            new Error(
              `could not start \`${appBin()}\`: the Herdr desktop app is not installed or not on PATH. ` +
                `Set HERDR_MCP_APP to its binary, or use the hc tools, which need only herdr-core.`,
            ),
          );
          return;
        }
        if (e && (e as { killed?: boolean }).killed) {
          reject(new Error(`herdr-app ${args[0]} timed out after ${timeoutMs / 1000}s: is the window open?`));
          return;
        }
        const code = e && typeof (e as { code?: unknown }).code === "number" ? (e.code as unknown as number) : 0;
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

/** Parse JSON when the output is JSON, else return it as text. */
export function parseOutput(s: string): unknown {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
