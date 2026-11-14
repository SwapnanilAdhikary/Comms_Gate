import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { GateEvent } from "./events.ts";
import {
  HOUR_MS,
  MESSAGE_CAP,
  type MessageKind,
  type PermissionLevel,
  type Room,
  type Store,
  type Task,
  type WorkerKind,
} from "./store.ts";

export const PROMPT_CAP = 80_000;
export const MAX_CONCURRENT = 2;
export const MAX_DEPTH = 2;
export const MAX_SPAWNS_PER_HOUR = 10;

export interface RunSpec {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
}

export interface RunningWorker {
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  exited: Promise<number>;
  kill(): void;
}

export interface Runner {
  run(spec: RunSpec): RunningWorker;
}

export interface GitOps {
  hasHead(dir: string): boolean;
  addWorktree(repo: string, dest: string): void;
}

export interface Followup {
  worker: WorkerKind;
  title: string;
  details: string;
}

export function workerCommand(
  worker: WorkerKind,
  room: { permission: PermissionLevel; budgetUsd: number },
): { command: string; args: string[] } {
  if (worker === "claude") {
    const mode = room.permission === "open" ? "auto" : "acceptEdits";
    return {
      command: "claude",
      args: [
        "--print",
        "--output-format",
        "json",
        "--permission-mode",
        mode,
        "--max-budget-usd",
        String(room.budgetUsd),
      ],
    };
  }
  const args = ["-p", "--trust", "--output-format", "json"];
  if (room.permission === "open") args.push("--force");
  return { command: "agent", args };
}

export function buildPrompt(input: {
  brief: string;
  task: { title: string; details: string };
  messages: Array<{ authorName: string; body: string }>;
}): string {
  const instructions = `You are a headless worker for one task.
Do that task. Stay inside this working directory. Do not start other agents or call a room API.

Finish with a short handoff: what changed, what you decided, and what is next.
If another worker should continue, end with exactly:

FOLLOWUPS:
- [claude] title | details
- [cursor] title | details

Omit FOLLOWUPS when there is nothing else to do.`;
  const taskBlock = `## Task\n${input.task.title}\n${input.task.details}`.trimEnd();
  const briefBlock = `## Brief\n${input.brief.trim()}`;
  let messages = input.messages.slice();
  const render = () => {
    const thread = messages.map((message) => `[${message.authorName}] ${message.body}`).join("\n");
    return `${instructions}\n\n${briefBlock}\n\n## Recent room messages\n${thread}\n\n${taskBlock}\n`;
  };
  let prompt = render();
  while (prompt.length > PROMPT_CAP && messages.length > 0) {
    messages = messages.slice(1);
    prompt = render();
  }
  if (prompt.length > PROMPT_CAP) return prompt.slice(0, PROMPT_CAP);
  return prompt;
}

export function parseFollowups(text: string): Followup[] {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "FOLLOWUPS:") start = i + 1;
  }
  if (start < 0) return [];
  const followups: Followup[] = [];
  for (const line of lines.slice(start)) {
    const match = /^- \[(claude|cursor)\]\s+(.+?)\s+\|\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const title = match[2]?.trim() ?? "";
    if (!title) continue;
    followups.push({
      worker: match[1] === "cursor" ? "cursor" : "claude",
      title,
      details: (match[3] ?? "").trim(),
    });
  }
  return followups;
}

export function resultText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown };
    if (typeof parsed.result === "string") return parsed.result;
  } catch {
    return trimmed;
  }
  return trimmed;
}

