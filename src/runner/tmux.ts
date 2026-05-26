import { execFileSync, spawnSync } from "node:child_process";

export class TmuxError extends Error {}

// A dedicated socket keeps claude-loop sessions isolated from the user's
// interactive tmux server, and — because the first command on a new socket
// spawns a fresh server — guarantees the server inherits this process's env
// (notably CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) instead of whatever
// a long-running interactive server was started with.
export const SOCKET = "claude-loop";

function tmux(args: string[], opts: { input?: string } = {}): string {
  const result = spawnSync("tmux", ["-L", SOCKET, ...args], {
    encoding: "utf8",
    input: opts.input,
  });
  if (result.status !== 0) {
    throw new TmuxError(`tmux ${args.join(" ")} failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function sessionExists(session: string): boolean {
  const result = spawnSync("tmux", ["-L", SOCKET, "has-session", "-t", session], { encoding: "utf8" });
  return result.status === 0;
}

export function newSession(args: { session: string; cwd?: string; command?: string }): void {
  const cmd = ["new-session", "-d", "-s", args.session];
  if (args.cwd) cmd.push("-c", args.cwd);
  if (args.command) cmd.push(args.command);
  tmux(cmd);
}

export function killSession(session: string): void {
  if (!sessionExists(session)) return;
  tmux(["kill-session", "-t", session]);
}

export function sendKeys(session: string, keys: string, enter = true): void {
  const args = ["send-keys", "-t", session, keys];
  if (enter) args.push("Enter");
  tmux(args);
}

export function sendEnter(session: string): void {
  tmux(["send-keys", "-t", session, "Enter"]);
}

export function capturePane(session: string, lines = 2000): string {
  return tmux(["capture-pane", "-pt", session, "-S", `-${lines}`]);
}

export function listSessions(): string[] {
  const result = spawnSync("tmux", ["-L", SOCKET, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function tmuxInstalled(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
