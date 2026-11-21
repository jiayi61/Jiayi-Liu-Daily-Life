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
const lists = userRef.collection("lists");
const listTypes = userRef.collection("listTypes");

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

// items in the website's trash carry deletedAt; everything else ignores them
const liveDocs = async (c) => (await c.get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => !x.deletedAt);

async function findTodo(ref) {
  const byId = await todos.doc(ref).get();
  if (byId.exists && !byId.data().deletedAt) return { id: byId.id, ...byId.data() };
  const all = await liveDocs(todos);
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
  const { updatedAt, dueAt, ...rest } = t; // never copy server-only fields back
  const data = { ...rest, dueAt: Timestamp.fromDate(new Date(t.due)), updatedAt: FieldValue.serverTimestamp() };
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
    let list = await liveDocs(todos);
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
  "Move a to-do to the planner's trash (the user can restore it on the website for 30 days). Only use when the user clearly asks to delete/remove it (prefer complete_todo for finished tasks).",
  { todo: z.string().describe("id or part of the title") },
  async ({ todo }) => {
    const t = await findTodo(todo);
    await todos.doc(t.id).update({ deletedAt: new Date().toISOString(), updatedAt: FieldValue.serverTimestamp() });
    return text(`Moved to trash: ${t.title} (can be restored from 🗑 垃圾箱 on the website)`);
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
    const evs = (await liveDocs(events))
      .filter((e) => occursOn(e, day)).sort((a, b) => toMin(a.start) - toMin(b.start));
    const due = (await liveDocs(todos))
      .filter((t) => t.due.slice(0, 10) === day).sort((a, b) => a.due.localeCompare(b.due));
    const lines = [header(), `Schedule for ${day} ${WEEK[parseYmd(day).getDay()]}:`];
    lines.push(...(evs.length ? evs.map((e) => `- [${(e.doneOn || []).includes(day) ? "x" : " "}] ${e.start}${e.end ? "–" + e.end : ""} ${e.title}${e.note ? ` (${e.note})` : ""}${e.repeat && e.repeat !== "once" ? ` ↻${e.repeat}` : ""}  id=${e.id}`) : ["(nothing scheduled)"]));
    lines.push("", "To-dos due this day:", ...(due.length ? due.map(fmtTodo) : ["(none)"]));
    return text(lines.join("\n"));
  }
);

server.tool(
  "delete_schedule_item",
  "Move a schedule item to the planner's trash (restorable on the website for 30 days). For repeating items, `only_date` removes just that one day.",
  { id: z.string(), only_date: z.string().optional().describe("YYYY-MM-DD") },
  async ({ id, only_date }) => {
    const ref = events.doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().deletedAt) throw new Error(`No schedule item with id ${id}.`);
    const at = new Date().toISOString();
    if (only_date) await ref.update({ skip: FieldValue.arrayUnion(only_date), [`skipDeleted.${only_date}`]: at, updatedAt: FieldValue.serverTimestamp() });
    else await ref.update({ deletedAt: at, updatedAt: FieldValue.serverTimestamp() });
    return text(`Moved to trash: ${snap.data().title}${only_date ? ` on ${only_date}` : ""} (restorable from 🗑 垃圾箱 on the website).`);
  }
);

/* ---------- side lists (movies, restaurants, gifts…) — same docs as the website's 📚 drawer ---------- */
const BUILTIN_LISTS = [
  { id: "movie", label: "电影", names: ["movie", "film", "电影", "影视", "电视剧", "剧"] },
  { id: "book", label: "书", names: ["book", "书", "书籍", "读书"] },
  { id: "restaurant", label: "餐厅", names: ["restaurant", "food", "餐厅", "美食", "饭店", "餐馆"] },
  { id: "gift", label: "礼物", names: ["gift", "礼物"] },
  { id: "city", label: "城市", names: ["city", "travel", "城市", "旅行"] },
];
async function allListKinds() {
  const custom = (await listTypes.get()).docs.map((d) => ({ id: d.id, label: d.data().label, names: [d.data().label] }));
  return [...BUILTIN_LISTS, ...custom];
}
async function resolveList(name, create) {
  const kinds = await allListKinds();
  const k = name.trim().toLowerCase();
  const hit = kinds.find((t) => t.id === k || t.names.some((n) => n.toLowerCase() === k));
  if (hit) return hit;
  if (!create) throw new Error(`No list called "${name}". Existing lists: ${kinds.map((t) => t.label).join(", ")}`);
  const id = uid();
  const label = name.trim();
  await listTypes.doc(id).set({ id, label, icon: "📌", updatedAt: FieldValue.serverTimestamp() });
  return { id, label, names: [label] };
}

