import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import {
  buildPrompt,
  createGit,
  parseFollowups,
  Supervisor,
  workerCommand,
  type Runner,
  type RunningWorker,
  type RunSpec,
} from "../src/supervisor.ts";

const root = path.join(import.meta.dirname, "..", ".tmp");

class FakeRunner implements Runner {
  runs: RunSpec[] = [];
  private live: Array<{
    finish: (code: number) => void;
    emitOut: (chunk: string) => void;
    emitErr: (chunk: string) => void;
  }> = [];

  run(spec: RunSpec): RunningWorker {
    this.runs.push(spec);
    let outCb: ((chunk: string) => void) | null = null;
    let errCb: ((chunk: string) => void) | null = null;
    const outBuf: string[] = [];
    const errBuf: string[] = [];
    let finish: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const slot = {
      finish,
      emitOut(chunk: string) {
        if (outCb) outCb(chunk);
        else outBuf.push(chunk);
      },
      emitErr(chunk: string) {
        if (errCb) errCb(chunk);
        else errBuf.push(chunk);
      },
    };
    this.live.push(slot);
    return {
      onStdout(cb) {
        outCb = cb;
        for (const chunk of outBuf.splice(0)) cb(chunk);
      },
      onStderr(cb) {
        errCb = cb;
        for (const chunk of errBuf.splice(0)) cb(chunk);
      },
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

  fail(stderr: string): void {
    const slot = this.live.shift();
    assert.ok(slot);
    slot.emitErr(stderr);
    slot.finish(1);
  }
}

function setup(opts?: { git?: boolean; now?: number }) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "sup-"));
  let now = opts?.now ?? 1_000_000;
  const store = new Store(path.join(dir, "gate.db"), () => now);
  const runner = new FakeRunner();
  const workdirs: string[] = [];
  const git = {
    hasHead: () => opts?.git ?? false,
    addWorktree(_repo: string, dest: string) {
      mkdirSync(dest, { recursive: true });
      workdirs.push(dest);
    },
  };
  const supervisor = new Supervisor({
    store,
    runner,
    git,
    worktreesRoot: path.join(dir, "worktrees"),
  });
  const room = store.createRoom({
    title: "Work",
    workdir: dir,
    defaultWorker: "claude",
    autoRun: true,
  });
  return {
    dir,
    store,
    runner,
    supervisor,
    room,
    workdirs,
    setNow(n: number) {
      now = n;
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("worker commands stay inside the default permission boundary", () => {
  const claude = workerCommand("claude", { permission: "default", budgetUsd: 2 });
  assert.equal(claude.command, "claude");
  assert.ok(claude.args.includes("acceptEdits"));
  assert.ok(claude.args.includes("2"));
  assert.equal(claude.args.includes("--force"), false);
  assert.equal(claude.args.includes("bypassPermissions"), false);

  const openClaude = workerCommand("claude", { permission: "open", budgetUsd: 4 });
  assert.ok(openClaude.args.includes("auto"));
  assert.ok(openClaude.args.includes("4"));

  const cursor = workerCommand("cursor", { permission: "default", budgetUsd: 2 });
  assert.deepEqual(cursor, { command: "agent", args: ["-p", "--trust", "--output-format", "json"] });
  const openCursor = workerCommand("cursor", { permission: "open", budgetUsd: 2 });
  assert.ok(openCursor.args.includes("--force"));
});

test("the prompt carries the brief and the task and no room URL", () => {
  const prompt = buildPrompt({
    brief: "Ship the parser.",
    task: { title: "Write it", details: "Cover strings." },
    messages: [{ authorName: "you", body: "start with quotes" }],
  });
  assert.match(prompt, /Ship the parser/);
  assert.match(prompt, /Write it/);
  assert.match(prompt, /start with quotes/);
  assert.match(prompt, /FOLLOWUPS:/);
  assert.equal(prompt.includes("http://"), false);
  assert.equal(prompt.includes("https://"), false);
});

test("parseFollowups reads the last trailer", () => {
  const text = ["noise", "FOLLOWUPS:", "- [claude] first | one", "FOLLOWUPS:", "- [cursor] docs | write them"].join("\n");
  assert.deepEqual(parseFollowups(text), [{ worker: "cursor", title: "docs", details: "write them" }]);
  assert.deepEqual(parseFollowups("no trailer"), []);
});

test("a successful run posts the handoff and starts from a worktree", async () => {
  const ctx = setup({ git: true });
  try {
    storeBrief(ctx.store, ctx.room.id, "Keep the public API.");
    const task = ctx.store.createTask({
      roomId: ctx.room.id,
      title: "Write the parser",
      details: "Cover strings.",
      worker: "claude",
      depth: 0,
    });
    ctx.supervisor.pump(ctx.room.id);
    assert.equal(ctx.runner.runs.length, 1);
    assert.equal(ctx.runner.runs[0]?.command, "claude");
    assert.equal(ctx.runner.runs[0]?.cwd, ctx.workdirs[0]);
    assert.match(ctx.runner.runs[0]?.prompt ?? "", /Keep the public API/);
    assert.equal(ctx.store.getTask(task.id)?.status, "running");

    ctx.runner.succeed(JSON.stringify({ result: "Parser covers strings." }));
    await settle();

    assert.equal(ctx.store.getTask(task.id)?.status, "done");
    const inbox = ctx.store.inbox(ctx.room.id, "you");
    const handoff = inbox?.messages.find((message) => message.kind === "handoff");
    assert.equal(handoff?.body, "Parser covers strings.");
    assert.equal(handoff?.authorName, "claude");
  } finally {
    ctx.close();
  }
});

test("a failing run blocks the task and posts the error tail", async () => {
  const ctx = setup();
  try {
    ctx.store.createTask({
      roomId: ctx.room.id,
      title: "Break",
      details: "",
      worker: "cursor",
      depth: 0,
    });
    ctx.supervisor.pump(ctx.room.id);
    ctx.runner.fail("missing import");
    await settle();
    const task = ctx.store.listTasks(ctx.room.id)[0];
    assert.equal(task?.status, "blocked");
    const inbox = ctx.store.inbox(ctx.room.id, "you");
    const note = inbox?.messages.find((message) => message.body.includes("missing import"));
    assert.ok(note);
    assert.match(note.body, /exited 1/);
  } finally {
    ctx.close();
  }
});

test("follow-ups past the depth limit are kept and not started", async () => {
  const ctx = setup();
  try {
    ctx.store.createTask({
      roomId: ctx.room.id,
      title: "Parent",
      details: "",
      worker: "claude",
      depth: 1,
    });
    ctx.supervisor.pump(ctx.room.id);
    ctx.runner.succeed(
      JSON.stringify({ result: "done\nFOLLOWUPS:\n- [cursor] docs | write them" }),
    );
    await settle();
    const tasks = ctx.store.listTasks(ctx.room.id);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1]?.depth, 2);
    assert.equal(tasks[1]?.status, "queued");
    assert.equal(ctx.runner.runs.length, 1);
    const inbox = ctx.store.inbox(ctx.room.id, "you");
    assert.ok(inbox?.messages.some((message) => message.body.includes("depth limit")));
  } finally {
    ctx.close();
  }
});

