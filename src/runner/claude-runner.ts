import { setTimeout as sleep } from "node:timers/promises";
import { capturePane, killSession, newSession, sendEnter, sendKeys, sendKeysLiteral, sessionExists } from "./tmux.ts";

export interface ClaudeRunnerOptions {
  session: string;
  cwd: string;
  command?: string;
  env?: Record<string, string>;
  loginRequiredPatterns?: RegExp[];
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

const READY = /shift\+tab to cycle|for shortcuts/i;

export interface ReadyResult {
  ready: boolean;
  reason?: string;
}

export class ClaudeRunner {
  private readonly opts: Required<Omit<ClaudeRunnerOptions, "command" | "env">> & {
    command?: string;
    env?: Record<string, string>;
  };
  private spawned = false;

  constructor(options: ClaudeRunnerOptions) {
    this.opts = {
      session: options.session,
      cwd: options.cwd,
      command: options.command ?? "",
      env: options.env ?? {},
      loginRequiredPatterns: options.loginRequiredPatterns ?? DEFAULT_LOGIN_PATTERNS,
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
    const args: { session: string; cwd: string; command?: string; env?: Record<string, string> } = {
      session: this.opts.session,
      cwd: this.opts.cwd,
    };
    if (this.opts.command) args.command = this.opts.command;
    if (this.opts.env && Object.keys(this.opts.env).length > 0) args.env = this.opts.env;
    newSession(args);
    this.spawned = true;
  }

  // Drive the one-time first-run gates (trust folder, bypass-permissions warning,
  // and — defensively — the theme picker) until claude reaches the input prompt.
  // The login-method gate must NOT be touched: selecting it starts a fresh OAuth
  // flow that ignores the credential file, so onboarding must be pre-seeded.
  async clearGatesAndAwaitReady(timeoutMs = 90000): Promise<ReadyResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(1500);
      const pane = this.capture(80);
      if (READY.test(pane)) return { ready: true };
      if (/Select login method/i.test(pane)) {
        return { ready: false, reason: "login gate appeared — onboarding not seeded; the credential won't be used" };
      }
      if (/New MCP server found|Use this and all future MCP servers/i.test(pane)) {
        // Option 2: "Use this and all future MCP servers in this project" (remembered).
        sendKeys(this.opts.session, "Down", false);
        await sleep(400);
        sendEnter(this.opts.session);
        continue;
      }
      if (/I trust this folder/i.test(pane)) {
        sendEnter(this.opts.session);
        continue;
      }
      if (/Yes, I accept/i.test(pane)) {
        sendKeys(this.opts.session, "Down", false);
        await sleep(400);
        sendEnter(this.opts.session);
        continue;
      }
      if (/Choose the text style/i.test(pane)) {
        sendEnter(this.opts.session);
        continue;
      }
    }
    return { ready: false, reason: "timed out waiting for the claude prompt" };
  }

  // Submit reliably: send the text literally (bracketed-paste safe), pause, then a
  // separate Enter. A single bundled "text+Enter" gets the Enter eaten as a newline
  // by claude's input (especially under vim editorMode).
  async send(prompt: string): Promise<void> {
    if (!sessionExists(this.opts.session)) throw new Error(`session ${this.opts.session} not running`);
    sendKeysLiteral(this.opts.session, prompt);
    await sleep(800);
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
