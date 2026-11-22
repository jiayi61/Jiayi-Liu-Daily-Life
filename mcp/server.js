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
const goals = userRef.collection("goals");
const listTypes = userRef.collection("listTypes");
const inbox = userRef.collection("inbox");

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
// a planner day runs 05:00 → 05:00: 01:30 sorts after 23:00 on the same page
const DAY_START = 5 * 60;
const lmin = (t) => { const m = toMin(t); return m < DAY_START ? m + 1440 : m; };
async function categories() {
  const p = await userRef.collection("meta").doc("profile").get();
  return (p.exists && p.data().categories) || [];
}

function normDue(due) {
  if (due == null || /^(none|null|no|-|无)?$/i.test(String(due).trim())) return ""; // no deadline
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

const subsOf = (t) => t.subs || [];
const fmtTodo = (t) => {
  const s = subsOf(t), n = s.filter((x) => x.done).length;
  return `- [${t.done ? "x" : " "}] ${t.title}  (${t.due ? `due ${t.due.replace("T", " ")}` : "no deadline"}, ${PRIO_NAME[t.prio] ?? "normal"}${t.tag ? `, #${t.tag}` : ""}${!t.done && t.due && new Date(t.due) < new Date() ? ", OVERDUE" : ""}${s.length ? `, ${n}/${s.length} subtasks = ${Math.round((n / s.length) * 100)}%` : ""})  id=${t.id}`
    + s.map((x) => `\n    - [${x.done ? "x" : " "}] ${x.title}`).join("");
};
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
  const data = { ...rest, updatedAt: FieldValue.serverTimestamp() };
  if (t.due) data.dueAt = Timestamp.fromDate(new Date(t.due));
  await todos.doc(t.id).set(data);
}

/* ---------- server ---------- */
const server = new McpServer({ name: "daily-planner", version: "1.0.0" });

server.tool(
  "add_todo",
  "Add a to-do to the Daily Planner. The deadline is optional (leave it out for open-ended things). Dates/times are the user's local time; resolve words like 'Friday' or 'tomorrow night' against the 'Now' shown by list tools (call list_todos first if unsure of today's date). If a date has no time, 23:59 is used. Big tasks can be broken into `subtasks`; the planner shows their completion %.",
  {
    title: z.string().min(1).describe("What needs to be done"),
    due: z.string().optional().describe("Deadline, local time: YYYY-MM-DD or YYYY-MM-DDTHH:MM; omit for no deadline"),
    priority: z.enum(["high", "normal", "low"]).default("normal"),
    tag: z.string().optional().describe("Optional short tag, e.g. a course code"),
    subtasks: z.array(z.string()).optional().describe("Optional smaller steps"),
    goal: z.string().optional().describe("Long-term goal this short-term goal belongs to: its id or part of its title (see list_goals)"),
  },
  async ({ title, due, priority, tag, subtasks, goal }) => {
    const t = { id: uid(), title: title.trim(), due: normDue(due), prio: PRIO[priority], tag: tag?.trim() || "", done: false, doneAt: null, createdAt: new Date().toISOString() };
    if (subtasks?.length) t.subs = subtasks.map((x) => ({ id: uid(), title: x.trim(), done: false })).filter((x) => x.title);
    if (goal) t.goal = (await findGoal(goal)).id;
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
    if (due_on_or_before) list = list.filter((t) => t.due && t.due.slice(0, 10) <= due_on_or_before);
    if (due_on_or_after) list = list.filter((t) => t.due && t.due.slice(0, 10) >= due_on_or_after);
    list.sort((a, b) => (a.due || "~").localeCompare(b.due || "~")); // no-deadline ones last
    return text(header() + (list.length ? list.map(fmtTodo).join("\n") : "(no matching to-dos)"));
  }
);

