const app = document.querySelector("#app");
const nameKey = "comms-gate-name";

const state = {
  name: localStorage.getItem(nameKey) || "you",
  meta: { claude: false, cursor: false },
  snapshot: null,
  connected: false,
  status: "",
  source: null,
};

const roomMatch = location.pathname.match(/^\/r\/([^/]+)$/);
const roomId = roomMatch ? decodeURIComponent(roomMatch[1]) : "";

boot().catch((error) => {
  app.replaceChildren(p(error instanceof Error ? error.message : "Could not load the room."));
});

async function boot() {
  state.meta = await getJSON("/meta");
  if (!roomId) {
    renderHome(await getJSON("/rooms"));
    return;
  }
  renderRoom();
  const snapshot = await getJSON(`/rooms/${roomId}`);
  if (snapshot.error) {
    state.status = "This room does not exist.";
    paint();
    return;
  }
  state.snapshot = snapshot;
  document.title = snapshot.room.title;
  paint();
  await join();
  listen();
}

function renderHome(payload) {
  const form = document.createElement("form");
  form.className = "card stack";
  form.innerHTML = "";
  const title = field("Room name", "text", "Parser work");
  const workdir = field("Working directory", "text", "/absolute/path/to/repo");
  const worker = selectField("Default worker", [
    ["claude", "Claude Code"],
    ["cursor", "Cursor"],
  ]);
  const auto = checkbox("Start a worker when a task is added", true);
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Create room";
  form.append(title.label, workdir.label, worker.label, auto.label, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    const result = await postJSON("/rooms", {
      title: title.input.value,
      workdir: workdir.input.value,
      defaultWorker: worker.input.value,
      autoRun: auto.input.checked,
    });
    button.disabled = false;
    if (result.error === "workdir") {
      state.status = "That working directory is not a folder on this Mac.";
      statusNode.textContent = state.status;
      return;
    }
    if (result.error) {
      state.status = "Could not create the room.";
      statusNode.textContent = state.status;
      return;
    }
    location.href = `/r/${result.id}`;
  });

  const list = document.createElement("div");
  list.className = "card stack";
  const heading = document.createElement("h2");
  heading.textContent = "Rooms on this Mac";
  list.append(heading);
  const rooms = payload.rooms ?? [];
  if (rooms.length === 0) {
    list.append(p("None yet.", "empty"));
  } else {
    for (const room of rooms) {
      const link = document.createElement("a");
      link.href = `/r/${room.id}`;
      link.textContent = room.title;
      list.append(link);
    }
  }

  const statusNode = p("", "status");
  const page = document.createElement("main");
  page.className = "page stack";
  const header = document.createElement("header");
  const h1 = document.createElement("h1");
  h1.textContent = "Comms gate";
  header.append(h1, p("A task starts a headless Claude or Cursor run. The room keeps the brief, the thread, and the handoff.", "lede"));
  page.append(header, cliNote(), statusNode, form, list);
  app.replaceChildren(page);
}

