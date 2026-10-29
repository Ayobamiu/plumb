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
export const hookCommand = (tool, kind = "hook") => `node "${join(appDir(), "bin", "plumb.mjs")}" ${kind} ${tool}`;
const isOurs = (cmd, kind = "hook") => typeof cmd === "string" && cmd.includes("plumb.mjs") && cmd.includes(` ${kind} `);

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

const versionOf = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
};

/** After an update (npx plumb-ai@latest ...), the hooks' copy follows. Only if hooks were installed. */
export function refreshApp() {
  const installed = versionOf(appDir());
  if (installed && installed !== versionOf(pkgDir)) copyApp();
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
  // Stop and SessionEnd save the session; SessionStart adds the "what changed" note.
  for (const [event, kind] of [["Stop", "hook"], ["SessionEnd", "hook"], ["SessionStart", "hook-start"]]) {
    const groups = (settings.hooks[event] ??= []);
    const present = groups.some((g) => (g.hooks ?? []).some((h) => isOurs(h.command, kind)));
    if (!present) groups.push({ hooks: [{ type: "command", command: hookCommand("claude-code", kind) }] });
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
  // stop: the end of each agent response; sessionEnd: the chat closes.
  for (const [event, kind] of [["stop", "hook"], ["sessionEnd", "hook"], ["sessionStart", "hook-start"]]) {
    const list = (hooks.hooks[event] ??= []);
    if (!list.some((h) => isOurs(h.command, kind))) list.push({ command: hookCommand("cursor", kind) });
  }
  writeJson(hooksPath, hooks);

  writeCommand(join(dir, "commands"));
  return ["MCP server in ~/.cursor/mcp.json", "hooks in ~/.cursor/hooks.json", "/plumb in ~/.cursor/commands"];
}

export const hasClaudeCode = () => existsSync(join(homedir(), ".claude"));
export const hasCursor = () => existsSync(join(homedir(), ".cursor"));

// The safety net (Oct 29): hooks are the fast path, but Cursor sometimes skips
// them and a crashed session never ends. Every hour, `plumb sync` rescans the
// local history and saves whatever changed. macOS: a launchd job; elsewhere,
// the line to add to cron.
const LABEL = "ai.plumb.sync";

export function installSync() {
  const command = [process.execPath, join(appDir(), "bin", "plumb.mjs"), "sync"];
  if (process.platform !== "darwin") {
    return [`hourly sync: add this to crontab -e: 0 * * * * ${command.map((c) => `"${c}"`).join(" ")}`];
  }
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${command.map((c) => `<string>${c}</string>`).join("")}</array>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>${join(home(), "sync.log")}</string>
  <key>StandardErrorPath</key><string>${join(home(), "sync.log")}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, xml);
  if (process.env.PLUMB_SKIP_LAUNCHCTL) return ["hourly sync (launchd, not loaded in tests)"];
  const domain = `gui/${process.getuid?.() ?? ""}`;
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], { stdio: "ignore" });
  } catch {
    /* wasn't loaded */
  }
  try {
    execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "ignore" });
    return ["hourly sync (launchd)"];
  } catch {
    return [`hourly sync: written to ${plist}; load it with launchctl bootstrap ${domain} ${plist}`];
  }
}
