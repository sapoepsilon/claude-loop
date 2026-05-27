import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";

export type StageType = "agent" | "skill" | "command" | "human";

export interface CommandCheck {
  type: "command";
  run: string;
}

export interface PatternCheck {
  type: "pattern";
  // Regex tested against the agent session's captured output. A match means
  // the stage's exit condition is satisfied.
  success: string;
}

export type Check = CommandCheck | PatternCheck;

export interface OnFail {
  // Stage id to jump back to before retrying. Omit to retry the same stage.
  goto?: string;
  // When true, re-run the same stage with a fix-it framing prepended.
  fix?: boolean;
  maxAttempts: number;
}

export interface BaseStage {
  id: string;
  type: StageType;
  gate?: "human";
  until?: Check;
  onFail?: OnFail;
}

export interface AgentStage extends BaseStage {
  type: "agent";
  // Path to a prompt file (relative to the project dir) or inline text.
  prompt?: string;
  promptText?: string;
}

export interface SkillStage extends BaseStage {
  type: "skill";
  skill: string;
  args?: string;
}

export interface CommandStage extends BaseStage {
  type: "command";
  run: string;
}

export interface HumanStage extends BaseStage {
  type: "human";
  message?: string;
}

export type Stage = AgentStage | SkillStage | CommandStage | HumanStage;

export interface PipelineDefaults {
  permissionMode: string;
  idleQuietMs: number;
  waitTimeoutMs: number;
}

export type NotifyEvent = "done" | "failed";

export interface Notify {
  // Which terminal states trigger the command. Defaults to both.
  on: NotifyEvent[];
  // Shell command run on a terminal state, with CLAUDELOOP_* env vars set.
  run: string;
}

export interface Pipeline {
  name: string;
  defaults: PipelineDefaults;
  stages: Stage[];
  projectDir: string;
  notify?: Notify;
}

export class PipelineError extends Error {}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PipelineError(`${context} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function parseCheck(raw: unknown, context: string): Check | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, context);
  if (record.type === "command") {
    if (typeof record.run !== "string") throw new PipelineError(`${context}: command check needs a 'run' string`);
    return { type: "command", run: record.run };
  }
  if (record.type === "pattern") {
    if (typeof record.success !== "string") throw new PipelineError(`${context}: pattern check needs a 'success' regex`);
    return { type: "pattern", success: record.success };
  }
  throw new PipelineError(`${context}: check 'type' must be 'command' or 'pattern'`);
}

function parseOnFail(raw: unknown, context: string): OnFail | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, context);
  const maxAttempts = record.max_attempts ?? record.maxAttempts;
  if (typeof maxAttempts !== "number" || maxAttempts < 1) {
    throw new PipelineError(`${context}: on_fail needs a positive 'max_attempts'`);
  }
  const onFail: OnFail = { maxAttempts };
  if (typeof record.goto === "string") onFail.goto = record.goto;
  if (record.fix === true) onFail.fix = true;
  return onFail;
}

function parseStage(raw: unknown, index: number): Stage {
  const record = asRecord(raw, `stages[${index}]`);
  const id = record.id;
  const type = record.type;
  if (typeof id !== "string" || !id) throw new PipelineError(`stages[${index}]: missing 'id'`);
  if (type !== "agent" && type !== "skill" && type !== "command" && type !== "human") {
    throw new PipelineError(`stage '${id}': 'type' must be agent | skill | command | human`);
  }

  const base: BaseStage = { id, type };
  if (record.gate === "human") base.gate = "human";
  const until = parseCheck(record.until, `stage '${id}' until`);
  if (until) base.until = until;
  const onFail = parseOnFail(record.on_fail ?? record.onFail, `stage '${id}' on_fail`);
  if (onFail) base.onFail = onFail;

  if (type === "agent") {
    const stage: AgentStage = { ...base, type: "agent" };
    if (typeof record.prompt === "string") stage.prompt = record.prompt;
    if (typeof record.prompt_text === "string") stage.promptText = record.prompt_text;
    if (!stage.prompt && !stage.promptText) {
      throw new PipelineError(`stage '${id}': agent needs 'prompt' (file) or 'prompt_text'`);
    }
    return stage;
  }
  if (type === "skill") {
    if (typeof record.skill !== "string") throw new PipelineError(`stage '${id}': skill needs a 'skill' name`);
    const stage: SkillStage = { ...base, type: "skill", skill: record.skill };
    if (typeof record.args === "string") stage.args = record.args;
    return stage;
  }
  if (type === "command") {
    if (typeof record.run !== "string") throw new PipelineError(`stage '${id}': command needs a 'run' string`);
    return { ...base, type: "command", run: record.run };
  }
  const stage: HumanStage = { ...base, type: "human" };
  if (typeof record.message === "string") stage.message = record.message;
  return stage;
}

function parseDefaults(raw: unknown): PipelineDefaults {
  const defaults: PipelineDefaults = {
    permissionMode: "bypassPermissions",
    idleQuietMs: 4000,
    waitTimeoutMs: 1000 * 60 * 30,
  };
  if (raw === undefined) return defaults;
  const record = asRecord(raw, "defaults");
  if (typeof record.permission_mode === "string") defaults.permissionMode = record.permission_mode;
  if (typeof record.idle_quiet_ms === "number") defaults.idleQuietMs = record.idle_quiet_ms;
  if (typeof record.wait_timeout_ms === "number") defaults.waitTimeoutMs = record.wait_timeout_ms;
  return defaults;
}

function parseNotify(raw: unknown): Notify | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, "notify");
  if (typeof record.run !== "string") throw new PipelineError("notify needs a 'run' command");
  let on: NotifyEvent[] = ["done", "failed"];
  if (Array.isArray(record.on)) {
    on = record.on.filter((event): event is NotifyEvent => event === "done" || event === "failed");
    if (on.length === 0) throw new PipelineError("notify.on must include 'done' and/or 'failed'");
  }
  return { on, run: record.run };
}

export function loadPipeline(filePath: string, projectDir: string): Pipeline {
  const absolute = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath);
  const parsed = parse(readFileSync(absolute, "utf8")) as unknown;
  const root = asRecord(parsed, "pipeline");
  if (typeof root.name !== "string") throw new PipelineError("pipeline needs a 'name'");
  if (!Array.isArray(root.stages) || root.stages.length === 0) {
    throw new PipelineError("pipeline needs a non-empty 'stages' list");
  }

  const stages = root.stages.map((stage, index) => parseStage(stage, index));

  // Prompt files are written relative to the pipeline file (e.g. .claudeloop/prompts/),
  // not the project root. Resolve them against the pipeline's own directory now.
  const baseDir = dirname(absolute);
  for (const stage of stages) {
    if (stage.type === "agent" && stage.prompt && !isAbsolute(stage.prompt)) {
      stage.prompt = resolve(baseDir, stage.prompt);
    }
  }

  const ids = new Set<string>();
  for (const stage of stages) {
    if (ids.has(stage.id)) throw new PipelineError(`duplicate stage id '${stage.id}'`);
    ids.add(stage.id);
  }
  for (const stage of stages) {
    if (stage.onFail?.goto && !ids.has(stage.onFail.goto)) {
      throw new PipelineError(`stage '${stage.id}': on_fail.goto '${stage.onFail.goto}' is not a known stage`);
    }
  }

  const pipeline: Pipeline = { name: root.name, defaults: parseDefaults(root.defaults), stages, projectDir };
  const notify = parseNotify(root.notify);
  if (notify) pipeline.notify = notify;
  return pipeline;
}
