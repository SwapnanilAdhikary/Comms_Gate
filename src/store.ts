import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const MESSAGE_CAP = 8000;
export const LOG_CAP = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_BUDGET_USD = 2;
export const INBOX_LIMIT = 30;
export const HOUR_MS = 60 * 60 * 1000;

export const STARTER_BRIEF = `## Goal

## Decisions

## Constraints

## Now
`;

export type WorkerKind = "claude" | "cursor";
export type TaskStatus = "queued" | "running" | "done" | "blocked";
export type PermissionLevel = "default" | "open";
export type MessageKind = "say" | "system" | "handoff";

export interface Room {
  id: string;
  title: string;
  workdir: string | null;
  defaultWorker: WorkerKind;
  autoRun: boolean;
  permission: PermissionLevel;
  timeoutMs: number;
  budgetUsd: number;
  brief: string;
  briefRevision: number;
  createdAt: number;
}

export interface Member {
  id: string;
  roomId: string;
  name: string;
  client: string;
  lastSeen: number;
}

export interface Message {
  id: string;
  roomId: string;
  authorName: string;
  body: string;
  kind: MessageKind;
  createdAt: number;
  seq: number;
}

export interface Task {
  id: string;
  roomId: string;
  title: string;
  details: string;
  status: TaskStatus;
  worker: WorkerKind;
  depth: number;
  log: string;
  worktree: string | null;
  createdAt: number;
  seq: number;
}

export interface Snapshot {
  room: Room;
  members: Member[];
  messages: Message[];
  tasks: Task[];
}

export type PostResult =
  | { message: Message; error?: undefined }
  | { message?: undefined; error: "too_long" | "empty" | "not_found" };

export type BriefResult = { ok: true; room: Room } | { ok: false; room: Room } | null;

interface RoomRow {
  id: string;
  title: string;
  workdir: string | null;
  default_worker: WorkerKind;
  auto_run: number;
  permission: PermissionLevel;
  timeout_ms: number;
  budget_usd: number;
  brief: string;
  brief_revision: number;
  created_at: number;
}

interface MemberRow {
  id: string;
  room_id: string;
  name: string;
  client: string;
  last_seen: number;
}

interface MessageRow {
  id: string;
  room_id: string;
  author_name: string;
  body: string;
  kind: MessageKind;
  created_at: number;
  seq: number;
}

interface TaskRow {
  id: string;
  room_id: string;
  title: string;
  details: string;
  status: TaskStatus;
  worker: WorkerKind;
  depth: number;
  log: string;
  worktree: string | null;
  created_at: number;
  seq: number;
}

function nid(): string {
  return randomBytes(8).toString("hex");
}

function roomFrom(row: RoomRow): Room {
  return {
    id: row.id,
    title: row.title,
    workdir: row.workdir,
    defaultWorker: row.default_worker,
    autoRun: row.auto_run === 1,
    permission: row.permission,
    timeoutMs: row.timeout_ms,
    budgetUsd: row.budget_usd,
    brief: row.brief,
    briefRevision: row.brief_revision,
    createdAt: row.created_at,
  };
}

function memberFrom(row: MemberRow): Member {
  return {
    id: row.id,
    roomId: row.room_id,
    name: row.name,
    client: row.client,
    lastSeen: row.last_seen,
  };
}

function messageFrom(row: MessageRow): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    authorName: row.author_name,
    body: row.body,
    kind: row.kind,
    createdAt: row.created_at,
    seq: row.seq,
  };
}

function taskFrom(row: TaskRow): Task {
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    details: row.details,
    status: row.status,
    worker: row.worker,
    depth: row.depth,
    log: row.log,
    worktree: row.worktree,
    createdAt: row.created_at,
    seq: row.seq,
  };
}

export class Store {
  private db: DatabaseSync;
  private clock: () => number;

  constructor(file: string, clock: () => number = Date.now) {
    this.clock = clock;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workdir TEXT,
        default_worker TEXT NOT NULL,
        auto_run INTEGER NOT NULL,
        permission TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        budget_usd REAL NOT NULL,
        brief TEXT NOT NULL,
        brief_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        name TEXT NOT NULL,
        client TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        UNIQUE(room_id, name)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        title TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL,
        worker TEXT NOT NULL,
        depth INTEGER NOT NULL,
        log TEXT NOT NULL,
        worktree TEXT,
        created_at INTEGER NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spawns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
    `);
  }

  now(): number {
    return this.clock();
  }

  close(): void {
    this.db.close();
  }

  createRoom(input: {
    title?: string;
    workdir?: string | null;
    defaultWorker?: WorkerKind;
    autoRun?: boolean;
  }): Room {
    const workdir = input.workdir?.trim() ? input.workdir.trim() : null;
    const room: Room = {
      id: nid(),
      title: input.title?.trim() || "Room",
      workdir,
      defaultWorker: input.defaultWorker ?? "claude",
      autoRun: input.autoRun ?? false,
      permission: "default",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      budgetUsd: DEFAULT_BUDGET_USD,
      brief: STARTER_BRIEF,
      briefRevision: 1,
      createdAt: this.clock(),
    };
    this.db
      .prepare(
        `INSERT INTO rooms (
          id, title, workdir, default_worker, auto_run, permission, timeout_ms,
          budget_usd, brief, brief_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        room.id,
        room.title,
        room.workdir,
        room.defaultWorker,
        room.autoRun ? 1 : 0,
        room.permission,
        room.timeoutMs,
        room.budgetUsd,
        room.brief,
        room.briefRevision,
        room.createdAt,
      );
    return room;
  }

