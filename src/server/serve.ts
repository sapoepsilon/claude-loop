import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { resolveClaudeConfig } from "../config/claude-config.ts";
import { loadPipeline } from "../config/pipeline.ts";
import { Engine, type EngineOptions } from "../engine/engine.ts";

export interface ServeOptions {
  projectDir: string;
  port: number;
  // Pipeline file relative to projectDir; the repo's .claudeloop/ is the config.
  pipelineFile: string;
  // Linear state name that triggers a run (the "Agent" column).
  triggerState: string;
  webhookSecret?: string;
}

interface RunRequest {
  task: string;
  vars: Record<string, string>;
  pipelineFile: string;
}

function log(message: string): void {
  stdout.write(`[claude-loop:serve] ${message}\n`);
}

function ulidish(): string {
  return Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Map a Linear Issue webhook into a run request. Fires only when the issue's state
// matches the trigger column. Returns null for events we ignore.
function linearToRun(payload: Record<string, unknown>, triggerState: string, defaultPipeline: string): RunRequest | null {
  if (payload.type !== "Issue") return null;
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const state = data.state as { name?: string } | undefined;
  if (!state || state.name !== triggerState) return null;
  const identifier = typeof data.identifier === "string" ? data.identifier : "";
  const title = typeof data.title === "string" ? data.title : "";
  const description = typeof data.description === "string" ? data.description : title;
  return {
    task: `# ${identifier} — ${title}\n\n${description}`,
    vars: { ticket: identifier, title },
    pipelineFile: defaultPipeline,
  };
}

export function serve(options: ServeOptions): void {
  const queue: RunRequest[] = [];
  let busy = false;

  async function drain(): Promise<void> {
    if (busy) return;
    const next = queue.shift();
    if (!next) return;
    busy = true;
    const runId = ulidish();
    try {
      const config = resolveClaudeConfig(options.projectDir);
      const pipeline = loadPipeline(resolve(options.projectDir, next.pipelineFile), options.projectDir);
      const engineOptions: EngineOptions = { pipeline, config, runId, autoApprove: true, task: next.task, vars: next.vars };
      log(`run ${runId} start: ${next.vars.ticket ?? "(adhoc)"}`);
      await new Engine(engineOptions).run();
      log(`run ${runId} done`);
    } catch (error) {
      log(`run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
      void drain();
    }
  }

  function enqueue(request: RunRequest): void {
    queue.push(request);
    void drain();
  }

  function verifyLinear(raw: Buffer, signature: string | undefined): boolean {
    if (!options.webhookSecret) return true;
    if (!signature) return false;
    const expected = createHmac("sha256", options.webhookSecret).update(raw).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200).end(JSON.stringify({ ok: true, busy, queued: queue.length }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const raw = await readBody(req);

      if (req.url === "/webhook/linear") {
        if (!verifyLinear(raw, req.headers["linear-signature"] as string | undefined)) {
          res.writeHead(401).end("bad signature");
          return;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        const run = linearToRun(payload, options.triggerState, options.pipelineFile);
        if (!run) {
          res.writeHead(202).end(JSON.stringify({ ignored: true }));
          return;
        }
        enqueue(run);
        res.writeHead(202).end(JSON.stringify({ queued: run.vars.ticket }));
        return;
      }

      if (req.url === "/run") {
        let body: { task?: string; vars?: Record<string, string>; pipeline?: string };
        try {
          body = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          res.writeHead(400).end("bad json");
          return;
        }
        if (!body.task) {
          res.writeHead(400).end("task required");
          return;
        }
        enqueue({ task: body.task, vars: body.vars ?? {}, pipelineFile: body.pipeline ?? options.pipelineFile });
        res.writeHead(202).end(JSON.stringify({ queued: true }));
        return;
      }

      res.writeHead(404).end();
    })();
  });

  server.listen(options.port, () => {
    log(`listening on :${options.port} | project=${options.projectDir} | pipeline=${options.pipelineFile} | trigger="${options.triggerState}"`);
    log(`POST /run {task,vars?,pipeline?}  ·  POST /webhook/linear  ·  GET /health`);
  });
}
