// ~/.plumb: config.json (server and personal token, owner-only file) and
// state.json (what was already sent, so nothing is sent twice).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API = "https://mcp-production-a566.up.railway.app";

export const home = () => process.env.PLUMB_HOME || join(homedir(), ".plumb");
const file = (name) => join(home(), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(file(name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file(name), 0o600);
}

export const loadConfig = () => readJson("config.json", undefined);
export const saveConfig = (c) => writeJson("config.json", c);
export const loadState = () => readJson("state.json", { sent: {} });
export const saveState = (s) => writeJson("state.json", s);
export const hasConfig = () => existsSync(file("config.json"));