server.tool(
  "add_list_item",
  "Add an entry to one of the planner's side lists: 电影 movie, 书 book, 餐厅 restaurant (with city), 礼物 gift (person = who it was for / from, occasion), 城市 city visited, or a custom list by its name. Use when the user mentions watching/reading/eating at/gifting/visiting something they'd want remembered. Call list_list_items first if unsure whether it is already there.",
  {
    list: z.string().describe("List name or id, e.g. 电影 / movie / 餐厅 / 礼物 / 城市 / a custom list name"),
    name: z.string().min(1).describe("Title: movie/book/restaurant/city name, or the gift itself"),
    date: z.string().optional().describe("YYYY-MM-DD local date it happened"),
    note: z.string().optional(),
    city: z.string().optional().describe("restaurants: city"),
    person: z.string().optional().describe("gifts: e.g. '送给小王' or '妈妈送的'"),
    occasion: z.string().optional().describe("gifts: e.g. 生日 / 圣诞"),
    create_list_if_missing: z.boolean().default(false).describe("Create a new custom list if `list` doesn't exist (only when the user asked for a new list)"),
  },
  async ({ list, name, date, note, city, person, occasion, create_list_if_missing }) => {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
    const kind = await resolveList(list, create_list_if_missing);
    const id = uid();
    const item = { id, type: kind.id, name: name.trim(), date: date || "", note: note?.trim() || "", createdAt: new Date().toISOString() };
    if (city) item.city = city.trim();
    if (person) item.person = person.trim();
    if (occasion) item.occasion = occasion.trim();
    await lists.doc(id).set({ ...item, updatedAt: FieldValue.serverTimestamp() });
    return text(`Added to ${kind.label}: ${person ? person + " · " : ""}${item.name}${date ? ` (${date})` : ""}  id=${id}`);
  }
);

server.tool(
  "list_list_items",
  "Show entries in the planner's side lists (movies, books, restaurants, gifts, cities, custom lists). Omit `list` to see every list.",
  { list: z.string().optional().describe("List name or id; omit for all") },
  async ({ list }) => {
    const kinds = await allListKinds();
    const only = list ? (await resolveList(list, false)).id : null;
    const all = await liveDocs(lists);
    const out = [];
    for (const k of kinds) {
      if (only && k.id !== only) continue;
      const rows = all.filter((x) => x.type === k.id).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      if (only || rows.length) out.push(`${k.label} (${rows.length}):`, ...(rows.length ? rows.map((x) => `- ${x.person ? x.person + " · " : ""}${x.name}${x.date ? ` | ${x.date}` : ""}${x.city ? ` | ${x.city}` : ""}${x.occasion ? ` | ${x.occasion}` : ""}${x.note ? ` | ${x.note}` : ""}  id=${x.id}`) : ["(empty)"]), "");
    }
    return text(out.length ? out.join("\n") : "All lists are empty.");
  }
);

server.tool(
  "delete_list_item",
  "Move a list entry to the planner's trash (restorable on the website for 30 days). Only when the user asks to remove it.",
  { id: z.string() },
  async ({ id }) => {
    const ref = lists.doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().deletedAt) throw new Error(`No list entry with id ${id}.`);
    await ref.update({ deletedAt: new Date().toISOString(), updatedAt: FieldValue.serverTimestamp() });
    return text(`Moved to trash: ${snap.data().name}`);
  }
);

await server.connect(new StdioServerTransport());