test("a follow-up under the depth limit starts", async () => {
  const ctx = setup({ git: true });
  try {
    ctx.store.createTask({
      roomId: ctx.room.id,
      title: "Parent",
      details: "",
      worker: "claude",
      depth: 0,
    });
    ctx.supervisor.pump(ctx.room.id);
    ctx.runner.succeed(JSON.stringify({ result: "done\nFOLLOWUPS:\n- [cursor] docs | write them" }));
    await settle();
    assert.equal(ctx.runner.runs.length, 2);
    assert.equal(ctx.runner.runs[1]?.command, "agent");
    assert.equal(ctx.store.listTasks(ctx.room.id)[1]?.status, "running");
  } finally {
    ctx.close();
  }
});

test("the hourly cap leaves the task queued", () => {
  const ctx = setup();
  try {
    for (let i = 0; i < 10; i += 1) ctx.store.recordSpawn(ctx.room.id, `old${i}`);
    ctx.store.createTask({
      roomId: ctx.room.id,
      title: "Later",
      details: "",
      worker: "claude",
      depth: 0,
    });
    ctx.supervisor.pump(ctx.room.id);
    assert.equal(ctx.runner.runs.length, 0);
    assert.equal(ctx.store.listTasks(ctx.room.id)[0]?.status, "queued");
    const inbox = ctx.store.inbox(ctx.room.id, "you");
    assert.ok(inbox?.messages.some((message) => message.body.includes("10 runs in the last hour")));
  } finally {
    ctx.close();
  }
});

