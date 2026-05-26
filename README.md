# claude-loop

Config-driven, multi-stage **Claude Code** pipelines for any codebase.

You describe your dev loop once in a `pipeline.yaml` — implement → QA → PR → review →
simplify → e2e → merge — and `claude-loop` drives real `claude` CLI sessions through it,
looping on the stages you mark with an exit check until they pass.

It generalizes a hardcoded production agent pipeline into a config-driven engine: the same
proven runner, but the pipeline lives in a `pipeline.yaml` instead of being wired to one repo.

## Status

- **M1 — local engine.** Run any `pipeline.yaml` against a local repo. ✅
  (agent/skill stages run headless via `claude -p` — no interactive-TUI submit flakiness.)
- **M2 — `claudeloop init`.** Detects project type and scaffolds `.claudeloop/`. ✅
- M3 — full pipeline run on a real repo (parity). _staged: smoke proven, full run is supervised_
- **M4 — remote provisioning.** One command stands up an isolated Debian box running
  claude via tmux. ✅ (`scripts/provision-proxmox.sh`)

## One-command remote (M4)

Stand up a fresh, isolated Debian LXC on a Proxmox host with a fully working headless
Claude Code — install, credential, onboarding-seed, and a live tmux smoke test — in one
command. Run it **from your Mac** (it reads the Keychain credential) or set
`CLAUDE_CODE_OAUTH_TOKEN` first to run it anywhere:

```bash
# local checkout
./scripts/provision-proxmox.sh root@<proxmox-host> [ctid]

# or straight from GitHub (runs on your Mac so it can read the Keychain)
curl -fsSL https://raw.githubusercontent.com/sapoepsilon/claude-loop/main/scripts/provision-proxmox.sh \
  | bash -s -- root@<proxmox-host> 133
```

Bakes in the gotchas: `IS_SANDBOX=1` so root may use `bypassPermissions`, a headless
`claude -p` init followed by seeding `~/.claude.json` (`hasCompletedOnboarding`), and
auto-clearing the one-time trust + bypass prompts. Credential resolution:
`CLAUDE_CODE_OAUTH_TOKEN` env, else the macOS Keychain.

### Safety: it won't clobber a box that's already set up

| Situation | Behavior |
|-----------|----------|
| Fresh / new CTID | create → install → push credential → smoke test |
| CTID **already exists** | **refuses** (`--recreate` to destroy+rebuild) |
| `--configure-only <ctid>` | non-destructive: install if missing, **preserve** an existing working login, smoke test |
| Target already authed (esp. same account) | credential is **preserved**, not overwritten (`--force-credential` to override) |

This matters because copying one credential onto a second machine puts both on the same
OAuth token family — they auto-refresh and can rotate each other out. **Rule: one credential
per machine.** Share config (settings/skills/plugins); never share the live credential. For
an existing box, use `--configure-only` (it preserves auth and backs up `~/.claude` before
any change); to give a box its own durable login, set `CLAUDE_CODE_OAUTH_TOKEN` from a
`claude setup-token` minted for that box.

> Note: the Keychain path is great for a throwaway box. For a durable server, pass
> `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) so it owns its own auth instead of
> sharing — and rotating against — your laptop's session.

## How it works

`claude-loop` reads your Claude identity by **merging `~/.claude` and `./.claude`**
(settings, plugins, skills) and discovering a usable credential. It then runs each stage
of your pipeline as a `claude` session inside a dedicated tmux server (socket
`claude-loop`, isolated from your interactive tmux), watching the pane until the session
goes idle.

### Credential resolution (and why it matters for remotes)

`claudeloop config` shows what it found. Resolution order:

1. `CLAUDE_CODE_OAUTH_TOKEN` env var (mint with `claude setup-token`) — portable
2. `ANTHROPIC_API_KEY` env var — portable, sanctioned for automation
3. `~/.claude/.credentials.json` — portable file
4. macOS Keychain — **works locally, NOT portable.** A remote replica must use 1 or 2.

The dedicated tmux socket guarantees the spawned `claude` inherits whichever env
credential this process holds, instead of a stale interactive tmux server's environment.

## Pipeline format

```yaml
name: feature-dev
defaults:
  permission_mode: bypassPermissions