function renderRoom() {
  const page = document.createElement("main");
  page.className = "page";
  const header = document.createElement("header");
  header.className = "top";
  const titles = document.createElement("div");
  const home = document.createElement("a");
  home.href = "/";
  home.textContent = "All rooms";
  const h1 = document.createElement("h1");
  h1.id = "title";
  h1.textContent = "Room";
  titles.append(home, h1);
  const controls = document.createElement("div");
  controls.className = "row";
  const name = field("Your name", "text", "you");
  name.input.id = "member-name";
  name.input.value = state.name;
  name.input.addEventListener("change", () => {
    state.name = name.input.value.trim() || "you";
    localStorage.setItem(nameKey, state.name);
    join().then(paint);
  });
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "quiet";
  copy.textContent = "Copy join prompt";
  copy.addEventListener("click", copyPrompt);
  const dot = document.createElement("span");
  dot.id = "live";
  dot.className = "dot";
  dot.title = "Live updates";
  controls.append(name.label, copy, dot);
  header.append(titles, controls);

  const threadCard = document.createElement("section");
  threadCard.className = "card";
  const threadHead = document.createElement("h2");
  threadHead.textContent = "Thread";
  const messages = document.createElement("div");
  messages.id = "messages";
  messages.className = "thread";
  messages.setAttribute("aria-live", "polite");
  const composer = document.createElement("form");
  composer.className = "stack";
  const body = document.createElement("textarea");
  body.id = "composer";
  body.required = true;
  body.maxLength = 8000;
  body.placeholder = "Say something to the room";
  body.setAttribute("aria-label", "Message");
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Post";
  composer.append(body, send);
  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = body.value;
    body.value = "";
    const result = await postJSON(`/rooms/${roomId}/messages`, { author: state.name, body: text });
    if (result.error === "too_long") state.status = "That message is over 8,000 characters.";
    else if (result.error) state.status = "The message was not posted.";
    else state.status = "";
    paint();
  });
  threadCard.append(threadHead, messages, composer);

  const aside = document.createElement("aside");
  aside.className = "stack";
  aside.append(taskCard(), briefCard(), settingsCard());

  const layout = document.createElement("div");
  layout.className = "layout";
  layout.append(threadCard, aside);
  const status = p("", "status");
  status.id = "status";
  page.append(header, cliNote(), status, layout);
  app.replaceChildren(page);
  paint();
}

function taskCard() {
  const card = document.createElement("section");
  card.className = "card stack";
  const h2 = document.createElement("h2");
  h2.textContent = "Tasks";
  const list = document.createElement("div");
  list.id = "tasks";
  const form = document.createElement("form");
  form.className = "stack";
  const title = field("Task", "text", "Write the parser");
  title.input.required = true;
  const details = document.createElement("textarea");
  details.placeholder = "What the worker should do";
  details.setAttribute("aria-label", "Task details");
  const worker = selectField("Worker", [
    ["claude", "Claude Code"],
    ["cursor", "Cursor"],
  ]);
  worker.input.id = "task-worker";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Add task";
  form.append(title.label, details, worker.label, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await postJSON(`/rooms/${roomId}/tasks`, {
      title: title.input.value,
      details: details.value,
      worker: worker.input.value,
    });
    if (result.error) {
      state.status = "The task was not added.";
      paint();
      return;
    }
    title.input.value = "";
    details.value = "";
    state.status = "";
    paint();
  });
  card.append(h2, list, form);
  return card;
}

function briefCard() {
  const card = document.createElement("section");
  card.className = "card stack";
  const h2 = document.createElement("h2");
  h2.textContent = "Brief";
  const area = document.createElement("textarea");
  area.id = "brief";
  area.setAttribute("aria-label", "Shared brief");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Save brief";
  button.addEventListener("click", async () => {
    const room = state.snapshot?.room;
    if (!room) return;
    const result = await sendJSON("PUT", `/rooms/${roomId}/brief`, {
      revision: room.briefRevision,
      brief: area.value,
    });
    if (result.error === "revision_conflict") {
      state.snapshot.room = result.room;
      area.value = result.room.brief;
      state.status = "The brief changed. Loaded the saved version.";
    } else if (result.error) {
      state.status = "The brief was not saved.";
    } else {
      state.snapshot.room = result;
      state.status = "Brief saved.";
    }
    paint();
  });
  card.append(h2, area, button);
  return card;
}

