// Connect Claude Code and Cursor at user level, so every project is covered:
// MCP server (find_context, get_context, ...), /plumb, and hooks that save each
// session in index mode. Existing settings are merged, never replaced, and a
// backup is written next to any file before the first change.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./config.mjs";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const appDir = () => join(home(), "app");
export const hookCommand = (tool) => `node "${join(appDir(), "bin", "plumb.mjs")}" hook ${tool}`;
const isOurs = (cmd) => typeof cmd === "string" && cmd.includes("plumb.mjs") && cmd.includes(" hook ");

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} isn't valid JSON; fix or move it, then run plumb init again`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(`${path}.plumb-backup`)) copyFileSync(path, `${path}.plumb-backup`);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** Hooks run from a stable copy, not from wherever npx unpacked this. */
export function copyApp() {
  if (pkgDir === appDir()) return;
  for (const part of ["bin", "lib", "assets", "package.json"]) cpSync(join(pkgDir, part), join(appDir(), part), { recursive: true });
}

function writeCommand(dir) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(pkgDir, "assets", "plumb-command.md"), join(dir, "plumb.md"));
}

export function installClaudeCode({ api, token }) {
  const dir = join(homedir(), ".claude");
  const steps = [];
  // Hooks: Stop (mid-session saves, throttled) and SessionEnd.
  const path = join(dir, "settings.json");
  const settings = readJson(path);
  settings.hooks ??= {};
  for (const event of ["Stop", "SessionEnd"]) {
    const groups = (settings.hooks[event] ??= []);
    const present = groups.some((g) => (g.hooks ?? []).some((h) => isOurs(h.command)));
    if (!present) groups.push({ hooks: [{ type: "command", command: hookCommand("claude-code") }] });
  }
  writeJson(path, settings);
  steps.push("hooks in ~/.claude/settings.json");
  writeCommand(join(dir, "commands"));
  steps.push("/plumb in ~/.claude/commands");
  // MCP at user scope, through Claude Code's own CLI.
  const url = `${api.replace(/\/$/, "")}/mcp`;
  try {
    try {
      execFileSync("claude", ["mcp", "remove", "--scope", "user", "plumb"], { stdio: "ignore" });
    } catch {
      /* wasn't there */
    }
    execFileSync("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "plumb", url, "--header", `Authorization: Bearer ${token}`], { stdio: "ignore" });
    steps.push("MCP server (user scope)");
  } catch {
    steps.push(`MCP: the claude command wasn't found. Run: claude mcp add --scope user --transport http plumb ${url} --header "Authorization: Bearer <token from ~/.plumb/config.json>"`);
  }
  return steps;
}

export function installCursor({ api, token }) {
  const dir = join(homedir(), ".cursor");
  const mcpPath = join(dir, "mcp.json");
  const mcp = readJson(mcpPath);
  mcp.mcpServers ??= {};
  mcp.mcpServers.plumb = { url: `${api.replace(/\/$/, "")}/mcp`, headers: { Authorization: `Bearer ${token}` } };
  writeJson(mcpPath, mcp);

  const hooksPath = join(dir, "hooks.json");
  const hooks = readJson(hooksPath);
  hooks.version ??= 1;
  hooks.hooks ??= {};
  const stop = (hooks.hooks.stop ??= []);
  if (!stop.some((h) => isOurs(h.command))) stop.push({ command: hookCommand("cursor") });
  writeJson(hooksPath, hooks);

  writeCommand(join(dir, "commands"));
  return ["MCP server in ~/.cursor/mcp.json", "hook in ~/.cursor/hooks.json", "/plumb in ~/.cursor/commands"];
}

export const hasClaudeCode = () => existsSync(join(homedir(), ".claude"));
export const hasCursor = () => existsSync(join(homedir(), ".cursor"));