test("a directory that is not a git checkout runs one worker at a time", async () => {
  const ctx = setup({ git: false });
  try {
    ctx.store.createTask({ roomId: ctx.room.id, title: "one", details: "", worker: "claude", depth: 0 });
    ctx.store.createTask({ roomId: ctx.room.id, title: "two", details: "", worker: "claude", depth: 0 });
    ctx.supervisor.pump(ctx.room.id);
    assert.equal(ctx.runner.runs.length, 1);
    ctx.runner.succeed(JSON.stringify({ result: "first done" }));
    await settle();
    assert.equal(ctx.runner.runs.length, 2);
  } finally {
    ctx.close();
  }
});

test("two git worktrees can run together", () => {
  const ctx = setup({ git: true });
  try {
    ctx.store.createTask({ roomId: ctx.room.id, title: "one", details: "", worker: "claude", depth: 0 });
    ctx.store.createTask({ roomId: ctx.room.id, title: "two", details: "", worker: "cursor", depth: 0 });
    ctx.store.createTask({ roomId: ctx.room.id, title: "three", details: "", worker: "claude", depth: 0 });
    ctx.supervisor.pump(ctx.room.id);
    assert.equal(ctx.runner.runs.length, 2);
    assert.equal(ctx.store.runningCount(ctx.room.id), 2);
    assert.equal(ctx.store.listTasks(ctx.room.id)[2]?.status, "queued");
  } finally {
    ctx.close();
  }
});

test("a timeout kills the worker and blocks the task", async () => {
  const ctx = setup();
  try {
    ctx.store.updateSettings(ctx.room.id, { timeoutMs: 30 });
    ctx.store.createTask({ roomId: ctx.room.id, title: "slow", details: "", worker: "claude", depth: 0 });
    ctx.supervisor.pump(ctx.room.id);
    assert.equal(ctx.runner.runs.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(ctx.store.listTasks(ctx.room.id)[0]?.status, "blocked");
    const inbox = ctx.store.inbox(ctx.room.id, "you");
    assert.ok(inbox?.messages.some((message) => message.body.includes("timed out")));
  } finally {
    ctx.close();
  }
});

test("release kills a running worker and does not mark it done", async () => {
  const ctx = setup();
  try {
    const task = ctx.store.createTask({
      roomId: ctx.room.id,
      title: "stop me",
      details: "",
      worker: "claude",
      depth: 0,
    });
    ctx.supervisor.pump(ctx.room.id);
    const released = ctx.supervisor.release(task.id);
    await settle();
    assert.equal(released?.status, "blocked");
    assert.equal(ctx.store.getTask(task.id)?.status, "blocked");
    const inbox = ctx.store.inbox(ctx.room.id, "you");
    assert.equal(inbox?.messages.some((message) => message.kind === "handoff"), false);
  } finally {
    ctx.close();
  }
});

test("createGit adds a detached worktree", () => {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "git-"));
  try {
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "gate@local"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "gate"], { cwd: repo });
    writeFileSync(path.join(repo, "README"), "hi\n");
    execFileSync("git", ["add", "README"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const dest = path.join(dir, "wt");
    createGit().addWorktree(repo, dest);
    assert.equal(existsSync(path.join(dest, "README")), true);
    assert.equal(createGit().hasHead(repo), true);
    assert.equal(createGit().hasHead(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function storeBrief(store: Store, roomId: string, brief: string): void {
  const room = store.getRoom(roomId);
  assert.ok(room);
  const saved = store.updateBrief(roomId, room.briefRevision, brief);
  assert.equal(saved?.ok, true);
}
