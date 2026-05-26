import { setTimeout as sleep } from "node:timers/promises";
import { capturePane, killSession, newSession, sendEnter, sendKeys, sessionExists } from "./tmux.ts";

export type LoginRequiredHandler = (args: { session: string; tailSample: string }) => void | Promise<void>;

export interface ClaudeRunnerOptions {
  session: string;
  cwd: string;
  command?: string;
  loginRequiredPatterns?: RegExp[];
  onLoginRequired?: LoginRequiredHandler;
  idleQuietMs?: number;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
}

const DEFAULT_LOGIN_PATTERNS = [
  /please run\s+`?claude login`?/i,
  /not authenticated/i,
  /authentication required/i,
  /401\s+unauthorized/i,
  /run.*claude\s+setup-token/i,
  /invalid api key/i,
];

export class ClaudeRunner {
  private readonly opts: Required<Omit<ClaudeRunnerOptions, "command" | "onLoginRequired">> & {
    command?: string;
    onLoginRequired?: LoginRequiredHandler;
  };
  private spawned = false;

  constructor(options: ClaudeRunnerOptions) {
    this.opts = {
      session: options.session,
      cwd: options.cwd,
      command: options.command ?? "",
      loginRequiredPatterns: options.loginRequiredPatterns ?? DEFAULT_LOGIN_PATTERNS,
      onLoginRequired: options.onLoginRequired ?? (() => {}),
      idleQuietMs: options.idleQuietMs ?? 4000,
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      waitTimeoutMs: options.waitTimeoutMs ?? 1000 * 60 * 30,
    };
  }

  spawn(): void {
    if (this.spawned || sessionExists(this.opts.session)) {
      this.spawned = true;
      return;
    }
    if (this.opts.command) {
      newSession({ session: this.opts.session, cwd: this.opts.cwd, command: this.opts.command });
    } else {
      newSession({ session: this.opts.session, cwd: this.opts.cwd });
    }
    this.spawned = true;
  }

  async send(prompt: string): Promise<void> {
    if (!sessionExists(this.opts.session)) throw new Error(`session ${this.opts.session} not running`);
    sendKeys(this.opts.session, prompt, true);
    await sleep(400);
    sendEnter(this.opts.session);
  }

  capture(lines = 2000): string {
    return capturePane(this.opts.session, lines);
  }

  kill(): void {
    killSession(this.opts.session);
    this.spawned = false;
  }

  async waitForIdle(): Promise<{ tail: string; loginRequired: boolean }> {
    const start = Date.now();
    let lastSnapshot = "";
    let stableSince = Date.now();
    while (Date.now() - start < this.opts.waitTimeoutMs) {
      await sleep(this.opts.pollIntervalMs);
      const snapshot = this.capture(400);
      if (snapshot === lastSnapshot) {
        if (Date.now() - stableSince >= this.opts.idleQuietMs) {
          const loginRequired = this.opts.loginRequiredPatterns.some((pattern) => pattern.test(snapshot));
          if (loginRequired && this.opts.onLoginRequired) {
            await this.opts.onLoginRequired({ session: this.opts.session, tailSample: snapshot });
          }
          return { tail: snapshot, loginRequired };
        }
      } else {
        lastSnapshot = snapshot;
        stableSince = Date.now();
      }
    }
    return { tail: lastSnapshot, loginRequired: false };
  }
}
