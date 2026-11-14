import type { Message, Room, Task } from "./store.ts";

export type GateEvent =
  | { type: "message"; roomId: string; message: Message }
  | { type: "task"; roomId: string; task: Task }
  | { type: "room"; roomId: string; room: Room }
  | { type: "log"; roomId: string; taskId: string; chunk: string };
