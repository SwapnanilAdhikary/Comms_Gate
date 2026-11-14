import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Gate } from "../src/gate.ts";
import { createHttpServer, listenLocal } from "../src/http.ts";
import { hasBin, install, mergeMcpConfig } from "../src/install.ts";
import { Store } from "../src/store.ts";
import type { Runner, RunningWorker, RunSpec } from "../src/supervisor.ts";

const root = path.join(import.meta.dirname, "..", ".tmp");

class FakeRunner implements Runner {
  runs: RunSpec[] = [];
  private live: Array<{ finish: (code: number) => void; emitOut: (chunk: string) => void }> = [];

  run(spec: RunSpec): RunningWorker {
    this.runs.push(spec);
    let outCb: ((chunk: string) => void) | null = null;
    const buffered: string[] = [];
    let finish: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    this.live.push({
      finish,
      emitOut(chunk: string) {
        if (outCb) outCb(chunk);
        else buffered.push(chunk);
      },
    });
    return {
      onStdout(cb) {
        outCb = cb;
        for (const chunk of buffered.splice(0)) cb(chunk);
      },
      onStderr() {},
      exited,
      kill() {
        finish(143);
      },
    };
  }

  succeed(output: string): void {
    const slot = this.live.shift();
    assert.ok(slot);
    slot.emitOut(output);
    slot.finish(0);
  }
}

test("mergeMcpConfig keeps the other servers", () => {
  const merged = mergeMcpConfig(
    JSON.stringify({ mcpServers: { other: { url: "http://127.0.0.1:9/mcp" } } }),
    "http://127.0.0.1:8787/mcp",
  );
  const parsed = JSON.parse(merged) as { mcpServers: Record<string, { url: string }> };
  assert.equal(parsed.mcpServers.other?.url, "http://127.0.0.1:9/mcp");
  assert.equal(parsed.mcpServers["comms-gate"]?.url, "http://127.0.0.1:8787/mcp");
});

