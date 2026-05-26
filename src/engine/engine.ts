import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ResolvedClaudeConfig } from "../config/claude-config.ts";
import type { AgentStage, Check, Pipeline, SkillStage, Stage } from "../config/pipeline.ts";

export interface EngineOptions {
  pipeline: Pipeline;
  config: ResolvedClaudeConfig;
  runId: string;
  autoApprove?: boolean;
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

  // Agent/skill stages run headless via `claude -p`: no interactive TUI, no
  // send-keys submit flakiness, clean exit and captured stdout. Credential env
  // (token/api key) is injected; on a root box the caller's env must carry
  // IS_SANDBOX=1 so bypassPermissions is allowed.
  private runClaudeHeadless(cwd: string, promptText: string): { output: string; loginRequired: boolean } {
    const result = spawnSync(
      "claude",
      ["-p", promptText, "--permission-mode", this.opts.pipeline.defaults.permissionMode],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...this.opts.config.credential.env },
        timeout: this.opts.pipeline.defaults.waitTimeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const loginRequired = /not authenticated|claude setup-token|invalid api key|please run.*claude login/i.test(output);
    return { output, loginRequired };
  }

  private evaluateCheck(check: Check, stageOutput: string, cwd: string): { passed: boolean; detail: string } {
    if (check.type === "command") {
      const { code, output } = runShell(check.run, cwd);
      return { passed: code === 0, detail: `check \`${check.run}\` exited ${code}\n${output}`.trim() };
    }
    const pattern = new RegExp(check.success, "i");
    const passed = pattern.test(stageOutput);
    return { passed, detail: `pattern /${check.success}/i ${passed ? "matched" : "did not match"} stage output` };
  }

  private async runStageBody(stage: Stage, attempt: number, priorFailure: string): Promise<string> {
    const cwd = this.opts.pipeline.projectDir;
    if (stage.type === "command") {
      const { code, output } = runShell(stage.run, cwd);
      if (code !== 0) throw new Error(`command stage '${stage.id}' exited ${code}\n${output}`);
      return output;
    }
    if (stage.type === "human") {
      const proceed = await this.confirm(stage.message ?? `Proceed past '${stage.id}'?`);
      if (!proceed) throw new Error(`human declined at stage '${stage.id}'`);
      return "approved";
    }

    let promptText = stage.type === "agent" ? resolvePromptText(stage, cwd) : skillPrompt(stage);
    if (attempt > 1 && stage.onFail?.fix && priorFailure) {
      promptText = `# Previous attempt failed its exit check\n${priorFailure}\n\n# Fix it, then complete the original task below\n\n${promptText}`;
    }
    const { output, loginRequired } = this.runClaudeHeadless(cwd, promptText);
    if (loginRequired) {
      throw new Error(`stage '${stage.id}': claude is not authenticated (credential source: ${this.opts.config.credential.source}). ${this.opts.config.credential.note}`);
    }
    return output;
  }

  async run(): Promise<StageOutcome[]> {
    log(`pipeline '${this.opts.pipeline.name}' run=${this.opts.runId} credential=${this.opts.config.credential.source}`);

    const outcomes: StageOutcome[] = [];
    const stages = this.opts.pipeline.stages;
    const indexById = new Map(stages.map((stage, index) => [stage.id, index]));

    let cursor = 0;
    let transitions = 0;
    while (cursor < stages.length) {
      if (transitions++ > MAX_TRANSITIONS) throw new Error(`exceeded ${MAX_TRANSITIONS} stage transitions — likely a goto loop`);
      const stage = stages[cursor]!;
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

    log(`pipeline '${this.opts.pipeline.name}' complete`);
    return outcomes;
  }
}
