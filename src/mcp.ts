import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Gate } from "./gate.ts";

function text(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

export function createMcpServer(gate: Gate): McpServer {
  const mcp = new McpServer({ name: "comms-gate", version: "0.1.0" });

  mcp.registerTool(
    "join",
    {
      description: "Join a room and receive the brief, the latest messages, and the tasks.",
      inputSchema: {
        roomId: z.string(),
        name: z.string(),
        client: z.string().optional(),
      },
    },
    async ({ roomId, name, client }) => {
      const joined = gate.join(roomId, name, client ?? "agent");
      if (!joined) return text({ error: "not_found" }, true);
      return text(joined);
    },
  );

  mcp.registerTool(
    "inbox",
    {
      description: "Read the brief, the latest messages, and the tasks. Pass after with a message id to read only newer messages.",
      inputSchema: {
        roomId: z.string(),
        memberName: z.string(),
        after: z.string().optional(),
      },
    },
    async ({ roomId, memberName, after }) => {
      const snapshot = gate.inbox(roomId, memberName, { afterId: after });
      if (!snapshot) return text({ error: "not_found" }, true);
      return text(snapshot);
    },
  );

  mcp.registerTool(
    "post",
    {
      description: "Post a message to the room thread. Keep it short. Do not paste a whole conversation.",
      inputSchema: {
        roomId: z.string(),
        memberName: z.string(),
        body: z.string(),
      },
    },
    async ({ roomId, memberName, body }) => {
      const result = gate.postMessage(roomId, memberName, body);
      if (result.error) return text(result, true);
      return text(result.message);
    },
  );

  mcp.registerTool(
    "update_brief",
    {
      description: "Replace the shared brief. Send the revision you last read. A conflict returns the current brief.",
      inputSchema: {
        roomId: z.string(),
        revision: z.number(),
        brief: z.string(),
      },
    },
    async ({ roomId, revision, brief }) => {
      const result = gate.updateBrief(roomId, revision, brief);
      if (!result) return text({ error: "not_found" }, true);
      if (!result.ok) return text({ error: "revision_conflict", room: result.room }, true);
      return text(result.room);
    },
  );

  mcp.registerTool(
    "create_task",
    {
      description: "Add a task. When auto-run is on, the room starts a headless Claude or Cursor worker for it.",
      inputSchema: {
        roomId: z.string(),
        title: z.string(),
        details: z.string().optional(),
        worker: z.enum(["claude", "cursor"]).optional(),
      },
    },
    async ({ roomId, title, details, worker }) => {
      const result = gate.addTask(roomId, { title, details, worker });
      if ("error" in result) return text(result, true);
      return text(result.task);
    },
  );

  mcp.registerTool(
    "release_task",
    {
      description: "Stop a queued or running task. A running worker is killed.",
      inputSchema: {
        roomId: z.string(),
        taskId: z.string(),
      },
    },
    async ({ taskId }) => {
      const task = gate.release(taskId);
      if (!task) return text({ error: "not_found" }, true);
      return text(task);
    },
  );

  return mcp;
}

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  gate: Gate,
  parsedBody?: unknown,
): Promise<void> {
  const mcp = createMcpServer(gate);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
}
