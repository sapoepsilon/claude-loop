import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type CredentialSource =
  | "env-oauth-token"
  | "env-api-key"
  | "credentials-file"
  | "macos-keychain"
  | "none";

export interface CredentialInfo {
  source: CredentialSource;
  // Env vars to inject into the spawned claude process. Empty when the
  // credential lives somewhere claude reads on its own (a file, the Keychain).
  env: Record<string, string>;
  // Whether this credential can travel to a remote host unchanged. The macOS
  // Keychain cannot — a remote replica needs CLAUDE_CODE_OAUTH_TOKEN or
  // ANTHROPIC_API_KEY instead. See the deploy notes for why.
  portable: boolean;
  note: string;
}

export interface ResolvedClaudeConfig {
  homeConfigDir: string;
  projectConfigDir: string | null;
  settings: Record<string, unknown>;
  plugins: string[];
  skills: string[];
  credential: CredentialInfo;
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => statSync(join(dir, name)).isDirectory());
}

function discoverCredential(homeConfigDir: string): CredentialInfo {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      source: "env-oauth-token",
      env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN },
      portable: true,
      note: "subscription OAuth token from env (mint with `claude setup-token`)",
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      source: "env-api-key",
      env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      portable: true,
      note: "Anthropic API key from env (sanctioned for automation)",
    };
  }
  if (existsSync(join(homeConfigDir, ".credentials.json"))) {
    return {
      source: "credentials-file",
      env: {},
      portable: true,
      note: "file-based credential at ~/.claude/.credentials.json",
    };
  }
  if (process.platform === "darwin") {
    const probe = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
      stdio: "ignore",
    });
    if (probe.status === 0) {
      return {
        source: "macos-keychain",
        env: {},
        portable: false,
        note: "auth in macOS Keychain — works locally, NOT portable to a remote; mint a token for remotes",
      };
    }
  }
  return {
    source: "none",
    env: {},
    portable: false,
    note: "no credential found — run `claude setup-token` or set ANTHROPIC_API_KEY",
  };
}

export function resolveClaudeConfig(projectDir: string): ResolvedClaudeConfig {
  const homeConfigDir = join(homedir(), ".claude");
  const projectConfigDir = join(projectDir, ".claude");
  const hasProjectConfig = existsSync(projectConfigDir);

  const homeSettings = readJson(join(homeConfigDir, "settings.json"));
  const projectSettings = hasProjectConfig ? readJson(join(projectConfigDir, "settings.json")) : {};
  const settings = deepMerge(homeSettings, projectSettings);

  const plugins = listSubdirs(join(homeConfigDir, "plugins"));
  const skills = Array.from(
    new Set([
      ...listSubdirs(join(homeConfigDir, "skills")),
      ...(hasProjectConfig ? listSubdirs(join(projectConfigDir, "skills")) : []),
    ]),
  );

  return {
    homeConfigDir,
    projectConfigDir: hasProjectConfig ? projectConfigDir : null,
    settings,
    plugins,
    skills,
    credential: discoverCredential(homeConfigDir),
  };
}