server.tool(
  "complete_todo",
  "Mark a to-do as done (or not done). `todo` is the id from list_todos, or part of its title. Pass `subtask` (part of its title) to tick just one subtask; ticking the last one completes the to-do.",
  { todo: z.string(), done: z.boolean().default(true), subtask: z.string().optional() },
  async ({ todo, done, subtask }) => {
    const t = await findTodo(todo);
    if (subtask) {
      const q = subtask.toLowerCase();
      const hits = subsOf(t).filter((x) => x.title.toLowerCase().includes(q));
      if (hits.length !== 1) throw new Error(hits.length ? `"${subtask}" matches several subtasks: ${hits.map((x) => x.title).join(", ")}` : `No subtask matches "${subtask}".`);
      hits[0].done = done;
      if (subsOf(t).every((x) => x.done)) { if (!t.done) { t.done = true; t.doneAt = nowLocal(); } }
      else if (t.done) { t.done = false; t.doneAt = null; }
      await writeTodo(t);
      return text(`Subtask ${done ? "done" : "reopened"}:\n${fmtTodo(t)}`);
    }
    t.done = done;
    t.doneAt = done ? nowLocal() : null;
    await writeTodo(t);
    return text(`${done ? "Completed" : "Reopened"}:\n${fmtTodo(t)}`);
  }
);

server.tool(
  "update_todo",
  "Change a to-do's title, deadline, priority or tag, or add subtasks. `todo` is the id or part of the title. Use due='none' to remove the deadline.",
  {
    todo: z.string(),
    title: z.string().optional(),
    due: z.string().optional().describe("YYYY-MM-DD or YYYY-MM-DDTHH:MM, local time"),
    priority: z.enum(["high", "normal", "low"]).optional(),
    tag: z.string().optional(),
    add_subtasks: z.array(z.string()).optional(),
    goal: z.string().optional().describe("Attach to a long-term goal (id or part of title); 'none' detaches"),
  },
  async ({ todo, title, due, priority, tag, add_subtasks, goal }) => {
    const t = await findTodo(todo);
    if (title) t.title = title.trim();
    if (due !== undefined) t.due = normDue(due);
    if (goal !== undefined) { if (/^(none|无)$/i.test(goal.trim())) delete t.goal; else t.goal = (await findGoal(goal)).id; }
    if (add_subtasks?.length) {
      t.subs = [...subsOf(t), ...add_subtasks.map((x) => ({ id: uid(), title: x.trim(), done: false })).filter((x) => x.title)];
      if (t.done) { t.done = false; t.doneAt = null; }
    }
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
  "Add a time block to the planner's daily schedule (classes, meetings, routines). Times are local HH:MM. A planner day runs 05:00 → 05:00 the next morning: something at 01:00 after a late night belongs to the previous date's page (use that date, start 01:00). Pick a `tag` from list_tags when one fits.",
  {
    title: z.string().min(1),
    date: z.string().describe("YYYY-MM-DD; for repeating items this is the first day"),
    start: z.string().describe("HH:MM"),
    end: z.string().optional().describe("HH:MM"),
    note: z.string().optional().describe("Place or note"),
    repeat: z.enum(["once", "daily", "weekdays", "weekly"]).default("once"),
    tag: z.string().optional().describe("Schedule tag/category label or id, e.g. 学习 / 会议 (see list_tags)"),
  },
  async ({ title, date, start, end, note, repeat, tag }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || (end && !/^\d{2}:\d{2}$/.test(end))) {
      throw new Error("Use date YYYY-MM-DD and times HH:MM.");
    }
    const id = uid();
    let cat = "", color = "#5b86b0";
    if (tag) {
      const cats = await categories();
      const c = cats.find((x) => x.id === tag || x.label === tag.trim()) || cats.find((x) => x.label.includes(tag.trim()));
      if (!c) throw new Error(`No tag "${tag}". Tags: ${cats.map((x) => x.label).join(", ") || "(none set up yet)"}`);
      cat = c.id; color = c.color;
    }
    const ev = { id, title: title.trim(), date, start, end: end || "", note: note?.trim() || "", color, cat, repeat, skip: [], doneOn: [] };
    await events.doc(id).set({ ...ev, updatedAt: FieldValue.serverTimestamp() });
    return text(`Added to schedule: ${date} ${start}${end ? "–" + end : ""} ${ev.title}${repeat !== "once" ? ` (repeats ${repeat})` : ""}  id=${id}`);
  }
);

