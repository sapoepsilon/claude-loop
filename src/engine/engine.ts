import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ClaudeRunner } from "../runner/claude-runner.ts";
import type { ResolvedClaudeConfig } from "../config/claude-config.ts";
import type { AgentStage, Check, NotifyEvent, Pipeline, SkillStage, Stage } from "../config/pipeline.ts";

export interface EngineOptions {
  pipeline: Pipeline;
  config: ResolvedClaudeConfig;
  runId: string;
  autoApprove?: boolean;
  // The actionable item — written to .claudeloop/task.md and available as {{task}}.
  task?: string;
  // Arbitrary trigger-payload values, available in prompts/commands as {{vars.x}}.
  vars?: Record<string, string>;
}

export interface StageOutcome {
  stageId: string;
  attempts: number;
  passed: boolean;
  detail: string;
}

// Hard ceiling on stage transitions so a misconfigured goto loop can't spin
// forever even if a stage's max_attempts is generous.
const MAX_TRANSITIONS = 200;

function log(message: string): void {
  stdout.write(`[claude-loop] ${message}\n`);
}

function runShell(command: string, cwd: string): { code: number; output: string } {
  const result = spawnSync("bash", ["-lc", command], { cwd, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { code: result.status ?? 1, output };
}

function resolvePromptText(stage: AgentStage, projectDir: string): string {
  if (stage.promptText) return stage.promptText;
  const path = isAbsolute(stage.prompt as string) ? (stage.prompt as string) : resolve(projectDir, stage.prompt as string);
  return readFileSync(path, "utf8");
}

function skillPrompt(stage: SkillStage): string {
  if (stage.args) return `/${stage.skill} ${stage.args}`;
  return `/${stage.skill}`;
}

export class Engine {
  private readonly opts: EngineOptions;
  private readonly attempts = new Map<string, number>();
  private readonly lastOutput = new Map<string, string>();

  constructor(options: EngineOptions) {
    this.opts = options;
  }

  private async confirm(message: string): Promise<boolean> {
    if (this.opts.autoApprove) {
      log(`auto-approving gate: ${message}`);
      return true;
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(`[claude-loop] ${message} [y/N] `);
    rl.close();
    return answer.trim().toLowerCase().startsWith("y");
  }

  // Substitute {{task}}, {{run_id}}, {{pipeline}} and {{vars.KEY}} in any string
  // that gets executed (prompts, command/check `run`, pattern `success`).
  private render(text: string): string {
    const scalars: Record<string, string> = {
      task: this.opts.task ?? "",
      run_id: this.opts.runId,
      pipeline: this.opts.pipeline.name,
    };
    let out = text.replace(/\{\{\s*(task|run_id|pipeline)\s*\}\}/g, (_match, key: string) => scalars[key] ?? "");
    out = out.replace(/\{\{\s*vars\.([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => this.opts.vars?.[key] ?? "");
    return out;
  }

  private runNotify(status: NotifyEvent, stageId: string, detail: string): void {
    const notify = this.opts.pipeline.notify;
    if (!notify || !notify.on.includes(status)) return;
    log(`notify (${status}) → ${notify.run}`);
    spawnSync("bash", ["-lc", this.render(notify.run)], {
      cwd: this.opts.pipeline.projectDir,
      stdio: "inherit",
      env: {
        ...process.env,
        ...this.opts.config.credential.env,
        CLAUDELOOP_STATUS: status,
        CLAUDELOOP_PIPELINE: this.opts.pipeline.name,
        CLAUDELOOP_RUN_ID: this.opts.runId,
        CLAUDELOOP_STAGE: stageId,
        CLAUDELOOP_DETAIL: detail,
      },
    });
  }

  // Fill missing onboarding flags so interactive claude skips the theme + login
  // gates (the login gate would start a fresh OAuth flow ignoring the credential).
  // Only fills what's absent — never clobbers an existing theme.
  private seedOnboarding(): void {
    const path = join(homedir(), ".claude.json");
    let data: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    let changed = false;
    if (data.hasCompletedOnboarding !== true) {
      data.hasCompletedOnboarding = true;
      changed = true;
    }
    if (data.theme === undefined) {
      data.theme = "dark";
      changed = true;
    }
    if (changed) writeFileSync(path, JSON.stringify(data, null, 2));
  }

  // Agent/skill stages run in an interactive claude session inside tmux: spawn,
  // clear the one-time gates, submit the prompt, wait for idle, capture the pane.
  // IS_SANDBOX=1 + the credential env are injected into the tmux session.
  private async runClaudeInteractive(stageId: string, attempt: number, cwd: string, promptText: string): Promise<{ output: string; loginRequired: boolean }> {
    this.seedOnboarding();
    const runner = new ClaudeRunner({
      session: `cl-${this.opts.runId}-${stageId}-${attempt}`,
      cwd,
      command: `claude --permission-mode ${this.opts.pipeline.defaults.permissionMode}`,
      env: { IS_SANDBOX: "1", ...this.opts.config.credential.env },
      idleQuietMs: this.opts.pipeline.defaults.idleQuietMs,
      waitTimeoutMs: this.opts.pipeline.defaults.waitTimeoutMs,
    });
    runner.spawn();
    const ready = await runner.clearGatesAndAwaitReady();
    if (!ready.ready) {
      const pane = runner.capture(60);
      runner.kill();
      throw new Error(`stage '${stageId}': claude session never reached the prompt — ${ready.reason}\n${pane}`);
    }
    await runner.send(promptText);
    const { tail, loginRequired } = await runner.waitForIdle();
    runner.kill();
    return { output: tail, loginRequired };
  }

  private evaluateCheck(check: Check, stageOutput: string, cwd: string): { passed: boolean; detail: string } {
    if (check.type === "command") {
      const command = this.render(check.run);
      const { code, output } = runShell(command, cwd);
      return { passed: code === 0, detail: `check \`${command}\` exited ${code}\n${output}`.trim() };
    }
    const success = this.render(check.success);
    const pattern = new RegExp(success, "i");
    const passed = pattern.test(stageOutput);
    return { passed, detail: `pattern /${success}/i ${passed ? "matched" : "did not match"} stage output` };
  }

  private async runStageBody(stage: Stage, attempt: number, priorFailure: string): Promise<string> {
    const cwd = this.opts.pipeline.projectDir;
    if (stage.type === "command") {
      const command = this.render(stage.run);
      const { code, output } = runShell(command, cwd);
      if (code !== 0) throw new Error(`command stage '${stage.id}' exited ${code}\n${output}`);
      return output;
    }
    if (stage.type === "human") {
      const proceed = await this.confirm(stage.message ?? `Proceed past '${stage.id}'?`);
      if (!proceed) throw new Error(`human declined at stage '${stage.id}'`);
      return "approved";
    }

    let promptText = this.render(stage.type === "agent" ? resolvePromptText(stage, cwd) : skillPrompt(stage));
    if (attempt > 1 && stage.onFail?.fix && priorFailure) {
      promptText = `# Previous attempt failed its exit check\n${priorFailure}\n\n# Fix it, then complete the original task below\n\n${promptText}`;
    }
    const { output, loginRequired } = await this.runClaudeInteractive(stage.id, attempt, cwd, promptText);
    if (loginRequired) {
      throw new Error(`stage '${stage.id}': claude is not authenticated (credential source: ${this.opts.config.credential.source}). ${this.opts.config.credential.note}`);
    }
    return output;
  }

  private writeTaskFile(): void {
    if (!this.opts.task) return;
    const dir = join(this.opts.pipeline.projectDir, ".claudeloop");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task.md"), `# Task\n\n${this.opts.task}\n`);
  }

  async run(): Promise<StageOutcome[]> {
    log(`pipeline '${this.opts.pipeline.name}' run=${this.opts.runId} credential=${this.opts.config.credential.source}`);
    this.writeTaskFile();

    const outcomes: StageOutcome[] = [];
    const stages = this.opts.pipeline.stages;
    const indexById = new Map(stages.map((stage, index) => [stage.id, index]));
    let currentStageId = "";

    try {
    let cursor = 0;
    let transitions = 0;
    while (cursor < stages.length) {
      if (transitions++ > MAX_TRANSITIONS) throw new Error(`exceeded ${MAX_TRANSITIONS} stage transitions — likely a goto loop`);
      const stage = stages[cursor]!;
      currentStageId = stage.id;
      const attempt = (this.attempts.get(stage.id) ?? 0) + 1;
      this.attempts.set(stage.id, attempt);

      log(`▶ stage '${stage.id}' (${stage.type}) attempt ${attempt}`);
      const priorFailure = this.lastOutput.get(stage.id) ?? "";
      const stageOutput = await this.runStageBody(stage, attempt, priorFailure);

      if (!stage.until) {
        outcomes.push({ stageId: stage.id, attempts: attempt, passed: true, detail: "no exit check" });
        log(`✔ stage '${stage.id}' done`);
        cursor += 1;
        continue;
      }

      const { passed, detail } = this.evaluateCheck(stage.until, stageOutput, this.opts.pipeline.projectDir);
      if (passed) {
        outcomes.push({ stageId: stage.id, attempts: attempt, passed: true, detail });
        log(`✔ stage '${stage.id}' passed exit check`);
        cursor += 1;
        continue;
      }

      this.lastOutput.set(stage.id, detail);
      log(`✘ stage '${stage.id}' failed exit check: ${detail.split("\n")[0]}`);

      const onFail = stage.onFail;
      if (!onFail || attempt >= onFail.maxAttempts) {
        outcomes.push({ stageId: stage.id, attempts: attempt, passed: false, detail });
        throw new Error(`stage '${stage.id}' failed after ${attempt} attempt(s): ${detail.split("\n")[0]}`);
      }

      if (onFail.goto) {
        const target = indexById.get(onFail.goto)!;
        log(`↩ goto '${onFail.goto}' to retry`);
        this.attempts.set(onFail.goto, 0);
        cursor = target;
      }
      // No goto: loop stays on the same cursor and re-runs this stage.
    }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.runNotify("failed", currentStageId, detail);
      throw error;
    }

    log(`pipeline '${this.opts.pipeline.name}' complete`);
    this.runNotify("done", "", "");
    return outcomes;
  }
}
