#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Gate } from "./gate.ts";
import { createHttpServer, listenLocal } from "./http.ts";
import { detectClis, install } from "./install.ts";
import { Store } from "./store.ts";

const argv = process.argv.slice(2);
const command = argv[0] === "install" || argv[0] === "serve" ? argv[0] : "serve";
const args = argv[0] === command ? argv.slice(1) : argv;

function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

const port = Number(option("port") ?? 8787);
const mcpUrl = `http://127.0.0.1:${port}/mcp`;

if (command === "install") {
  install({ home: homedir(), url: mcpUrl });
} else if (command === "serve") {
  if (!Number.isInteger(port) || port < 1) {
    console.error("Port must be a positive integer.");
    process.exit(1);
  }
  const data = option("data") ?? path.join(homedir(), ".comms-gate", "gate.db");
  mkdirSync(path.dirname(data), { recursive: true });
  const store = new Store(data);
  const gate = new Gate({
    store,
    worktreesRoot: path.join(path.dirname(data), "worktrees"),
  });
  const server = createHttpServer(gate, { clis: detectClis() });
  listenLocal(server, port)
    .then(() => {
      const url = `http://127.0.0.1:${port}`;
      console.log(url);
      if (has("open")) {
        const child = spawn("open", [url], { stdio: "ignore", detached: true });
        child.unref();
      }
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        console.error(`comms-gate is already running on 127.0.0.1:${port}`);
        process.exit(1);
      }
      console.error(error.message);
      process.exit(1);
    });
} else {
  console.error("Usage: comms-gate serve [--port 8787] [--data file] [--open]\n       comms-gate install");
  process.exit(1);
}
