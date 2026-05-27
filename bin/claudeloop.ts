import { resolve } from "node:path";
import { argv, cwd, exit, stdout } from "node:process";
import { resolveClaudeConfig } from "../src/config/claude-config.ts";
import { loadPipeline } from "../src/config/pipeline.ts";
import { detectProject, scaffold } from "../src/config/init.ts";
import { Engine, type EngineOptions } from "../src/engine/engine.ts";
import { serve, type ServeOptions } from "../src/server/serve.ts";
import { tmuxInstalled } from "../src/runner/tmux.ts";

function ulidish(): string {
  return Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) return undefined;
  return args[index + 1];
}

function usage(): void {
  stdout.write(
    [
      "claude-loop — config-driven multi-stage Claude pipelines",
      "",
      "Usage:",
      "  claudeloop init [--project <dir>]        scaffold .claudeloop/ for this repo",
      "  claudeloop run <pipeline.yaml> [--project <dir>] [--yes]",
      "  claudeloop config [--project <dir>]      show merged ~/.claude + ./.claude config",
      "  claudeloop doctor                        check host prerequisites",
      "",
    ].join("\n"),
  );
}

function cmdInit(args: string[]): void {
  const projectDir = resolve(flagValue(args, "--project") ?? cwd());
  const det = detectProject(projectDir);
  stdout.write(`detected: ${det.kind} project (test: ${det.testCommand ?? "?"}, e2e: ${det.e2eCommand ?? "none"}, git: ${det.hasGit}, gh: ${det.hasGh})\n`);
  const result = scaffold(projectDir, det);
  for (const path of result.created) stdout.write(`  created ${path}\n`);
  for (const path of result.skipped) stdout.write(`  kept    ${path} (already exists)\n`);
  stdout.write("\nnext:\n");
  stdout.write("  1. edit .claudeloop/task.md with the actionable item\n");
  stdout.write("  2. review .claudeloop/pipeline.yaml (fill any TODO commands)\n");
  stdout.write(`  3. claudeloop run .claudeloop/pipeline.yaml --project ${projectDir}\n`);
}

async function cmdConfig(args: string[]): Promise<void> {
  const projectDir = resolve(flagValue(args, "--project") ?? cwd());
  const config = resolveClaudeConfig(projectDir);
  stdout.write(`project:      ${projectDir}\n`);
  stdout.write(`home config:  ${config.homeConfigDir}\n`);
  stdout.write(`project conf: ${config.projectConfigDir ?? "(none)"}\n`);
  stdout.write(`credential:   ${config.credential.source} — ${config.credential.note}\n`);
  stdout.write(`portable:     ${config.credential.portable}\n`);
  stdout.write(`plugins:      ${config.plugins.join(", ") || "(none)"}\n`);
  stdout.write(`skills:       ${config.skills.join(", ") || "(none)"}\n`);
}

function cmdDoctor(): void {
  const checks: Array<[string, boolean]> = [
    ["tmux", tmuxInstalled()],
    ["CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY set", Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY)],
  ];
  for (const [name, ok] of checks) {
    stdout.write(`${ok ? "✔" : "✘"} ${name}\n`);
  }
}

function collectVars(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--var" && index + 1 < args.length) {
      const pair = args[index + 1]!;
      const eq = pair.indexOf("=");
      if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return out;
}

function cmdServe(args: string[]): void {
  const projectDir = resolve(flagValue(args, "--project") ?? cwd());
  const options: ServeOptions = {
    projectDir,
    port: Number(flagValue(args, "--port") ?? process.env.LOOP_PORT ?? 5577),
    pipelineFile: flagValue(args, "--pipeline") ?? ".claudeloop/pipeline.yaml",
    triggerState: flagValue(args, "--trigger-state") ?? "Agent",
  };
  if (process.env.LINEAR_WEBHOOK_SECRET) options.webhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  serve(options);
}

async function cmdRun(args: string[]): Promise<void> {
  const pipelinePath = args[0];
  if (!pipelinePath || pipelinePath.startsWith("--")) throw new Error("run needs a pipeline file: claudeloop run <pipeline.yaml>");
  const projectDir = resolve(flagValue(args, "--project") ?? cwd());
  const autoApprove = args.includes("--yes");

  const config = resolveClaudeConfig(projectDir);
  const pipeline = loadPipeline(resolve(cwd(), pipelinePath), projectDir);

  const engineOptions: EngineOptions = { pipeline, config, runId: ulidish(), autoApprove };
  const task = flagValue(args, "--task");
  if (task) engineOptions.task = task;
  const vars = collectVars(args);
  if (Object.keys(vars).length > 0) engineOptions.vars = vars;
  const engine = new Engine(engineOptions);

  const outcomes = await engine.run();
  const failed = outcomes.filter((outcome) => !outcome.passed);
  stdout.write(`\nsummary: ${outcomes.length} stage(s), ${failed.length} failed\n`);
  exit(failed.length === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const [command, ...args] = argv.slice(2);
  if (command === "init") return cmdInit(args);
  if (command === "serve") return cmdServe(args);
  if (command === "run") return cmdRun(args);
  if (command === "config") return cmdConfig(args);
  if (command === "doctor") return cmdDoctor();
  usage();
  exit(command ? 1 : 0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stdout.write(`\n[claude-loop] error: ${message}\n`);
  exit(1);
});