function settingsCard() {
  const card = document.createElement("details");
  card.className = "card stack";
  const summary = document.createElement("summary");
  summary.textContent = "Room settings";
  const form = document.createElement("form");
  form.className = "stack";
  const workdir = field("Working directory", "text", "");
  workdir.input.id = "set-workdir";
  const worker = selectField("Default worker", [
    ["claude", "Claude Code"],
    ["cursor", "Cursor"],
  ]);
  worker.input.id = "set-worker";
  const permission = selectField("Permissions", [
    ["default", "Workspace edits only"],
    ["open", "Also run commands that would have asked"],
  ]);
  permission.input.id = "set-permission";
  const timeout = field("Timeout in minutes", "number", "15");
  timeout.input.id = "set-timeout";
  timeout.input.min = "1";
  const budget = field("Claude budget in USD", "number", "2");
  budget.input.id = "set-budget";
  budget.input.min = "0";
  budget.input.step = "0.5";
  const auto = checkbox("Auto-run tasks", false);
  auto.input.id = "set-autorun";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Save settings";
  form.append(workdir.label, worker.label, permission.label, timeout.label, budget.label, auto.label, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await sendJSON("PUT", `/rooms/${roomId}/settings`, {
      workdir: workdir.input.value,
      defaultWorker: worker.input.value,
      permission: permission.input.value,
      timeoutMs: Number(timeout.input.value) * 60 * 1000,
      budgetUsd: Number(budget.input.value),
      autoRun: auto.input.checked,
    });
    if (result.error === "workdir") state.status = "That working directory is not a folder on this Mac.";
    else if (result.error) state.status = "Settings were not saved.";
    else {
      state.snapshot.room = result;
      state.status = "Settings saved.";
    }
    paint();
  });
  card.append(summary, form);
  return card;
}

function paint() {
  const snapshot = state.snapshot;
  const status = document.querySelector("#status");
  if (status) status.textContent = state.status;
  const live = document.querySelector("#live");
  if (live) live.classList.toggle("on", state.connected);
  if (!snapshot) return;
  const title = document.querySelector("#title");
  if (title) title.textContent = snapshot.room.title;
  paintMessages(snapshot.messages);
  paintTasks(snapshot.tasks);
  const brief = document.querySelector("#brief");
  if (brief && document.activeElement !== brief) brief.value = snapshot.room.brief;
  fillSettings(snapshot.room);
  const worker = document.querySelector("#task-worker");
  if (worker && worker.dataset.ready !== "1") {
    worker.value = snapshot.room.defaultWorker;
    worker.dataset.ready = "1";
  }
}

function fillSettings(room) {
  const workdir = document.querySelector("#set-workdir");
  const worker = document.querySelector("#set-worker");
  const permission = document.querySelector("#set-permission");
  const timeout = document.querySelector("#set-timeout");
  const budget = document.querySelector("#set-budget");
  const auto = document.querySelector("#set-autorun");
  if (document.activeElement && document.activeElement.closest("details")) return;
  if (workdir) workdir.value = room.workdir ?? "";
  if (worker) worker.value = room.defaultWorker;
  if (permission) permission.value = room.permission;
  if (timeout) timeout.value = String(Math.round(room.timeoutMs / 60000));
  if (budget) budget.value = String(room.budgetUsd);
  if (auto) auto.checked = room.autoRun;
}

