import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GateEvent } from "./events.ts";
import type { Gate, SettingsInput } from "./gate.ts";
import { handleMcp } from "./mcp.ts";
import type { PermissionLevel, WorkerKind } from "./store.ts";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");

export interface HttpOptions {
  clis?: { claude: boolean; cursor: boolean };
}

export function createHttpServer(gate: Gate, opts: HttpOptions = {}): Server {
  const clis = opts.clis ?? { claude: false, cursor: false };
  return createServer((req, res) => {
    void handle(req, res, gate, clis).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : "error";
      send(res, message === "too_large" ? 413 : message === "bad_json" ? 400 : 500, {
        error: message === "bad_json" ? "bad_json" : message === "too_large" ? "too_large" : "server",
      });
    });
  });
}

export function listenLocal(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  gate: Gate,
  clis: { claude: boolean; cursor: boolean },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/meta") {
    send(res, 200, clis);
    return;
  }
  if (url.pathname === "/mcp") {
    const body = req.method === "POST" ? await readJson(req) : undefined;
    await handleMcp(req, res, gate, body);
    return;
  }
  if (req.method === "GET" && url.pathname === "/rooms") {
    send(res, 200, { rooms: gate.listRooms() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/rooms") {
    const body = (await readJson(req)) as {
      title?: string;
      workdir?: string | null;
      defaultWorker?: WorkerKind;
      autoRun?: boolean;
    };
    const created = gate.createRoom(body);
    if ("error" in created) {
      send(res, 400, { error: created.error });
      return;
    }
    send(res, 201, created.room);
    return;
  }

  if (parts[0] === "rooms" && parts[1]) {
    const roomId = parts[1];
    if (req.method === "GET" && parts.length === 2) {
      const snapshot = gate.load(roomId);
      if (!snapshot) {
        send(res, 404, { error: "not_found" });
        return;
      }
      send(res, 200, snapshot);
      return;
    }
    if (req.method === "GET" && parts[2] === "events" && parts.length === 3) {
      stream(req, res, gate, roomId);
      return;
    }
    if (req.method === "PUT" && parts[2] === "settings" && parts.length === 3) {
      const body = (await readJson(req)) as SettingsInput;
      const updated = gate.updateSettings(roomId, body);
      if (!updated) {
        send(res, 404, { error: "not_found" });
        return;
      }
      if ("error" in updated) {
        send(res, updated.error === "not_found" ? 404 : 400, updated);
        return;
      }
      send(res, 200, updated.room);
      return;
    }
    if (req.method === "PUT" && parts[2] === "brief" && parts.length === 3) {
      const body = (await readJson(req)) as { revision?: number; brief?: string };
      if (typeof body.revision !== "number" || typeof body.brief !== "string") {
        send(res, 400, { error: "bad_brief" });
        return;
      }
      const result = gate.updateBrief(roomId, body.revision, body.brief);
      if (!result) {
        send(res, 404, { error: "not_found" });
        return;
      }
      if (!result.ok) {
        send(res, 409, { error: "revision_conflict", room: result.room });
        return;
      }
      send(res, 200, result.room);
      return;
    }
    if (req.method === "POST" && parts[2] === "join" && parts.length === 3) {
      const body = (await readJson(req)) as { name?: string; client?: string };
      if (!body.name?.trim()) {
        send(res, 400, { error: "empty" });
        return;
      }
      const joined = gate.join(roomId, body.name, body.client?.trim() || "browser");
      if (!joined) {
        send(res, 404, { error: "not_found" });
        return;
      }
      send(res, 200, joined);
      return;
    }
    if (req.method === "GET" && parts[2] === "inbox" && parts.length === 3) {
      const snapshot = gate.inbox(roomId, url.searchParams.get("member") ?? "", {
        afterId: url.searchParams.get("after") ?? undefined,
      });
      if (!snapshot) {
        send(res, 404, { error: "not_found" });
        return;
      }
      send(res, 200, snapshot);
      return;
    }
    if (req.method === "POST" && parts[2] === "messages" && parts.length === 3) {
      const body = (await readJson(req)) as { author?: string; body?: string };
      const result = gate.postMessage(roomId, body.author?.trim() || "you", body.body ?? "");
      if (result.error === "not_found") {
        send(res, 404, result);
        return;
      }
      if (result.error) {
        send(res, 400, result);
        return;
      }
      send(res, 201, result.message);
      return;
    }
    if (req.method === "POST" && parts[2] === "tasks" && parts.length === 3) {
      const body = (await readJson(req)) as { title?: string; details?: string; worker?: WorkerKind };
      const result = gate.addTask(roomId, body);
      if ("error" in result) {
        send(res, result.error === "not_found" ? 404 : 400, result);
        return;
      }
      send(res, 201, result.task);
      return;
    }
    if (req.method === "POST" && parts[2] === "tasks" && parts[4] === "release" && parts.length === 5) {
      const task = gate.store.getTask(parts[3] ?? "");
      if (!task || task.roomId !== roomId) {
        send(res, 404, { error: "not_found" });
        return;
      }
      const released = gate.release(task.id);
      send(res, 200, released);
      return;
    }
  }

  if (req.method === "GET" && (url.pathname === "/" || (parts[0] === "r" && parts.length === 2))) {
    return file(res, path.join(webRoot, "index.html"), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/app.css") {
    return file(res, path.join(webRoot, "app.css"), "text/css; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/app.js") {
    return file(res, path.join(webRoot, "app.js"), "text/javascript; charset=utf-8");
  }
  send(res, 404, { error: "not_found" });
}

function stream(req: IncomingMessage, res: ServerResponse, gate: Gate, roomId: string): void {
  if (!gate.store.getRoom(roomId)) {
    send(res, 404, { error: "not_found" });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": open\n\n");
  const sendEvent = (event: GateEvent) => {
    if (event.roomId !== roomId) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = gate.subscribe(sendEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  ping.unref();
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}

function file(res: ServerResponse, filePath: string, type: string): void {
  if (!existsSync(filePath)) {
    send(res, 404, { error: "not_found" });
    return;
  }
  res.writeHead(200, { "content-type": type });
  createReadStream(filePath).pipe(res);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error("too_large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("bad_json");
  }
}