test("install writes Cursor config and does not drop existing servers", () => {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(path.join(root, "home-"));
  const url = "http://127.0.0.1:8787/mcp";
  mkdirSync(path.join(home, ".cursor"), { recursive: true });
  writeFileSync(
    path.join(home, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { other: { url: "http://127.0.0.1:9/mcp" } } }),
  );
  const calls: string[][] = [];
  try {
    install({
      home,
      url,
      log() {},
      runClaude(args) {
        calls.push(args);
      },
    });
    const parsed = JSON.parse(readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { url: string }>;
    };
    assert.equal(parsed.mcpServers.other?.url, "http://127.0.0.1:9/mcp");
    assert.equal(parsed.mcpServers["comms-gate"]?.url, url);
    if (hasBin("claude")) {
      assert.deepEqual(calls[0], ["mcp", "add", "--transport", "http", "comms-gate", url]);
    } else {
      assert.equal(calls.length, 0);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the room API, the worker handoff, and the live stream", async () => {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "http-"));
  const store = new Store(path.join(dir, "gate.db"));
  const runner = new FakeRunner();
  const gate = new Gate({
    store,
    runner,
    git: { hasHead: () => false, addWorktree() {} },
    worktreesRoot: path.join(dir, "wt"),
  });
  const server = createHttpServer(gate, { clis: { claude: true, cursor: false } });
  await listenLocal(server, 0);
  const address = server.address() as AddressInfo;
  assert.equal(address.address, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Comms gate/);
    const meta = (await (await fetch(`${base}/meta`)).json()) as { cursor: boolean };
    assert.equal(meta.cursor, false);
    assert.equal((await fetch(`${base}/rooms/missing`)).status, 404);

    const bad = await fetch(`${base}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bad", workdir: path.join(dir, "nope") }),
    });
    assert.equal(bad.status, 400);

    const created = (await (
      await fetch(`${base}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Notes", workdir: dir, autoRun: false }),
      })
    ).json()) as { id: string; briefRevision: number };

    const posted = await fetch(`${base}/rooms/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "you", body: "hello room" }),
    });
    assert.equal(posted.status, 201);
    const huge = await fetch(`${base}/rooms/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "you", body: "x".repeat(8001) }),
    });
    assert.equal(huge.status, 400);

    const saved = await fetch(`${base}/rooms/${created.id}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: created.briefRevision, brief: "Ship the parser." }),
    });
    assert.equal(saved.status, 200);
    const conflict = await fetch(`${base}/rooms/${created.id}/brief`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: created.briefRevision, brief: "stale" }),
    });
    assert.equal(conflict.status, 409);

    const waiting = (await (
      await fetch(`${base}/rooms/${created.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Wait", details: "not yet" }),
      })
    ).json()) as { status: string };
    assert.equal(waiting.status, "queued");
    const waitingRoom = (await (await fetch(`${base}/rooms/${created.id}`)).json()) as {
      messages: Array<{ body: string }>;
    };
    assert.ok(waitingRoom.messages.some((message) => message.body.includes("auto-run is off")));

    const events = await fetch(`${base}/rooms/${created.id}/events`);
    assert.equal(events.status, 200);
    const reader = events.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let streamed = "";
    const seen = (async () => {
      while (!streamed.includes("from the stream")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        streamed += decoder.decode(chunk.value);
      }
      return streamed;
    })();
    await fetch(`${base}/rooms/${created.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "you", body: "from the stream" }),
    });
    assert.match(await seen, /from the stream/);
    await reader.cancel();

    const work = (await (
      await fetch(`${base}/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Work", workdir: dir, autoRun: true, defaultWorker: "claude" }),
      })
    ).json()) as { id: string };
    await fetch(`${base}/rooms/${work.id}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Write the parser", details: "Cover strings.", worker: "claude" }),
    });
    assert.equal(runner.runs.length, 1);
    assert.match(runner.runs[0]?.prompt ?? "", /Write the parser/);
    assert.equal(runner.runs[0]?.prompt.includes("http://"), false);
    runner.succeed(JSON.stringify({ result: "Parser covers strings." }));
    await until(async () => {
      const snapshot = (await (await fetch(`${base}/rooms/${work.id}`)).json()) as {
        tasks: Array<{ status: string }>;
        messages: Array<{ kind: string; body: string }>;
      };
      return (
        snapshot.tasks[0]?.status === "done" &&
        snapshot.messages.some((message) => message.kind === "handoff" && message.body === "Parser covers strings.")
      );
    });

    for (let i = 0; i < 10; i += 1) store.recordSpawn(work.id, `old${i}`);
    const capped = (await (
      await fetch(`${base}/rooms/${work.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Later" }),
      })
    ).json()) as { id: string };
    const afterCap = (await (await fetch(`${base}/rooms/${work.id}`)).json()) as {
      tasks: Array<{ id: string; status: string }>;
      messages: Array<{ body: string }>;
    };
    assert.equal(afterCap.tasks.find((task) => task.id === capped.id)?.status, "queued");
    assert.ok(afterCap.messages.some((message) => message.body.includes("10 runs in the last hour")));
    assert.equal(runner.runs.length, 1);

    const busy = createHttpServer(gate);
    await assert.rejects(listenLocal(busy, address.port), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an MCP client can join and add a task", async () => {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "mcp-"));
  const store = new Store(path.join(dir, "gate.db"));
  const gate = new Gate({
    store,
    runner: new FakeRunner(),
    git: { hasHead: () => false, addWorktree() {} },
    worktreesRoot: path.join(dir, "wt"),
  });
  const server = createHttpServer(gate);
  await listenLocal(server, 0);
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: "comms-test", version: "0.0.0" });
  try {
    const room = gate.createRoom({ title: "MCP", workdir: dir, autoRun: false });
    assert.ok("room" in room);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    const joined = await client.callTool({
      name: "join",
      arguments: { roomId: room.room.id, name: "claude-tests", client: "claude" },
    });
    assert.equal(joined.isError, false);
    const created = await client.callTool({
      name: "create_task",
      arguments: { roomId: room.room.id, title: "From Claude", details: "Check the room." },
    });
    const body = JSON.parse(textOf(created)) as { title?: string; error?: string };
    assert.equal(body.title, "From Claude");
    const inbox = await client.callTool({
      name: "inbox",
      arguments: { roomId: room.room.id, memberName: "claude-tests" },
    });
    const snapshot = JSON.parse(textOf(inbox)) as { tasks: Array<{ title: string }> };
    assert.equal(snapshot.tasks[0]?.title, "From Claude");
    await client.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const block = content?.find((item) => item.type === "text");
  assert.ok(block?.text);
  return block.text;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the room");
}