function paintMessages(messages) {
  const list = document.querySelector("#messages");
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  list.replaceChildren();
  if (messages.length === 0) {
    list.append(p("No messages yet.", "empty"));
    return;
  }
  for (const message of messages) {
    const item = document.createElement("article");
    item.className = `message ${message.kind}`;
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = `${message.authorName} · ${when(message.createdAt)}`;
    const body = document.createElement("p");
    body.className = "body";
    body.textContent = message.body;
    item.append(who, body);
    list.append(item);
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function paintTasks(tasks) {
  const list = document.querySelector("#tasks");
  if (!list) return;
  list.replaceChildren();
  if (tasks.length === 0) {
    list.append(p("No tasks yet.", "empty"));
    return;
  }
  for (const task of tasks) {
    const item = document.createElement("article");
    item.className = "task";
    const head = document.createElement("div");
    head.className = "row";
    const title = document.createElement("strong");
    title.className = "grow";
    title.textContent = task.title;
    const pill = document.createElement("span");
    pill.className = `pill ${task.status}`;
    pill.textContent = task.status;
    head.append(title, pill);
    const meta = document.createElement("div");
    meta.className = "who";
    meta.textContent = `${task.worker} · depth ${task.depth}`;
    item.append(head, meta);
    if (task.details) item.append(p(task.details));
    if (task.log) {
      const log = document.createElement("pre");
      log.className = "log";
      log.textContent = task.log;
      item.append(log);
    }
    if (task.status === "queued" || task.status === "running") {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "quiet";
      stop.textContent = task.status === "running" ? "Stop" : "Release";
      stop.addEventListener("click", async () => {
        await postJSON(`/rooms/${roomId}/tasks/${task.id}/release`, {});
        paint();
      });
      item.append(stop);
    }
    list.append(item);
  }
}

function listen() {
  state.source?.close();
  const source = new EventSource(`/rooms/${roomId}/events`);
  state.source = source;
  source.onopen = () => {
    state.connected = true;
    paint();
  };
  source.onerror = () => {
    state.connected = false;
    paint();
  };
  source.addEventListener("message", (event) => applyMessage(JSON.parse(event.data)));
  source.addEventListener("task", (event) => applyTask(JSON.parse(event.data)));
  source.addEventListener("room", (event) => {
    const data = JSON.parse(event.data);
    if (state.snapshot) state.snapshot.room = data.room;
    paint();
  });
  source.addEventListener("log", (event) => {
    const data = JSON.parse(event.data);
    const task = state.snapshot?.tasks.find((item) => item.id === data.taskId);
    if (!task) return;
    task.log = (task.log + data.chunk).slice(-65536);
    paint();
  });
}

function applyMessage(event) {
  if (!state.snapshot) return;
  if (state.snapshot.messages.some((message) => message.id === event.message.id)) return;
  state.snapshot.messages.push(event.message);
  paint();
}

function applyTask(event) {
  if (!state.snapshot) return;
  const index = state.snapshot.tasks.findIndex((task) => task.id === event.task.id);
  if (index === -1) state.snapshot.tasks.push(event.task);
  else state.snapshot.tasks[index] = { ...event.task, log: event.task.log || state.snapshot.tasks[index].log };
  paint();
}

async function join() {
  const result = await postJSON(`/rooms/${roomId}/join`, { name: state.name, client: "browser" });
  if (result.snapshot) state.snapshot = result.snapshot;
}

async function copyPrompt() {
  const prompt = [
    "Join the comms gate room.",
    `Base URL: ${location.origin}`,
    `Room: ${roomId}`,
    "Your name: choose a short name for this session.",
    "",
    "Use the comms-gate MCP tools.",
    "1. Call join, then inbox before you do anything else.",
    "2. At the start of each turn, call inbox.",
    "3. Post decisions and questions to the room. Create a task when you want a headless Claude or Cursor worker to do something.",
    "4. Update the brief when the goal, a decision, or a constraint changes.",
    "Do not paste your whole conversation. Post the outcome and the next action.",
  ].join("\n");
  try {
    await navigator.clipboard.writeText(prompt);
    state.status = "Join prompt copied.";
  } catch {
    state.status = prompt;
  }
  paint();
}

function cliNote() {
  const missing = [];
  if (!state.meta.claude) missing.push("claude");
  if (!state.meta.cursor) missing.push("agent");
  if (missing.length === 0) return p("claude and agent are on PATH.");
  return p(`Not on PATH, so that worker cannot start: ${missing.join(", ")}.`, "note");
}

function field(labelText, type, placeholder) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.placeholder = placeholder;
  label.append(input);
  return { label, input };
}

function selectField(labelText, options) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("select");
  for (const [value, text] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    input.append(option);
  }
  label.append(input);
  return { label, input };
}

function checkbox(text, checked) {
  const label = document.createElement("label");
  label.className = "check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  const span = document.createElement("span");
  span.textContent = text;
  label.append(input, span);
  return { label, input };
}

function p(text, className) {
  const node = document.createElement("p");
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function when(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function getJSON(url) {
  const response = await fetch(url);
  return response.json();
}

async function postJSON(url, body) {
  return sendJSON("POST", url, body);
}

async function sendJSON(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}