export function createGit(): GitOps {
  return {
    hasHead(dir: string): boolean {
      try {
        execFileSync("git", ["-C", dir, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    addWorktree(repo: string, dest: string): void {
      mkdirSync(path.dirname(dest), { recursive: true });
      execFileSync("git", ["-C", repo, "worktree", "add", "--detach", dest, "HEAD"], { stdio: "pipe" });
    },
  };
}

export const processRunner: Runner = {
  run(spec: RunSpec): RunningWorker {
    const child = spawn(spec.command, [...spec.args, spec.prompt], {
      cwd: spec.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutWait: Array<(chunk: string) => void> = [];
    const stderrWait: Array<(chunk: string) => void> = [];
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdoutWait.length === 0) stdoutBuf.push(chunk);
      else for (const cb of stdoutWait) cb(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderrWait.length === 0) stderrBuf.push(chunk);
      else for (const cb of stderrWait) cb(chunk);
    });
    child.stdin.end();
    let settled = false;
    const exited = new Promise<number>((resolve) => {
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      child.on("error", () => finish(127));
      child.on("close", (code) => finish(code ?? 1));
    });
    return {
      onStdout(cb) {
        stdoutWait.push(cb);
        for (const chunk of stdoutBuf.splice(0)) cb(chunk);
      },
      onStderr(cb) {
        stderrWait.push(cb);
        for (const chunk of stderrBuf.splice(0)) cb(chunk);
      },
      exited,
      kill() {
        child.kill("SIGTERM");
      },
    };
  },
};

export interface SupervisorDeps {
  store: Store;
  runner: Runner;
  git: GitOps;
  worktreesRoot: string;
  emit?: (event: GateEvent) => void;
}

export class Supervisor {
  private deps: SupervisorDeps;
  private locks = new Set<string>();
  private running = new Map<string, RunningWorker>();
  private timers = new Map<string, NodeJS.Timeout>();
  private timedOut = new Set<string>();

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
  }

  pump(roomId: string): void {
    if (this.locks.has(roomId)) return;
    this.locks.add(roomId);
    try {
      for (;;) {
        const room = this.deps.store.getRoom(roomId);
        if (!room?.autoRun || !room.workdir) break;
        const max = this.deps.git.hasHead(room.workdir) ? MAX_CONCURRENT : 1;
        if (this.deps.store.runningCount(roomId) >= max) break;
        const task = this.deps.store.nextQueued(roomId);
        if (!task) break;
        const since = this.deps.store.now() - HOUR_MS;
        if (this.deps.store.countSpawnsSince(roomId, since) >= MAX_SPAWNS_PER_HOUR) {
          this.say(roomId, "Stopped spawning: 10 runs in the last hour.", "system");
          break;
        }
        this.launch(room, task);
      }
    } finally {
      this.locks.delete(roomId);
    }
  }

  release(taskId: string): Task | null {
    const task = this.deps.store.getTask(taskId);
    if (!task) return null;
    if (task.status !== "queued" && task.status !== "running") return task;
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
    this.running.get(taskId)?.kill();
    this.running.delete(taskId);
    const blocked = this.deps.store.markBlocked(taskId);
    if (blocked) {
      this.emitTask(blocked);
      this.say(blocked.roomId, `Released "${blocked.title}".`, "system");
    }
    return blocked ?? task;
  }

  private launch(room: Room, task: Task): void {
    let cwd = room.workdir ?? "";
    let worktree: string | null = null;
    if (room.workdir && this.deps.git.hasHead(room.workdir)) {
      worktree = path.join(this.deps.worktreesRoot, room.id, task.id);
      try {
        this.deps.git.addWorktree(room.workdir, worktree);
        cwd = worktree;
      } catch (error) {
        const blocked = this.deps.store.markBlocked(task.id);
        if (blocked) this.emitTask(blocked);
        const reason = error instanceof Error ? error.message : "worktree failed";
        this.say(room.id, `Could not create a worktree for "${task.title}": ${reason}`.slice(0, MESSAGE_CAP), "system");
        return;
      }
    }
    const running = this.deps.store.markRunning(task.id, worktree);
    if (!running) return;
    this.deps.store.recordSpawn(room.id, task.id);
    this.emitTask(running);
    this.say(room.id, `Started ${task.worker} on "${task.title}" in ${cwd}.`, "system");

    const snap = this.deps.store.inbox(room.id, "", { limit: 20 });
    const command = workerCommand(task.worker, room);
    const prompt = buildPrompt({
      brief: room.brief,
      task,
      messages: snap?.messages ?? [],
    });
    const worker = this.deps.runner.run({
      command: command.command,
      args: command.args,
      cwd,
      prompt,
    });
    this.running.set(task.id, worker);
    let stdout = "";
    let stderr = "";
    const take = (which: "out" | "err") => (chunk: string) => {
      if (which === "out") stdout = (stdout + chunk).slice(-1_000_000);
      else stderr = (stderr + chunk).slice(-1_000_000);
      this.deps.store.appendLog(task.id, chunk);
      this.deps.emit?.({ type: "log", roomId: room.id, taskId: task.id, chunk });
    };
    worker.onStdout(take("out"));
    worker.onStderr(take("err"));

    const timer = setTimeout(() => {
      this.timedOut.add(task.id);
      worker.kill();
    }, room.timeoutMs);
    timer.unref();
    this.timers.set(task.id, timer);

    void worker.exited.then((code) => {
      const pending = this.timers.get(task.id);
      if (pending) clearTimeout(pending);
      this.timers.delete(task.id);
      this.running.delete(task.id);
      const current = this.deps.store.getTask(task.id);
      if (!current || current.status !== "running") return;
      if (this.timedOut.has(task.id)) {
        const blocked = this.deps.store.markBlocked(task.id);
        if (blocked) this.emitTask(blocked);
        this.say(room.id, `${task.worker} timed out on "${task.title}".`.slice(0, MESSAGE_CAP), "system");
      } else if (code === 0) {
        const text = resultText(stdout).trim() || "(no output)";
        const done = this.deps.store.markDone(task.id);
        if (done) this.emitTask(done);
        this.say(room.id, text.slice(0, MESSAGE_CAP), "handoff", task.worker);
        this.createFollowups(room, task, text);
      } else {
        const blocked = this.deps.store.markBlocked(task.id);
        if (blocked) this.emitTask(blocked);
        const tail = (stderr || stdout).trim().slice(-2000);
        const body = `${task.worker} exited ${code} on "${task.title}".\n${tail}`.trim();
        this.say(room.id, body.slice(0, MESSAGE_CAP), "system");
      }
      this.timedOut.delete(task.id);
      this.pump(room.id);
    });
  }

  private createFollowups(room: Room, parent: Task, text: string): void {
    for (const item of parseFollowups(text)) {
      const depth = parent.depth + 1;
      const child = this.deps.store.createTask({
        roomId: room.id,
        title: item.title,
        details: item.details,
        worker: item.worker,
        depth,
      });
      this.emitTask(child);
      if (depth >= MAX_DEPTH) {
        this.say(room.id, `Follow-up not started (depth limit): ${item.title}`, "system");
      }
    }
  }

  private emitTask(task: Task): void {
    this.deps.emit?.({ type: "task", roomId: task.roomId, task });
  }

  private say(roomId: string, body: string, kind: MessageKind, author = "room"): void {
    const result = this.deps.store.postMessage(roomId, author, body, kind);
    if (result.message) this.deps.emit?.({ type: "message", roomId, message: result.message });
  }
}