  getRoom(id: string): Room | null {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
    return row ? roomFrom(row) : null;
  }

  listRooms(): Room[] {
    const rows = this.db.prepare("SELECT * FROM rooms ORDER BY created_at DESC").all() as unknown as RoomRow[];
    return rows.map(roomFrom);
  }

  updateSettings(
    id: string,
    patch: {
      title?: string;
      workdir?: string | null;
      defaultWorker?: WorkerKind;
      autoRun?: boolean;
      permission?: PermissionLevel;
      timeoutMs?: number;
      budgetUsd?: number;
    },
  ): Room | null {
    const current = this.getRoom(id);
    if (!current) return null;
    const next: Room = {
      ...current,
      title: patch.title?.trim() || current.title,
      workdir: patch.workdir === undefined ? current.workdir : patch.workdir?.trim() || null,
      defaultWorker: patch.defaultWorker ?? current.defaultWorker,
      autoRun: patch.autoRun ?? current.autoRun,
      permission: patch.permission ?? current.permission,
      timeoutMs: patch.timeoutMs ?? current.timeoutMs,
      budgetUsd: patch.budgetUsd ?? current.budgetUsd,
    };
    this.db
      .prepare(
        `UPDATE rooms SET title = ?, workdir = ?, default_worker = ?, auto_run = ?,
         permission = ?, timeout_ms = ?, budget_usd = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.workdir,
        next.defaultWorker,
        next.autoRun ? 1 : 0,
        next.permission,
        next.timeoutMs,
        next.budgetUsd,
        id,
      );
    return next;
  }

  updateBrief(id: string, revision: number, brief: string): BriefResult {
    const current = this.getRoom(id);
    if (!current) return null;
    if (current.briefRevision !== revision) return { ok: false, room: current };
    const result = this.db
      .prepare("UPDATE rooms SET brief = ?, brief_revision = brief_revision + 1 WHERE id = ? AND brief_revision = ?")
      .run(brief, id, revision);
    if (result.changes !== 1) {
      const latest = this.getRoom(id);
      return latest ? { ok: false, room: latest } : null;
    }
    const room = this.getRoom(id);
    return room ? { ok: true, room } : null;
  }

  join(roomId: string, name: string, client: string): { member: Member; snapshot: Snapshot } | null {
    if (!this.getRoom(roomId)) return null;
    const trimmed = name.trim();
    const existing = this.db
      .prepare("SELECT * FROM members WHERE room_id = ? AND name = ?")
      .get(roomId, trimmed) as MemberRow | undefined;
    let member: Member;
    if (existing) {
      this.db
        .prepare("UPDATE members SET last_seen = ?, client = ? WHERE id = ?")
        .run(this.clock(), client, existing.id);
      member = memberFrom(
        this.db.prepare("SELECT * FROM members WHERE id = ?").get(existing.id) as unknown as MemberRow,
      );
    } else {
      member = {
        id: nid(),
        roomId,
        name: trimmed,
        client,
        lastSeen: this.clock(),
      };
      this.db
        .prepare("INSERT INTO members (id, room_id, name, client, last_seen) VALUES (?, ?, ?, ?, ?)")
        .run(member.id, member.roomId, member.name, member.client, member.lastSeen);
    }
    const snapshot = this.snapshot(roomId, INBOX_LIMIT, null);
    if (!snapshot) return null;
    return { member, snapshot };
  }

  listMembers(roomId: string): Member[] {
    const rows = this.db
      .prepare("SELECT * FROM members WHERE room_id = ? ORDER BY name ASC")
      .all(roomId) as unknown as MemberRow[];
    return rows.map(memberFrom);
  }

  postMessage(roomId: string, authorName: string, body: string, kind: MessageKind): PostResult {
    if (!this.getRoom(roomId)) return { error: "not_found" };
    if (body.length > MESSAGE_CAP) return { error: "too_long" };
    if (body.trim().length === 0) return { error: "empty" };
    const message = this.insertMessage(roomId, authorName.trim() || "room", body, kind);
    return { message };
  }

  load(roomId: string, limit = 50): Snapshot | null {
    return this.snapshot(roomId, limit, null);
  }

  inbox(roomId: string, memberName: string, opts?: { afterId?: string; limit?: number }): Snapshot | null {
    if (!this.getRoom(roomId)) return null;
    this.db
      .prepare("UPDATE members SET last_seen = ? WHERE room_id = ? AND name = ?")
      .run(this.clock(), roomId, memberName);
    let afterSeq: number | null = null;
    if (opts?.afterId) {
      const row = this.db.prepare("SELECT seq FROM messages WHERE id = ? AND room_id = ?").get(opts.afterId, roomId) as
        | { seq: number }
        | undefined;
      if (row) afterSeq = row.seq;
    }
    return this.snapshot(roomId, opts?.limit ?? INBOX_LIMIT, afterSeq);
  }

  createTask(input: {
    roomId: string;
    title: string;
    details: string;
    worker: WorkerKind;
    depth: number;
  }): Task {
    const seqRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tasks WHERE room_id = ?").get(input.roomId) as {
      n: number;
    };
    const task: Task = {
      id: nid(),
      roomId: input.roomId,
      title: input.title,
      details: input.details,
      status: "queued",
      worker: input.worker,
      depth: input.depth,
      log: "",
      worktree: null,
      createdAt: this.clock(),
      seq: seqRow.n,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, room_id, title, details, status, worker, depth, log, worktree, created_at, seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.roomId,
        task.title,
        task.details,
        task.status,
        task.worker,
        task.depth,
        task.log,
        task.worktree,
        task.createdAt,
        task.seq,
      );
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? taskFrom(row) : null;
  }

  listTasks(roomId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE room_id = ? ORDER BY seq ASC")
      .all(roomId) as unknown as TaskRow[];
    return rows.map(taskFrom);
  }

  markRunning(id: string, worktree: string | null): Task | null {
    const result = this.db
      .prepare("UPDATE tasks SET status = 'running', worktree = ? WHERE id = ? AND status = 'queued'")
      .run(worktree, id);
    if (result.changes !== 1) return null;
    return this.getTask(id);
  }

  markDone(id: string): Task | null {
    this.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND status = 'running'").run(id);
    return this.getTask(id);
  }

  markBlocked(id: string): Task | null {
    this.db
      .prepare("UPDATE tasks SET status = 'blocked' WHERE id = ? AND status IN ('queued', 'running')")
      .run(id);
    return this.getTask(id);
  }

  appendLog(id: string, chunk: string): void {
    const task = this.getTask(id);
    if (!task) return;
    const log = (task.log + chunk).slice(-LOG_CAP);
    this.db.prepare("UPDATE tasks SET log = ? WHERE id = ?").run(log, id);
  }

  runningCount(roomId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE room_id = ? AND status = 'running'")
      .get(roomId) as { n: number };
    return row.n;
  }

  nextQueued(roomId: string): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE room_id = ? AND status = 'queued' AND depth < 2 ORDER BY seq ASC LIMIT 1",
      )
      .get(roomId) as TaskRow | undefined;
    return row ? taskFrom(row) : null;
  }

  recordSpawn(roomId: string, taskId: string): void {
    this.db
      .prepare("INSERT INTO spawns (room_id, task_id, started_at) VALUES (?, ?, ?)")
      .run(roomId, taskId, this.clock());
  }

  countSpawnsSince(roomId: string, since: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM spawns WHERE room_id = ? AND started_at >= ?")
      .get(roomId, since) as { n: number };
    return row.n;
  }

  private insertMessage(roomId: string, authorName: string, body: string, kind: MessageKind): Message {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE room_id = ?")
      .get(roomId) as { n: number };
    const message: Message = {
      id: nid(),
      roomId,
      authorName,
      body,
      kind,
      createdAt: this.clock(),
      seq: seqRow.n,
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, room_id, author_name, body, kind, created_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.roomId, message.authorName, message.body, message.kind, message.createdAt, message.seq);
    return message;
  }

  private snapshot(roomId: string, limit: number, afterSeq: number | null): Snapshot | null {
    const room = this.getRoom(roomId);
    if (!room) return null;
    const messages =
      afterSeq == null
        ? (
            this.db
              .prepare(
                `SELECT * FROM (
                   SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?
                 ) ORDER BY seq ASC`,
              )
              .all(roomId, limit) as unknown as MessageRow[]
          ).map(messageFrom)
        : (
            this.db
              .prepare(
                "SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
              )
              .all(roomId, afterSeq, limit) as unknown as MessageRow[]
          ).map(messageFrom);
    return {
      room,
      members: this.listMembers(roomId),
      messages,
      tasks: this.listTasks(roomId),
    };
  }
}
