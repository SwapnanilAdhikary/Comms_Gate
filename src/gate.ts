import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { GateEvent } from "./events.ts";
import { createGit, processRunner, Supervisor, type GitOps, type Runner } from "./supervisor.ts";
import {
  Store,
  type Message,
  type PermissionLevel,
  type PostResult,
  type Room,
  type Snapshot,
  type Task,
  type WorkerKind,
} from "./store.ts";

export type RoomInput = {
  title?: string;
  workdir?: string | null;
  defaultWorker?: WorkerKind;
  autoRun?: boolean;
};

export type SettingsInput = {
  title?: string;
  workdir?: string | null;
  defaultWorker?: WorkerKind;
  autoRun?: boolean;
  permission?: PermissionLevel;
  timeoutMs?: number;
  budgetUsd?: number;
};

export class Gate {
  readonly store: Store;
  readonly supervisor: Supervisor;
  private listeners = new Set<(event: GateEvent) => void>();

  constructor(opts: { store: Store; runner?: Runner; git?: GitOps; worktreesRoot: string }) {
    this.store = opts.store;
    this.supervisor = new Supervisor({
      store: opts.store,
      runner: opts.runner ?? processRunner,
      git: opts.git ?? createGit(),
      worktreesRoot: opts.worktreesRoot,
      emit: (event) => this.emit(event),
    });
  }

  subscribe(listener: (event: GateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listRooms(): Room[] {
    return this.store.listRooms();
  }

  load(roomId: string): Snapshot | null {
    return this.store.load(roomId);
  }

  createRoom(input: RoomInput): { room: Room } | { error: "workdir" | "worker" } {
    const worker = input.defaultWorker ?? "claude";
    if (worker !== "claude" && worker !== "cursor") return { error: "worker" };
    const workdir = this.resolveWorkdir(input.workdir);
    if (workdir === false) return { error: "workdir" };
    const room = this.store.createRoom({
      title: input.title,
      workdir,
      defaultWorker: worker,
      autoRun: workdir ? input.autoRun !== false : false,
    });
    return { room };
  }

  updateSettings(roomId: string, patch: SettingsInput): { room: Room } | { error: "not_found" | "workdir" | "worker" } | null {
    const current = this.store.getRoom(roomId);
    if (!current) return { error: "not_found" };
    if (patch.defaultWorker && patch.defaultWorker !== "claude" && patch.defaultWorker !== "cursor") {
      return { error: "worker" };
    }
    let workdir = patch.workdir;
    if (patch.workdir !== undefined) {
      const resolved = this.resolveWorkdir(patch.workdir);
      if (resolved === false) return { error: "workdir" };
      workdir = resolved;
    }
    const nextWorkdir = workdir === undefined ? current.workdir : workdir;
    const autoRun = patch.autoRun ?? current.autoRun;
    const room = this.store.updateSettings(roomId, {
      ...patch,
      workdir,
      autoRun: nextWorkdir ? autoRun : false,
    });
    if (!room) return null;
    this.emit({ type: "room", roomId, room });
    if (room.autoRun && room.workdir) this.supervisor.pump(roomId);
    return { room };
  }

  updateBrief(roomId: string, revision: number, brief: string) {
    const result = this.store.updateBrief(roomId, revision, brief);
    if (result?.ok) this.emit({ type: "room", roomId, room: result.room });
    return result;
  }

  join(roomId: string, name: string, client: string) {
    return this.store.join(roomId, name, client);
  }

  inbox(roomId: string, memberName: string, opts?: { afterId?: string; limit?: number }): Snapshot | null {
    return this.store.inbox(roomId, memberName, opts);
  }

  postMessage(roomId: string, author: string, body: string): PostResult {
    const result = this.store.postMessage(roomId, author, body, "say");
    if (result.message) this.emit({ type: "message", roomId, message: result.message });
    return result;
  }

  addTask(
    roomId: string,
    input: { title?: string; details?: string; worker?: WorkerKind; depth?: number },
  ): { task: Task } | { error: "not_found" | "empty" | "worker" } {
    const room = this.store.getRoom(roomId);
    if (!room) return { error: "not_found" };
    const title = input.title?.trim() ?? "";
    if (!title) return { error: "empty" };
    const worker = input.worker ?? room.defaultWorker;
    if (worker !== "claude" && worker !== "cursor") return { error: "worker" };
    const depth = input.depth ?? 0;
    const task = this.store.createTask({
      roomId,
      title,
      details: input.details?.trim() ?? "",
      worker,
      depth,
    });
    this.emit({ type: "task", roomId, task });
    if (!room.workdir) {
      this.note(roomId, `Task queued: set a working directory before "${task.title}" can run.`);
    } else if (!room.autoRun) {
      this.note(roomId, `Task queued: auto-run is off, so "${task.title}" is waiting.`);
    } else if (depth >= 2) {
      this.note(roomId, `Task kept but not started (depth limit): ${task.title}`);
    }
    if (room.autoRun && room.workdir) this.supervisor.pump(roomId);
    return { task };
  }

  release(taskId: string): Task | null {
    return this.supervisor.release(taskId);
  }

  private note(roomId: string, body: string): Message | undefined {
    const result = this.store.postMessage(roomId, "room", body, "system");
    if (result.message) this.emit({ type: "message", roomId, message: result.message });
    return result.message;
  }

  private emit(event: GateEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private resolveWorkdir(input: string | null | undefined): string | null | false {
    if (input == null) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    const abs = path.resolve(trimmed);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return false;
    return abs;
  }
}
