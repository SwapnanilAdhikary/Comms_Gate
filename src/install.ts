import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function mergeMcpConfig(existing: string | null, url: string): string {
  let parsed: { mcpServers?: Record<string, { url?: string }> } = {};
  if (existing?.trim()) {
    const value = JSON.parse(existing) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("mcp.json must be a JSON object");
    }
    parsed = value as { mcpServers?: Record<string, { url?: string }> };
  }
  parsed.mcpServers ??= {};
  parsed.mcpServers["comms-gate"] = { url };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function hasBin(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectClis(): { claude: boolean; cursor: boolean } {
  return { claude: hasBin("claude"), cursor: hasBin("agent") };
}

export function install(opts: {
  home: string;
  url: string;
  runClaude?: (args: string[]) => void;
  log?: (line: string) => void;
}): void {
  const log = opts.log ?? ((line) => console.log(line));
  const cursorPath = path.join(opts.home, ".cursor", "mcp.json");
  mkdirSync(path.dirname(cursorPath), { recursive: true });
  const existing = existsSync(cursorPath) ? readFileSync(cursorPath, "utf8") : null;
  writeFileSync(cursorPath, mergeMcpConfig(existing, opts.url));
  log(`Cursor MCP config updated: ${cursorPath}`);
  if (!hasBin("claude")) {
    log("claude is not on PATH, so Claude Code was left unchanged.");
  } else {
    const run =
      opts.runClaude ??
      ((args: string[]) => {
        execFileSync("claude", args, { stdio: "inherit" });
      });
    try {
      run(["mcp", "add", "--transport", "http", "comms-gate", opts.url]);
      log("Claude Code MCP server added.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Claude Code MCP was not added: ${message}`);
    }
  }
  const clis = detectClis();
  log(`agent on PATH: ${clis.cursor ? "yes" : "no"}`);
  log(`claude on PATH: ${clis.claude ? "yes" : "no"}`);
}
