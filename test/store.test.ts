import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";

const root = path.join(import.meta.dirname, "..", ".tmp");

function withStore(fn: (store: Store, setNow: (n: number) => void) => void): () => void {
  return () => {
    mkdirSync(root, { recursive: true });
    let now = 1_000_000;
    const dir = mkdtempSync(path.join(root, "store-"));
    const store = new Store(path.join(dir, "gate.db"), () => now);
    try {
      fn(store, (n) => {
        now = n;
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "createRoom keeps workdir, worker, and a starting brief",
  withStore((store) => {
    const room = store.createRoom({
      title: "Parser",
      workdir: "/tmp/parser",
      defaultWorker: "claude",
      autoRun: true,
    });
    const loaded = store.getRoom(room.id);
    assert.ok(loaded);
    assert.equal(loaded.title, "Parser");
    assert.equal(loaded.workdir, "/tmp/parser");
    assert.equal(loaded.defaultWorker, "claude");
    assert.equal(loaded.autoRun, true);
    assert.equal(loaded.permission, "default");
    assert.equal(loaded.timeoutMs, 15 * 60 * 1000);
    assert.equal(loaded.budgetUsd, 2);
    assert.equal(loaded.briefRevision, 1);
    assert.match(loaded.brief, /Goal/);
    assert.equal(store.getRoom("missing"), null);
  }),
);

test(
  "updateBrief conflicts when the revision is stale",
  withStore((store) => {
    const room = store.createRoom({ title: "Brief" });
    const stale = store.updateBrief(room.id, 0, "nope");
    assert.equal(stale?.ok, false);
    if (stale && !stale.ok) assert.equal(stale.room.briefRevision, 1);

    const saved = store.updateBrief(room.id, 1, "Ship the parser.");
    assert.equal(saved?.ok, true);
    if (saved?.ok) {
      assert.equal(saved.room.brief, "Ship the parser.");
      assert.equal(saved.room.briefRevision, 2);
    }
    assert.equal(store.updateBrief("missing", 1, "x"), null);
  }),
);

test(
  "joining the same name updates that member",
  withStore((store, setNow) => {
    const room = store.createRoom({ title: "Members" });
    setNow(5_000);
    const first = store.join(room.id, "cursor-api", "cursor");
    assert.ok(first);
    setNow(9_000);
    const second = store.join(room.id, "cursor-api", "cursor");
    assert.ok(second);
    assert.equal(second.member.id, first.member.id);
    assert.equal(second.member.lastSeen, 9_000);
    assert.equal(store.listMembers(room.id).length, 1);
    assert.equal(store.join("missing", "a", "cursor"), null);
  }),
);

test(
  "messages keep order and reject an oversized body",
  withStore((store, setNow) => {
    const room = store.createRoom({ title: "Thread" });
    const ok = store.postMessage(room.id, "you", "a".repeat(8000), "say");
    assert.ok(ok.message);
    const tooLong = store.postMessage(room.id, "you", "b".repeat(8001), "say");
    assert.equal(tooLong.error, "too_long");
    const empty = store.postMessage(room.id, "you", "   ", "say");
    assert.equal(empty.error, "empty");
    assert.equal(store.postMessage("missing", "you", "hi", "say").error, "not_found");

    setNow(20_000);
    store.postMessage(room.id, "claude", "second", "say");
    const inbox = store.inbox(room.id, "you");
    assert.ok(inbox);
    assert.deepEqual(
      inbox.messages.map((message) => message.body),
      ["a".repeat(8000), "second"],
    );
  }),
);

test(
  "inbox returns the latest 30 messages and those after a cursor",
  withStore((store, setNow) => {
    const room = store.createRoom({ title: "Pages" });
    store.join(room.id, "you", "browser");
    const ids: string[] = [];
    for (let i = 0; i < 35; i += 1) {
      setNow(30_000 + i);
      const posted = store.postMessage(room.id, "you", `m${i}`, "say");
      assert.ok(posted.message);
      ids.push(posted.message.id);
    }
    setNow(40_000);
    const latest = store.inbox(room.id, "you");
    assert.ok(latest);
    assert.equal(latest.messages.length, 30);
    assert.equal(latest.messages[0]?.body, "m5");
    assert.equal(latest.messages.at(-1)?.body, "m34");
    assert.equal(store.listMembers(room.id)[0]?.lastSeen, 40_000);

    const after = store.inbox(room.id, "you", { afterId: ids[10]! });
    assert.ok(after);
    assert.equal(after.messages[0]?.body, "m11");
    assert.equal(after.messages.at(-1)?.body, "m34");
  }),
);

test(
  "a second start of a task loses to the first claim",
  withStore((store) => {
    const room = store.createRoom({ title: "Tasks", defaultWorker: "cursor" });
    const task = store.createTask({
      roomId: room.id,
      title: "Write the parser",
      details: "Cover strings.",
      worker: "cursor",
      depth: 0,
    });
    assert.equal(task.status, "queued");
    assert.equal(task.depth, 0);

    const claimed = store.markRunning(task.id, "/work/parser");
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.worktree, "/work/parser");
    assert.equal(store.markRunning(task.id, "/other"), null);
    assert.equal(store.runningCount(room.id), 1);

    const done = store.markDone(task.id);
    assert.equal(done?.status, "done");
    assert.equal(store.runningCount(room.id), 0);
  }),
);

test(
  "the task log keeps the tail and the queue skips deep work",
  withStore((store) => {
    const room = store.createRoom({ title: "Queue" });
    const shallow = store.createTask({
      roomId: room.id,
      title: "first",
      details: "",
      worker: "claude",
      depth: 0,
    });
    store.createTask({
      roomId: room.id,
      title: "too deep",
      details: "",
      worker: "claude",
      depth: 2,
    });
    const next = store.createTask({
      roomId: room.id,
      title: "second",
      details: "",
      worker: "cursor",
      depth: 1,
    });

    assert.equal(store.nextQueued(room.id)?.id, shallow.id);
    store.markRunning(shallow.id, null);
    assert.equal(store.nextQueued(room.id)?.id, next.id);

    const chunk = "x".repeat(50_000);
    store.appendLog(shallow.id, chunk);
    store.appendLog(shallow.id, chunk);
    const logged = store.getTask(shallow.id);
    assert.ok(logged);
    assert.ok(logged.log.length <= 64 * 1024);
    assert.ok(logged.log.endsWith("x"));
  }),
);

test(
  "spawn counts only include the current hour",
  withStore((store, setNow) => {
    const room = store.createRoom({ title: "Caps" });
    setNow(10_000_000);
    for (let i = 0; i < 10; i += 1) store.recordSpawn(room.id, `t${i}`);
    assert.equal(store.countSpawnsSince(room.id, 10_000_000 - 60 * 60 * 1000), 10);
    setNow(10_000_000 + 2 * 60 * 60 * 1000);
    assert.equal(store.countSpawnsSince(room.id, store.now() - 60 * 60 * 1000), 0);
  }),
);

test(
  "settings update the room and reject an unknown room",
  withStore((store) => {
    const room = store.createRoom({ title: "Settings", workdir: "/repo" });
    const updated = store.updateSettings(room.id, {
      workdir: "/repo/app",
      defaultWorker: "cursor",
      autoRun: false,
      permission: "open",
      timeoutMs: 5_000,
      budgetUsd: 1,
    });
    assert.equal(updated?.defaultWorker, "cursor");
    assert.equal(updated?.autoRun, false);
    assert.equal(updated?.permission, "open");
    assert.equal(updated?.timeoutMs, 5_000);
    assert.equal(updated?.budgetUsd, 1);
    assert.equal(updated?.workdir, "/repo/app");
    assert.equal(store.updateSettings("missing", { autoRun: true }), null);
  }),
);