stages:
  - id: implement
    type: agent              # spawns claude, sends the prompt
    prompt: prompts/implement.md

  - id: qa
    type: agent
    prompt: prompts/qa.md
    until:                   # leave the stage only when this passes
      type: command
      run: "npm test"
    on_fail:
      goto: implement        # loop back and retry
      max_attempts: 5

  - id: review
    type: skill              # sends /comprehensive-review:full-review
    skill: comprehensive-review:full-review
    until:
      type: pattern          # match the agent's output
      success: "no (critical|high)"
    on_fail:
      fix: true              # re-run THIS stage with a fix-it framing
      max_attempts: 10

  - id: merge
    type: command
    run: "gh pr merge --squash"
    gate: human              # pause for a y/N before running
```

### Stage types

| type | what it does |
|------|--------------|
| `agent` | spawn `claude`, send `prompt` (file) or `prompt_text`, wait for idle |
| `skill` | spawn `claude`, send `/<skill> <args>` |
| `command` | run a shell command in the project dir (exit 0 = success) |
| `human` | pause for a y/N confirmation |

### Loop controls (per stage)

- `until` — a `command` (exit 0) or `pattern` (regex on the agent's output) that must pass to advance.
- `on_fail.goto` — jump back to an earlier stage and retry.
- `on_fail.fix` — re-run the same stage with the prior failure prepended to the prompt.
- `on_fail.max_attempts` — give up (fail the run) after this many tries.
- `gate: human` — require a human y/N before the stage runs.

## Usage

```bash
npm install

# scaffold the loop into ANY repo (detects node/flutter, test/e2e cmds, git+gh)
./bin/claudeloop init --project ~/Developer/some-repo

# inspect what claude identity + credential will be used
./bin/claudeloop config --project ~/Developer/some-repo

# check host prerequisites
./bin/claudeloop doctor

# run a pipeline against a repo
./bin/claudeloop run .claudeloop/pipeline.yaml --project ~/Developer/some-repo
```

## Testing it on a real repo (staged)

The full loop mutates code, opens PRs, and merges — so prove it in stages, not blind:

1. **Smoke** — a 1-stage read-only pipeline confirms the engine drives claude in the repo:
   `claudeloop run examples/smoke.pipeline.yaml --project <repo>` (proven against a real Node backend).
2. **Implement + QA only** — trim the generated pipeline to `implement` + `qa` and point it at a
   throwaway branch with a tiny task in `.claudeloop/task.md`. Watch it edit code and loop on `npm test`.
3. **Full loop** — add `draft-pr` / `review` / `simplify` / `e2e` / `merge`. The `merge` stage is
   gated `human`, so nothing lands without your y/N.

## Requirements

- `tmux`, `claude` CLI, `node >= 20`
- A portable credential for any non-interactive use (see above)
- Whatever your pipeline's `command` stages and skills need (`gh`, test runners, the
  `comprehensive-review` plugin, etc.)

## Roadmap — the three pluggable edges (designed, not yet built)

The engine is the kernel. Around it sit three edges the dev chooses; today only the
engine + `pipeline.yaml` exist, the edges are the next work:

- **Trigger (in)** — one generic `POST /run` endpoint that any source calls (a `curl`, a
  cron, or a task provider like Linear/GitHub via a thin adapter). Normalized payload:
  ```json
  { "pipeline": "feature-dev", "task": "<actionable item>",
    "vars": { "ticket": "ABC-123" }, "notify": { "to": "linear", "ticket": "ABC-123" } }
  ```
  Only `pipeline` + `task` are required; everything else is an open `vars` bag exposed to
  prompts as `{{vars.x}}` (needs prompt templating, also planned).
- **Notifier (out)** — a `notify:` hook the engine runs on `done`/`failed` (fires even when
  a run fails), calling the provider's API back. No agent in the path by default.
- **Driver** — intentionally *not* an engine feature: "how the agent exercises the product"
  is just the prompt (markdown) + whatever MCP servers are in the synced Claude config
  (playwright / mobile-mcp / curl). The dev configures the MCP server; the prompt drives it.

The task provider can be both ends — trigger by moving a ticket, get notified on the same
ticket — so you never talk to the box directly.
