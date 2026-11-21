#!/usr/bin/env node
// Daily Planner MCP server: lets Claude add / list / complete to-dos and schedule items
// in the same Firestore data the website uses (users/{uid}/todos|events|days).
//
// Env:
//   PLANNER_SERVICE_ACCOUNT  path to the Firebase service-account JSON (keep it private!)
//   PLANNER_UID              Firebase Auth uid of the planner owner
//   TZ                       optional, e.g. America/New_York (defaults to the system zone)
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";

const { PLANNER_SERVICE_ACCOUNT, PLANNER_UID } = process.env;
if (!PLANNER_SERVICE_ACCOUNT || !PLANNER_UID) {
  console.error("Set PLANNER_SERVICE_ACCOUNT and PLANNER_UID");
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(readFileSync(PLANNER_SERVICE_ACCOUNT, "utf8"))) });
const db = getFirestore();
const userRef = db.collection("users").doc(PLANNER_UID);
const todos = userRef.collection("todos");
const events = userRef.collection("events");

/* ---------- helpers (same formats as the website) ---------- */
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nowLocal = () => { const d = new Date(); return `${ymd(d)}T${hm(d)}`; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const PRIO = { high: 2, normal: 1, low: 0 };
const PRIO_NAME = ["low", "normal", "high"];
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

function normDue(due) {
  // accepts "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (local time)
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(due.trim());
  if (!m) throw new Error(`Bad due date "${due}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time).`);
  return `${m[1]}T${m[2] || "23:59"}`;
}

function occursOn(ev, day) {
  if ((ev.skip || []).includes(day)) return false;
  if (!ev.repeat || ev.repeat === "once") return ev.date === day;
  if (day < ev.date) return false;
  const dow = parseYmd(day).getDay();
  if (ev.repeat === "daily") return true;
  if (ev.repeat === "weekdays") return dow >= 1 && dow <= 5;
  if (ev.repeat === "weekly") return dow === parseYmd(ev.date).getDay();
  return false;
}

const fmtTodo = (t) =>
  `- [${t.done ? "x" : " "}] ${t.title}  (due ${t.due.replace("T", " ")}, ${PRIO_NAME[t.prio] ?? "normal"}${t.tag ? `, #${t.tag}` : ""}${!t.done && new Date(t.due) < new Date() ? ", OVERDUE" : ""})  id=${t.id}`;
const text = (s) => ({ content: [{ type: "text", text: s }] });
const header = () => { const d = new Date(); return `Now: ${nowLocal().replace("T", " ")} ${WEEK[d.getDay()]} (${Intl.DateTimeFormat().resolvedOptions().timeZone})\n`; };

async function findTodo(ref) {
  const byId = await todos.doc(ref).get();
  if (byId.exists) return { id: byId.id, ...byId.data() };
  const all = (await todos.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const q = ref.toLowerCase();
  const hits = all.filter((t) => t.title.toLowerCase().includes(q));
  const open = hits.filter((t) => !t.done);
  const pick = open.length ? open : hits;
  if (pick.length === 1) return pick[0];
  if (!pick.length) throw new Error(`No to-do matches "${ref}".`);
  throw new Error(`"${ref}" matches several to-dos, use the id:\n${pick.map(fmtTodo).join("\n")}`);
}

async function writeTodo(t) {
  // the website keeps `id` inside each document too
  const data = { ...t, dueAt: Timestamp.fromDate(new Date(t.due)), updatedAt: FieldValue.serverTimestamp() };
  await todos.doc(t.id).set(data);
}

/* ---------- server ---------- */
const server = new McpServer({ name: "daily-planner", version: "1.0.0" });

server.tool(
  "add_todo",
  "Add a to-do to Jiayi's Daily Planner. Every to-do needs a deadline. Dates/times are the user's local time; resolve words like 'Friday' or 'tomorrow night' against the 'Now' shown by list tools (call list_todos first if unsure of today's date). If no time is given, 23:59 is used.",
  {
    title: z.string().min(1).describe("What needs to be done"),
    due: z.string().describe("Deadline, local time: YYYY-MM-DD or YYYY-MM-DDTHH:MM"),
    priority: z.enum(["high", "normal", "low"]).default("normal"),
    tag: z.string().optional().describe("Optional short tag, e.g. a course code"),
  },
  async ({ title, due, priority, tag }) => {
    const t = { id: uid(), title: title.trim(), due: normDue(due), prio: PRIO[priority], tag: tag?.trim() || "", done: false, doneAt: null, createdAt: new Date().toISOString() };
    await writeTodo(t);
    return text(`Added:\n${fmtTodo(t)}`);
  }
);

server.tool(
  "list_todos",
  "List to-dos from the Daily Planner, sorted by deadline. Also shows the current local date/time.",
  {
    status: z.enum(["open", "done", "all"]).default("open"),
    due_on_or_before: z.string().optional().describe("Only to-dos due on/before this local date (YYYY-MM-DD)"),
    due_on_or_after: z.string().optional().describe("Only to-dos due on/after this local date (YYYY-MM-DD)"),
  },
  async ({ status, due_on_or_before, due_on_or_after }) => {
    let list = (await todos.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    if (status !== "all") list = list.filter((t) => !!t.done === (status === "done"));
    if (due_on_or_before) list = list.filter((t) => t.due.slice(0, 10) <= due_on_or_before);
    if (due_on_or_after) list = list.filter((t) => t.due.slice(0, 10) >= due_on_or_after);
    list.sort((a, b) => a.due.localeCompare(b.due));
    return text(header() + (list.length ? list.map(fmtTodo).join("\n") : "(no matching to-dos)"));
  }
);

server.tool(
  "complete_todo",
  "Mark a to-do as done (or not done). `todo` is the id from list_todos, or part of its title.",
  { todo: z.string(), done: z.boolean().default(true) },
  async ({ todo, done }) => {
    const t = await findTodo(todo);
    t.done = done;
    t.doneAt = done ? nowLocal() : null;
    await writeTodo(t);
    return text(`${done ? "Completed" : "Reopened"}:\n${fmtTodo(t)}`);
  }
);

server.tool(
  "update_todo",
  "Change a to-do's title, deadline, priority or tag. `todo` is the id or part of the title.",
  {
    todo: z.string(),
    title: z.string().optional(),
    due: z.string().optional().describe("YYYY-MM-DD or YYYY-MM-DDTHH:MM, local time"),
    priority: z.enum(["high", "normal", "low"]).optional(),
    tag: z.string().optional(),
  },
  async ({ todo, title, due, priority, tag }) => {
    const t = await findTodo(todo);
    if (title) t.title = title.trim();
    if (due) t.due = normDue(due);
    if (priority) t.prio = PRIO[priority];
    if (tag !== undefined) t.tag = tag.trim();
    await writeTodo(t);
    return text(`Updated:\n${fmtTodo(t)}`);
  }
);

server.tool(
  "delete_todo",
  "Permanently delete a to-do. Only use when the user clearly asks to delete/remove it (prefer complete_todo for finished tasks).",
  { todo: z.string().describe("id or part of the title") },
  async ({ todo }) => {
    const t = await findTodo(todo);
    await todos.doc(t.id).delete();
    return text(`Deleted: ${t.title}`);
  }
);

server.tool(
  "add_schedule_item",
  "Add a time block to the planner's daily schedule (classes, meetings, routines). Times are local HH:MM.",
  {
    title: z.string().min(1),
    date: z.string().describe("YYYY-MM-DD; for repeating items this is the first day"),
    start: z.string().describe("HH:MM"),
    end: z.string().optional().describe("HH:MM"),
    note: z.string().optional().describe("Place or note"),
    repeat: z.enum(["once", "daily", "weekdays", "weekly"]).default("once"),
  },
  async ({ title, date, start, end, note, repeat }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || (end && !/^\d{2}:\d{2}$/.test(end))) {
      throw new Error("Use date YYYY-MM-DD and times HH:MM.");
    }
    const id = uid();
    const ev = { id, title: title.trim(), date, start, end: end || "", note: note?.trim() || "", color: "#5b86b0", repeat, skip: [], doneOn: [] };
    await events.doc(id).set({ ...ev, updatedAt: FieldValue.serverTimestamp() });
    return text(`Added to schedule: ${date} ${start}${end ? "–" + end : ""} ${ev.title}${repeat !== "once" ? ` (repeats ${repeat})` : ""}  id=${id}`);
  }
);

server.tool(
  "list_schedule",
  "Show the schedule for one day (including repeating items) plus the to-dos due that day.",
  { date: z.string().optional().describe("YYYY-MM-DD, default today") },
  async ({ date }) => {
    const day = date || ymd(new Date());
    const evs = (await events.get()).docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((e) => occursOn(e, day)).sort((a, b) => toMin(a.start) - toMin(b.start));
    const due = (await todos.get()).docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => t.due.slice(0, 10) === day).sort((a, b) => a.due.localeCompare(b.due));
    const lines = [header(), `Schedule for ${day} ${WEEK[parseYmd(day).getDay()]}:`];
    lines.push(...(evs.length ? evs.map((e) => `- [${(e.doneOn || []).includes(day) ? "x" : " "}] ${e.start}${e.end ? "–" + e.end : ""} ${e.title}${e.note ? ` (${e.note})` : ""}${e.repeat && e.repeat !== "once" ? ` ↻${e.repeat}` : ""}  id=${e.id}`) : ["(nothing scheduled)"]));
    lines.push("", "To-dos due this day:", ...(due.length ? due.map(fmtTodo) : ["(none)"]));
    return text(lines.join("\n"));
  }
);

server.tool(
  "delete_schedule_item",
  "Remove a schedule item. For repeating items, `only_date` removes just that one day.",
  { id: z.string(), only_date: z.string().optional().describe("YYYY-MM-DD") },
  async ({ id, only_date }) => {
    const ref = events.doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new Error(`No schedule item with id ${id}.`);
    if (only_date) await ref.update({ skip: FieldValue.arrayUnion(only_date), updatedAt: FieldValue.serverTimestamp() });
    else await ref.delete();
    return text(only_date ? `Removed ${snap.data().title} on ${only_date}.` : `Deleted ${snap.data().title}.`);
  }
);

await server.connect(new StdioServerTransport());