server.tool(
  "list_schedule",
  "Show the schedule for one day (including repeating items) plus the to-dos due that day.",
  { date: z.string().optional().describe("YYYY-MM-DD, default today (before 5 am: yesterday)") },
  async ({ date }) => {
    const day = date || ymd(new Date(Date.now() - DAY_START * 60000)); // before 5 am it is still "yesterday"
    const evs = (await liveDocs(events))
      .filter((e) => occursOn(e, day)).sort((a, b) => lmin(a.start) - lmin(b.start));
    const cats = await categories();
    const tagOf = (e) => cats.find((c) => c.id === e.cat);
    const due = (await liveDocs(todos))
      .filter((t) => t.due && t.due.slice(0, 10) === day).sort((a, b) => a.due.localeCompare(b.due));
    const lines = [header(), `Schedule for ${day} ${WEEK[parseYmd(day).getDay()]}:`];
    lines.push(...(evs.length ? evs.map((e) => `- [${(e.doneOn || []).includes(day) ? "x" : " "}] ${e.start}${e.end ? "–" + e.end : ""} ${e.title}${tagOf(e) ? ` [${tagOf(e).label}]` : ""}${e.note ? ` (${e.note})` : ""}${e.repeat && e.repeat !== "once" ? ` ↻${e.repeat}` : ""}  id=${e.id}`) : ["(nothing scheduled)"]));
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

server.tool(
  "list_tags",
  "List the schedule tags (categories) the user has set up, in priority order.",
  {},
  async () => {
    const cats = await categories();
    return text(cats.length ? cats.map((c, i) => `${i + 1}. ${c.emoji} ${c.label}  id=${c.id}`).join("\n") : "No tags set up yet (the website asks on first login).");
  }
);

/* ---------- long-term goals (website: 🌟 长期目标 page) ---------- */
async function findGoal(ref) {
  const all = await liveDocs(goals);
  const byId = all.find((g) => g.id === ref); if (byId) return byId;
  const hits = all.filter((g) => g.title.toLowerCase().includes(ref.toLowerCase()));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `"${ref}" matches several goals: ${hits.map((g) => g.title).join(", ")}` : `No long-term goal matches "${ref}".`);
}
const goalProgress = (g, todosAll) => {
  if (g.done) return 1;
  const share = (t) => (t.done ? 1 : (t.subs || []).length ? t.subs.filter((x) => x.done).length / t.subs.length : 0);
  const parts = [...(g.steps || []).map((x) => (x.done ? 1 : 0)), ...todosAll.filter((t) => t.goal === g.id).map(share)];
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
};

server.tool(
  "list_goals",
  "List the user's long-term goals (the big things they're working toward over months/years) with milestones, linked short-term goals (to-dos) and progress.",
  { include_achieved: z.boolean().default(false) },
  async ({ include_achieved }) => {
    const all = (await liveDocs(goals)).filter((g) => include_achieved || !g.done);
    const tds = await liveDocs(todos);
    if (!all.length) return text("No long-term goals yet.");
    return text(all.map((g) => {
      const p = goalProgress(g, tds);
      const linkedT = tds.filter((t) => t.goal === g.id);
      return [`${g.emoji || "🌟"} ${g.title}${g.done ? " (ACHIEVED)" : ""} — ${p == null ? "no steps yet" : Math.round(p * 100) + "%"}${g.target ? `, target: ${g.target}` : ""}  id=${g.id}`,
        g.why ? `  why: ${g.why}` : "",
        ...(g.steps || []).map((x) => `  milestone [${x.done ? "x" : " "}] ${x.title}`),
        ...linkedT.map((t) => `  short-term [${t.done ? "x" : " "}] ${t.title}${t.due ? ` (due ${t.due.replace("T", " ")})` : ""}  id=${t.id}`)].filter(Boolean).join("\n");
    }).join("\n\n"));
  }
);

server.tool(
  "add_goal",
  "Create a long-term goal (something that takes months or years). Short-term goals are added with add_todo(goal=...).",
  {
    title: z.string().min(1),
    emoji: z.string().optional(),
    why: z.string().optional().describe("Why it matters to the user"),
    target: z.string().optional().describe("Free text, e.g. '2027 年夏天'"),
    milestones: z.array(z.string()).optional(),
  },
  async ({ title, emoji, why, target, milestones }) => {
    const id = uid();
    const g = { id, title: title.trim(), emoji: emoji || "🌟", why: why?.trim() || "", target: target?.trim() || "",
      steps: (milestones || []).map((x) => ({ id: uid(), title: x.trim(), done: false })).filter((x) => x.title), done: false, doneAt: null, createdAt: new Date().toISOString() };
    await goals.doc(id).set({ ...g, updatedAt: FieldValue.serverTimestamp() });
    return text(`Added long-term goal: ${g.emoji} ${g.title}${g.steps.length ? ` with ${g.steps.length} milestones` : ""}  id=${id}`);
  }
);

server.tool(
  "update_goal",
  "Tick/untick a milestone, add milestones, or mark a long-term goal achieved. `goal` is the id or part of the title.",
  {
    goal: z.string(),
    complete_milestone: z.string().optional().describe("Part of a milestone title to tick"),
    reopen_milestone: z.string().optional(),
    add_milestones: z.array(z.string()).optional(),
    achieved: z.boolean().optional(),
  },
  async ({ goal, complete_milestone, reopen_milestone, add_milestones, achieved }) => {
    const g = await findGoal(goal);
    const steps = g.steps || [];
    for (const [q, v] of [[complete_milestone, true], [reopen_milestone, false]]) {
      if (!q) continue;
      const hits = steps.filter((x) => x.title.toLowerCase().includes(q.toLowerCase()));
      if (hits.length !== 1) throw new Error(hits.length ? `"${q}" matches several milestones` : `No milestone matches "${q}".`);
      hits[0].done = v;
    }
    if (add_milestones?.length) steps.push(...add_milestones.map((x) => ({ id: uid(), title: x.trim(), done: false })).filter((x) => x.title));
    const patch = { steps, updatedAt: FieldValue.serverTimestamp() };
    if (achieved !== undefined) { patch.done = achieved; patch.doneAt = achieved ? nowLocal() : null; }
    await goals.doc(g.id).update(patch);
    return text(`Updated ${g.emoji || "🌟"} ${g.title}.`);
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

server.tool(
  "stage_import",
  "Put deadlines/events you found (e.g. by reading the user's Gmail) into the planner's import inbox instead of adding them directly. The website then shows a bar; the user ticks what to keep and imports it. Prefer this over add_todo when importing many items found in email or other apps. Items already imported or already staged (same `ref`) are skipped. Dates are local time.",
  {
    source: z.enum(["gmail", "canvas", "other"]).default("gmail"),
    items: z.array(z.object({
      title: z.string().min(1).describe("Short to-do title, e.g. '线代 HW08'"),
      kind: z.enum(["todo", "event"]).default("todo").describe("todo = deadline; event = something at a fixed time (exam, interview)"),
      due: z.string().optional().describe("todo deadline, YYYY-MM-DD or YYYY-MM-DDTHH:MM"),
      date: z.string().optional().describe("event date YYYY-MM-DD"),
      start: z.string().optional().describe("event start HH:MM"),
      end: z.string().optional().describe("event end HH:MM"),
      tag: z.string().optional().describe("Course code or short tag, reuse the user's existing tags (see list_todos)"),
      from: z.string().optional().describe("Where it was found, e.g. the email subject"),
      ref: z.string().optional().describe("Stable id of the source, e.g. Gmail thread id + item, used to avoid duplicates"),
    })).min(1),
  },
  async ({ source, items }) => {
    const [staged, done] = await Promise.all([inbox.get(), Promise.all([todos.get(), events.get()])]);
    const seen = new Set([...staged.docs, ...done.flatMap((q) => q.docs)].map((d) => d.data().src).filter(Boolean));
    const batch = db.batch();
    const added = [], skipped = [];
    for (const it of items) {
      const src = `${source}:${it.ref || `${it.title}|${it.due || it.date || ""}`}`;
      if (seen.has(src)) { skipped.push(it.title); continue; }
      seen.add(src);
      const x = { id: uid(), source, kind: it.kind, title: it.title.trim(), tag: it.tag?.trim() || "", from: it.from?.trim() || "", note: "", src, createdAt: new Date().toISOString() };
      if (it.kind === "todo") x.due = it.due ? normDue(it.due) : "";
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || "") || !/^\d{2}:\d{2}$/.test(it.start || "")) throw new Error(`Event "${it.title}" needs date YYYY-MM-DD and start HH:MM.`);
        Object.assign(x, { date: it.date, start: it.start, end: it.end || "" });
      }
      batch.set(inbox.doc(x.id), { ...x, updatedAt: FieldValue.serverTimestamp() });
      added.push(x);
    }
    if (added.length) await batch.commit();
    return text(`Staged ${added.length} item(s) for the user to review on the website (📥 bar on the home page).`
      + (skipped.length ? `\nSkipped ${skipped.length} already staged/imported: ${skipped.join(", ")}` : ""));
  }
);

await server.connect(new StdioServerTransport());
