/* Daily Planner — UI and state; cloud.js syncs it to Firestore */
(() => {
  "use strict";

  const STORE_KEY = "jiayi-planner-v1";
  const MOODS = ["😄", "🙂", "😐", "😮‍💨", "😢"];
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const QUOTES = [
    "一次只做一件事，把它做好。",
    "今天的小进步，是明天的底气。",
    "先完成，再完美。",
    "把大目标拆成小步骤，一步一步来。",
    "休息也是计划的一部分。",
    "专注当下这一格时间。",
    "别忘了喝水，也别忘了对自己温柔一点。",
  ];
  const REPEAT_LABEL = { daily: "每天", weekdays: "工作日", weekly: "每周" };

  /* ---------- helpers ---------- */
  const $ = (s) => document.querySelector(s);
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toMin = (t) => { if (!t) return null; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  // a planner day runs 05:00 → 05:00 the next morning, so 1 am still belongs to "yesterday"
  const DAY_START = 5 * 60;
  const todayStr = () => ymd(new Date(Date.now() - DAY_START * 60000));
  const lmin = (t) => { const m = toMin(t); return m == null ? null : m < DAY_START ? m + 1440 : m; }; // minutes on the day page
  const evEnd = (ev) => { const s = lmin(ev.start), e = lmin(ev.end); return e == null ? null : e <= s ? e + 1440 : e; };
  const TRASH_DAYS = 30;

  /* ---------- state ---------- */
  const blank = () => ({ version: 1, events: [], todos: [], notes: {}, moods: {}, lists: [], listTypes: [], goals: [], reviews: [], inbox: [] });
  let state = blank(); // filled in by cloud.js after sign-in
  let selected = todayStr();
  let filter = "all";
  let doneCollapsed = true;
  // items in the trash keep living in the same arrays, marked with deletedAt
  const liveTodos = () => state.todos.filter((t) => !t.deletedAt);
  const liveEvents = () => state.events.filter((e) => !e.deletedAt);

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY));
      if (raw && Array.isArray(raw.events) && Array.isArray(raw.todos)) return { ...blank(), ...raw };
    } catch (_) { /* ignore */ }
    return blank();
  }
  let profile = null; // { nickname, role, categories[] } — set by cloud.js
  function save() {
    if (window.PlannerCloud) window.PlannerCloud.queue();
  }

  /* ---------- schedule logic ---------- */
  function occursOn(ev, day) {
    if ((ev.skip || []).includes(day)) return false;
    if (ev.repeat === "once" || !ev.repeat) return ev.date === day;
    if (day < ev.date || (ev.until && day > ev.until)) return false; // until: last day of an imported series
    const dow = parseYmd(day).getDay();
    if (ev.repeat === "daily") return true;
    if (ev.repeat === "weekdays") return dow >= 1 && dow <= 5;
    if (ev.repeat === "weekly") return dow === parseYmd(ev.date).getDay();
    return false;
  }
  const eventsOn = (day) =>
    liveEvents().filter((e) => occursOn(e, day)).sort((a, b) => lmin(a.start) - lmin(b.start) || (evEnd(a) ?? 0) - (evEnd(b) ?? 0));
  const isEventDone = (ev, day) => (ev.doneOn || []).includes(day);

  /* ---------- todo logic ---------- */
  // the deadline is optional: t.due is "YYYY-MM-DDTHH:MM" or ""
  const dueDate = (t) => (t.due ? new Date(t.due) : null);
  const dueDay = (t) => (t.due || "").slice(0, 10);
  const isLate = (t, now = Date.now()) => !!t.due && !t.done && dueDate(t) < now;

  /* ---------- scheduled to-dos: an event with ev.todo = to-do id puts it on the calendar ---------- */
  const slotEndAt = (ev, day) => { const d = parseYmd(day); d.setMinutes(evEnd(ev) ?? lmin(ev.start) + 30); return d; };
  // → { ev, day, past } for the next time slot booked for this to-do, or the latest past one, or null
  function slotOf(t) {
    const evs = liveEvents().filter((e) => e.todo === t.id);
    if (!evs.length) return null;
    const today = todayStr();
    let next = null, last = null;
    for (const ev of evs) {
      if (ev.repeat && ev.repeat !== "once") {
        for (let i = 0; i < 8; i++) { const d = addDays(today, i); if (occursOn(ev, d)) { if (!next || d + ev.start < next.day + next.ev.start) next = { ev, day: d }; break; } }
        continue;
      }
      const end = slotEndAt(ev, ev.date);
      // a slot counts as passed only once its day is over
      if (ev.date >= today) { if (!next || ev.date + ev.start < next.day + next.ev.start) next = { ev, day: ev.date }; }
      else if (!last || end > last.end) last = { ev, day: ev.date, end };
    }
    return next ? { ...next, past: false } : last ? { ev: last.ev, day: last.day, past: true } : null;
  }
  function fmtSlot(sl) {
    const today = todayStr(), d = parseYmd(sl.day);
    const label = sl.day === today ? "今天" : sl.day === addDays(today, 1) ? "明天" : sl.day === addDays(today, -1) ? "昨天" : `${d.getMonth() + 1}/${d.getDate()} ${WEEK[d.getDay()]}`;
    return `${label} ${sl.ev.start}${sl.ev.end ? `–${sl.ev.end}` : ""}`;
  }

  function leftText(t) {
    if (!t.due) return null;
    let diff = dueDate(t) - Date.now();
    const late = diff < 0;
    diff = Math.abs(diff);
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    let s = d > 0 ? `${d}天${h ? h + "小时" : ""}` : h > 0 ? `${h}小时${m ? m + "分" : ""}` : `${m}分钟`;
    if (!late && diff < 60000) s = "不到1分钟";
    return { text: late ? `逾期 ${s}` : `还剩 ${s}`, cls: late ? "late" : diff < 86400000 ? "soon" : "" };
  }

  function fmtDue(t) {
    if (!t.due) return "";
    const day = dueDay(t);
    const time = t.due.slice(11, 16);
    const today = todayStr();
    let label;
    if (day === today) label = "今天";
    else if (day === addDays(today, 1)) label = "明天";
    else if (day === addDays(today, -1)) label = "昨天";
    else { const d = parseYmd(day); label = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`; }
    return `${label} ${time}`;
  }

  /* ---------- rendering ---------- */
  function render() {
    renderDate();
    renderWeek();
    renderSchedule();
    renderTodos();
    renderNotes();
    renderSummary();
    renderTrashCount();
    renderGoalSelect();
    window.Planner?.onRender?.();
    window.Planner?.renderHooks?.forEach((f) => f());
  }

  function renderDate() {
    const d = parseYmd(selected);
    $("#dateBig").textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
    const diff = Math.round((d - parseYmd(todayStr())) / 86400000);
    const rel = diff === 0 ? '<span class="tag-today">今天</span>' : diff === 1 ? "明天" : diff === -1 ? "昨天" : diff > 0 ? `${diff} 天后` : `${-diff} 天前`;
    $("#dateSmall").innerHTML = `${d.getFullYear()} 年 · ${rel}`;
    $("#datePicker").value = selected;
    $("#tDate").value = $("#tDate").dataset.touched ? $("#tDate").value : selected;
  }

  function renderWeek() {
    const d = parseYmd(selected);
    const mondayOffset = (d.getDay() + 6) % 7;
    const start = addDays(selected, -mondayOffset);
    const today = todayStr();
    let html = "";
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, i);
      const dd = parseYmd(day);
      const dueN = liveTodos().filter((t) => !t.done && dueDay(t) === day).length;
      const hasEv = eventsOn(day).length > 0;
      const dots = (hasEv ? '<i class="s"></i>' : "") + "<i></i>".repeat(Math.min(dueN, 3));
      html += `<button class="wday ${day === selected ? "sel" : ""} ${day === today ? "today" : ""}" data-day="${day}">
        <div class="wd">${WEEK[dd.getDay()]}</div><div class="dn">${dd.getDate()}</div><div class="dots">${dots}</div></button>`;
    }
    $("#weekStrip").innerHTML = html;
  }

  // the day calendar lives in daycal.js
  function renderSchedule() { window.Planner?.renderDay?.(selected); }

  // subtasks: t.subs = [{ id, title, done }]; progress = share of ticked subtasks
  let addingSubFor = null; // to-do id whose "add subtask" box is open
  const subs = (t) => t.subs || [];
  const progress = (t) => { const n = subs(t).length; return n ? subs(t).filter((x) => x.done).length / n : null; };

  function subsHtml(t) {
    const list = subs(t);
    const adding = addingSubFor === t.id;
    if (!list.length && !adding) return "";
    if (t.done && !adding) return "";
    return `<ul class="subs">${list.map((x) => `
      <li class="${x.done ? "is-done" : ""}">
        <input type="checkbox" class="chk sm" data-sub-done="${t.id}:${x.id}" ${x.done ? "checked" : ""} aria-label="完成" />
        <span class="sub-t" data-sub-edit="${t.id}:${x.id}" title="点击改名">${esc(x.title)}</span>
        <button class="icon-btn" data-sub-del="${t.id}:${x.id}" title="删除小任务">✕</button>
      </li>`).join("")}
      ${adding ? `<li class="sub-add"><input type="text" data-sub-input="${t.id}" placeholder="小任务，回车添加；Esc 结束" /></li>` : ""}
    </ul>`;
  }

  const liveGoals = () => (state.goals || []).filter((g) => !g.deletedAt);
  const goalOf = (t) => t.goal && liveGoals().find((g) => g.id === t.goal);

  function todoItem(t) {
    const left = t.done ? null : leftText(t);
    const p = progress(t);
    const g = goalOf(t);
    const sl = t.done ? null : slotOf(t);
    return `<li class="todo ${t.done ? "is-done" : ""}" data-id="${t.id}">
      <input type="checkbox" class="chk" data-todo-done="${t.id}" ${t.done ? "checked" : ""} aria-label="完成" />
      <span class="prio p${t.prio}"></span>
      <div class="txt">
        <div class="ttl">${esc(t.title)}</div>
        <div class="meta">
          ${sl ? `<span class="slot ${sl.past ? "old" : ""}" data-goto-day="${sl.day}" title="${sl.past ? "安排的时间过了还没完成，可以再拖到日历上" : "点一下跳到那天"}">📅 ${sl.past ? "上次安排 " : ""}${fmtSlot(sl)}</span>` : ""}
          ${t.due ? `<span class="due">⏰ ${fmtDue(t)}</span>` : ""}
          ${left ? `<span class="left ${left.cls}">${left.text}</span>` : ""}
          ${t.tag ? `<span class="tag"># ${esc(t.tag)}</span>` : ""}
          ${g ? `<span class="goal-chip" data-open-goal="${g.id}" title="属于长期目标">${esc(g.emoji || "🌟")} ${esc(g.title)}</span>` : ""}
          ${p != null ? `<span class="prog" title="${subs(t).filter((x) => x.done).length}/${subs(t).length} 个小任务完成"><i><b style="width:${Math.round(p * 100)}%"></b></i>${Math.round(p * 100)}%</span>` : ""}
        </div>
        ${subsHtml(t)}
      </div>
      <button class="icon-btn" data-sub-new="${t.id}" title="拆成小任务">＋</button>
      <button class="icon-btn" data-todo-edit="${t.id}" title="编辑">✎</button>
      <button class="icon-btn" data-todo-del="${t.id}" title="删除">✕</button>
    </li>`;
  }

  function renderTodos() {
    const now = Date.now();
    const byDue = (a, b) => dueDate(a) - dueDate(b) || b.prio - a.prio;
    const openAll = liveTodos().filter((t) => !t.done);
    const slots = new Map(openAll.map((t) => [t.id, slotOf(t)]));
    const booked = openAll.filter((t) => slots.get(t.id) && !slots.get(t.id).past)
      .sort((a, b) => { const x = slots.get(a.id), y = slots.get(b.id); return (x.day + String(lmin(x.ev.start)).padStart(4, "0")).localeCompare(y.day + String(lmin(y.ev.start)).padStart(4, "0")); });
    const open = openAll.filter((t) => !booked.includes(t)); // "还没安排" (incl. slots that already passed)
    const dated = open.filter((t) => t.due);
    const over = dated.filter((t) => dueDate(t) < now).sort(byDue);
    const onDay = dated.filter((t) => dueDay(t) === selected && dueDate(t) >= now).sort(byDue);
    const later = dated.filter((t) => dueDay(t) !== selected && dueDate(t) >= now).sort(byDue);
    const someday = open.filter((t) => !t.due).sort((a, b) => b.prio - a.prio || (a.createdAt || "").localeCompare(b.createdAt || ""));
    const done = liveTodos()
      .filter((t) => t.done && ((t.doneAt || "").slice(0, 10) === selected || dueDay(t) === selected))
      .sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));

    const unGroups = filter === "day"
      ? [
          ["over", "⚠️ 逾期（当天）", over.filter((t) => dueDay(t) === selected)],
          ["today", "📌 当天截止", onDay],
        ]
      : [
          ["over", "⚠️ 已逾期", over],
          ["today", selected === todayStr() ? "📌 今天截止" : "📌 当天截止", onDay],
          ["later", "🗓 即将到来", later],
          ["someday", "📝 没有截止日期", someday],
        ];
    const bookedShown = filter === "day" ? booked.filter((t) => slots.get(t.id).day === selected || dueDay(t) === selected) : booked;
    const unN = unGroups.reduce((a, g) => a + g[2].length, 0);
    const touch = !matchMedia("(hover: hover)").matches;
    const groups = [
      ["sect", `🗂 还没安排 <span class="n">${unN}</span>`, unN ? `${touch ? "长按" : "按住"}一项拖到日历上，就安排好了时间` : "都安排好了 👏"],
      ...unGroups,
      ["sect booked-sect", `📅 已安排 <span class="n">${bookedShown.length}</span>`, bookedShown.length ? "" : "还没有安排进日历的事"],
      ["booked", "", bookedShown],
      ["done", filter === "day" ? "✔️ 已完成" : "✔️ 当天完成", filter === "day" ? done.filter((t) => dueDay(t) === selected) : done],
    ];

    let html = "", count = 0;
    for (const [cls, label, items] of groups) {
      if (cls.startsWith("sect")) { html += `<div class="${cls}"><div class="sect-h">${label}</div>${items ? `<p class="sect-hint">${items}</p>` : ""}</div>`; continue; }
      if (!items.length) continue;
      count += items.length;
      const collapsed = cls === "done" && doneCollapsed ? "collapsed" : "";
      html += `<div class="group ${cls} ${collapsed}">
        ${label ? `<div class="group-h" ${cls === "done" ? 'data-toggle-done="1"' : ""}>${label} <span class="n">${items.length}</span>${cls === "done" ? (doneCollapsed ? " ▸" : " ▾") : ""}</div>` : ""}
        <ul>${items.map(todoItem).join("")}</ul></div>`;
    }
    const typing = document.activeElement?.dataset?.subInput ? document.activeElement.value : null;
    $("#todoGroups").innerHTML = html;
    const box = addingSubFor && $(`[data-sub-input="${addingSubFor}"]`);
    if (box) { if (typing != null) box.value = typing; box.focus(); }
    $("#todoEmpty").hidden = count > 0;
  }

  function renderNotes() {
    const area = $("#noteArea");
    if (document.activeElement !== area) area.value = state.notes[selected] || "";
    const mood = state.moods[selected];
    $("#moods").innerHTML = MOODS.map((m) => `<button data-mood="${m}" class="${m === mood ? "on" : ""}" title="今日心情">${m}</button>`).join("");
  }

  function renderSummary() {
    const evs = eventsOn(selected);
    const evDone = evs.filter((e) => isEventDone(e, selected)).length;
    const dayTodos = liveTodos().filter((t) => dueDay(t) === selected || (t.done && (t.doneAt || "").slice(0, 10) === selected));
    const tdDone = dayTodos.filter((t) => t.done).length;
    const total = evs.length + dayTodos.length;
    const pct = total ? Math.round(((evDone + tdDone) / total) * 100) : 0;
    $("#ringPct").textContent = `${pct}%`;
    $("#ringFg").style.strokeDashoffset = 314.16 * (1 - pct / 100);
    $("#statSched").textContent = evs.length;
    $("#statDue").textContent = liveTodos().filter((t) => !t.done && dueDay(t) === selected).length;
    $("#statOver").textContent = liveTodos().filter((t) => isLate(t)).length;
    $("#statOpen").textContent = liveTodos().filter((t) => !t.done).length;
    const idx = parseYmd(selected).getDate() % QUOTES.length;
    $("#quote").textContent = `“${QUOTES[idx]}”`;
  }

  /* ---------- dialog ---------- */
  function openDialog(title, bodyHtml, buttons) {
    const dlg = $("#editDlg");
    $("#editTitle").textContent = title;
    $("#editBody").innerHTML = bodyHtml;
    dlg.querySelector(".dlg-actions").innerHTML = buttons
      .map((b) => `<button value="${b.value}" class="${b.cls || "ghost"}">${b.label}</button>`).join("");
    dlg.showModal();
    return new Promise((resolve) => {
      dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true });
    });
  }
  const SAVE_BTNS = [{ value: "cancel", label: "取消" }, { value: "ok", label: "保存", cls: "primary" }];

  async function deleteEvent(ev) {
    if (!ev.repeat || ev.repeat === "once") {
      ev.deletedAt = new Date().toISOString();
      toast(`已把「${ev.title}」放进垃圾箱`, () => applyTrash(`e:${ev.id}`, "restore"));
    } else {
      const r = await openDialog("删除重复日程", `<p>「${esc(ev.title)}」是重复日程，要怎么删除？</p>`, [
        { value: "cancel", label: "取消" },
        { value: "one", label: "只删这一天" },
        { value: "all", label: "全部删除", cls: "primary" },
      ]);
      ev = state.events.find((x) => x.id === ev.id);
      if (!ev) return;
      const day = selected;
      if (r === "one") {
        (ev.skip ||= []).push(day);
        (ev.skipDeleted ||= {})[day] = new Date().toISOString();
        toast(`已把「${ev.title}」${fmtDay(day)}这一天放进垃圾箱`, () => applyTrash(`s:${ev.id}:${day}`, "restore"));
      } else if (r === "all") {
        ev.deletedAt = new Date().toISOString();
        toast(`已把「${ev.title}」放进垃圾箱`, () => applyTrash(`e:${ev.id}`, "restore"));
      } else return;
    }
    save(); render();
  }

  const goalOptions = (cur) => `<option value="">🌟 不属于长期目标</option>` + liveGoals().filter((g) => !g.done || g.id === cur)
    .map((g) => `<option value="${g.id}" ${g.id === cur ? "selected" : ""}>${esc(g.emoji || "🌟")} ${esc(g.title)}</option>`).join("");
  function renderGoalSelect() {
    const sel = $("#tGoal"), keep = sel.value;
    sel.hidden = !liveGoals().some((g) => !g.done);
    sel.innerHTML = goalOptions(keep);
    sel.value = liveGoals().some((g) => g.id === keep) ? keep : "";
  }

  async function editTodo(t) {
    const r = await openDialog("编辑待办", `
      <label>内容<input type="text" id="xTitle" value="${esc(t.title)}" /></label>
      <label class="inline-chk"><input type="checkbox" id="xNoDue" ${t.due ? "" : "checked"} /> 不设截止日期</label>
      <div class="two" id="xDueRow" ${t.due ? "" : "hidden"}><label>截止日期<input type="date" id="xDate" value="${dueDay(t) || selected}" /></label>
      <label>时间<input type="time" id="xTime" value="${t.due ? t.due.slice(11, 16) : "23:59"}" /></label></div>
      <div class="two"><label>优先级<select id="xPrio">
        <option value="2" ${t.prio == 2 ? "selected" : ""}>🔴 重要</option>
        <option value="1" ${t.prio == 1 ? "selected" : ""}>🟡 普通</option>
        <option value="0" ${t.prio == 0 ? "selected" : ""}>🟢 随意</option></select></label>
      <label>标签<input type="text" id="xTag" value="${esc(t.tag)}" /></label></div>
      ${liveGoals().length ? `<label>属于哪个长期目标<select id="xGoal">${goalOptions(t.goal)}</select></label>` : ""}`, SAVE_BTNS);
    if (r !== "ok") return;
    const title = $("#xTitle").value.trim();
    const noDue = $("#xNoDue").checked;
    if (!title || (!noDue && !$("#xDate").value)) return;
    t = state.todos.find((x) => x.id === t.id);
    if (!t) return;
    Object.assign(t, { title, due: noDue ? "" : `${$("#xDate").value}T${$("#xTime").value || "23:59"}`, prio: Number($("#xPrio").value), tag: $("#xTag").value.trim() });
    if ($("#xGoal")) { if ($("#xGoal").value) t.goal = $("#xGoal").value; else delete t.goal; }
    save(); render();
  }

  /* ---------- events ---------- */
  // a to-do and the one-off calendar slots booked for it are ticked together
  function markSlotsDone(td) {
    for (const ev of liveEvents()) {
      if (ev.todo !== td.id || (ev.repeat && ev.repeat !== "once")) continue;
      ev.doneOn = td.done ? [...new Set([...(ev.doneOn || []), ev.date])] : (ev.doneOn || []).filter((d) => d !== ev.date);
    }
  }

  function setDay(day) { selected = day; $("#tDate").dataset.touched = ""; render(); }

  $("#prevDay").onclick = () => setDay(addDays(selected, -1));
  $("#nextDay").onclick = () => setDay(addDays(selected, 1));
  $("#todayBtn").onclick = () => setDay(todayStr());
  $("#datePicker").onchange = (e) => e.target.value && setDay(e.target.value);
  $("#weekStrip").onclick = (e) => { const b = e.target.closest("[data-day]"); if (b) setDay(b.dataset.day); };

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select, dialog")) return;
    if (e.key === "ArrowLeft") setDay(addDays(selected, -1));
    if (e.key === "ArrowRight") setDay(addDays(selected, 1));
    if (e.key === "t" || e.key === "T") setDay(todayStr());
  });

  // add todo
  const syncNoDue = () => { const off = $("#tNoDue").checked; $("#tDate").disabled = off; $("#tTime").disabled = off; };
  $("#tNoDue").onchange = syncNoDue;
  // the edit dialog's "no deadline" box shows/hides its date row
  $("#editBody").addEventListener("change", (e) => { if (e.target.id === "xNoDue") $("#xDueRow").hidden = e.target.checked; });
  $("#tDate").addEventListener("change", () => { $("#tDate").dataset.touched = "1"; });
  $("#todoForm").onsubmit = (e) => {
    e.preventDefault();
    const title = $("#tTitle").value.trim();
    const noDue = $("#tNoDue").checked;
    if (!title || (!noDue && !$("#tDate").value)) return;
    state.todos.push({
      id: uid(), title, due: noDue ? "" : `${$("#tDate").value}T${$("#tTime").value || "23:59"}`,
      prio: Number($("#tPrio").value), tag: $("#tTag").value.trim(),
      ...($("#tGoal").value ? { goal: $("#tGoal").value } : {}),
      done: false, doneAt: null, createdAt: new Date().toISOString(),
    });
    save();
    $("#tTitle").value = ""; $("#tTag").value = "";
    $("#tTitle").focus();
    render();
  };

  $("#todoGroups").addEventListener("click", (e) => {
    const t = e.target;
    const find = (id) => state.todos.find((x) => x.id === id);
    if (t.dataset.todoDone) {
      const td = find(t.dataset.todoDone);
      td.done = t.checked;
      // doneAt is stored as the local date-time so it groups by the day you ticked it
      const n = new Date();
      td.doneAt = td.done ? `${ymd(n)}T${pad(n.getHours())}:${pad(n.getMinutes())}` : null;
      markSlotsDone(td);
      save();
      const li = t.closest(".todo");
      li.classList.add("pop");
      setTimeout(render, 280);
    } else if (t.dataset.gotoDay) {
      setDay(t.dataset.gotoDay);
    } else if (t.dataset.subNew) {
      addingSubFor = t.dataset.subNew; renderTodos();
    } else if (t.dataset.subDone) {
      const [tid, sid] = t.dataset.subDone.split(":");
      const td = find(tid), sub = td && subs(td).find((x) => x.id === sid); if (!sub) return;
      sub.done = t.checked;
      if (subs(td).every((x) => x.done) && !td.done) {
        // last subtask ticked → the whole to-do is done
        const n = new Date();
        td.done = true; td.doneAt = `${ymd(n)}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
        if (addingSubFor === td.id) addingSubFor = null;
        toast(`小任务全部完成，「${td.title}」已自动勾选 🎉`, () => { const x = find(tid); if (x) { x.done = false; x.doneAt = null; } });
      } else if (!t.checked && td.done) { td.done = false; td.doneAt = null; }
      save(); render();
    } else if (t.dataset.subEdit) {
      const [tid, sid] = t.dataset.subEdit.split(":");
      renameSub(tid, sid);
    } else if (t.dataset.subDel) {
      const [tid, sid] = t.dataset.subDel.split(":");
      const td = find(tid); if (!td) return;
      const i = subs(td).findIndex((x) => x.id === sid); if (i < 0) return;
      const [gone] = td.subs.splice(i, 1);
      save(); render();
      toast(`已删除小任务「${gone.title}」`, () => { const x = find(tid); if (x) (x.subs ||= []).splice(i, 0, gone); });
    } else if (t.dataset.todoEdit) editTodo(find(t.dataset.todoEdit));
    else if (t.dataset.todoDel) {
      const td = find(t.dataset.todoDel);
      td.deletedAt = new Date().toISOString();
      save(); render();
      toast(`已把「${td.title}」放进垃圾箱`, () => applyTrash(`t:${td.id}`, "restore"));
    } else if (t.closest("[data-toggle-done]")) { doneCollapsed = !doneCollapsed; renderTodos(); }
  });

  // typing subtasks: Enter adds and keeps the box open, Esc / empty blur closes it
  $("#todoGroups").addEventListener("keydown", (e) => {
    const inp = e.target.closest("[data-sub-input]"); if (!inp) return;
    if (e.key === "Escape") { addingSubFor = null; renderTodos(); return; }
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    const title = inp.value.trim(); if (!title) return;
    const td = state.todos.find((x) => x.id === inp.dataset.subInput); if (!td) return;
    (td.subs ||= []).push({ id: uid(), title, done: false });
    if (td.done) { td.done = false; td.doneAt = null; } // a new step means it isn't finished
    inp.value = "";
    save(); render();
  });
  $("#todoGroups").addEventListener("focusout", (e) => {
    const inp = e.target.closest("[data-sub-input]");
    if (inp && !inp.value.trim()) setTimeout(() => { if (addingSubFor === inp.dataset.subInput && !$(`[data-sub-input]:focus`)) { addingSubFor = null; renderTodos(); } }, 150);
  });
  async function renameSub(tid, sid) {
    const sub = subs(state.todos.find((x) => x.id === tid) || {}).find((x) => x.id === sid); if (!sub) return;
    const r = await openDialog("改小任务", `<label>小任务<input type="text" id="sbTitle" value="${esc(sub.title)}" /></label>`, SAVE_BTNS);
    if (r !== "ok") return;
    const v = $("#sbTitle").value.trim();
    const cur = subs(state.todos.find((x) => x.id === tid) || {}).find((x) => x.id === sid);
    if (v && cur) { cur.title = v; save(); render(); }
  }

  $("#todoFilters").onclick = (e) => {
    const b = e.target.closest("[data-f]"); if (!b) return;
    filter = b.dataset.f;
    $("#todoFilters").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderTodos();
  };

  // notes & mood
  let saveTimer;
  $("#noteArea").addEventListener("input", (e) => {
    clearTimeout(saveTimer);
    const day = selected, val = e.target.value;
    saveTimer = setTimeout(() => {
      if (val.trim()) state.notes[day] = val; else delete state.notes[day];
      save();
      $("#savedHint").textContent = "已自动保存 ✓";
      setTimeout(() => ($("#savedHint").textContent = ""), 1500);
    }, 400);
  });
  $("#moods").onclick = (e) => {
    const b = e.target.closest("[data-mood]"); if (!b) return;
    if (state.moods[selected] === b.dataset.mood) delete state.moods[selected];
    else state.moods[selected] = b.dataset.mood;
    save(); renderNotes();
  };

  /* ---------- trash ---------- */
  const fmtDay = (day) => { const d = parseYmd(day); return `${d.getMonth() + 1}月${d.getDate()}日`; };
  const fmtWhen = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  function restoreSkip(ev, day) {
    ev.skip = (ev.skip || []).filter((d) => d !== day);
    if (ev.skipDeleted) { delete ev.skipDeleted[day]; if (!Object.keys(ev.skipDeleted).length) delete ev.skipDeleted; }
  }
  function dropSkipRecord(ev, day) { // forget the trash entry but keep the day hidden
    delete ev.skipDeleted[day];
    if (!Object.keys(ev.skipDeleted).length) delete ev.skipDeleted;
  }

  function trashEntries() {
    const out = [];
    for (const t of state.todos) if (t.deletedAt)
      out.push({ key: `t:${t.id}`, at: t.deletedAt, kind: "待办", title: t.title, sub: t.due ? `截止 ${t.due.replace("T", " ")}` : "没有截止日期" });
    for (const g of state.goals || []) if (g.deletedAt)
      out.push({ key: `g:${g.id}`, at: g.deletedAt, kind: "长期目标", title: `${g.emoji || "🌟"} ${g.title}`, sub: g.target ? `目标时间：${g.target}` : "长期目标" });
    for (const x of state.lists || []) if (x.deletedAt)
      out.push({ key: `l:${x.id}`, at: x.deletedAt, kind: window.Planner?.listLabel?.(x.type) || "清单",
        title: x.person ? `${x.person} · ${x.name}` : x.name, sub: x.date ? fmtDay(x.date) : "清单条目" });
    for (const e of state.events) {
      if (e.deletedAt) {
        out.push({ key: `e:${e.id}`, at: e.deletedAt, kind: "日程", title: e.title,
          sub: `${e.start}${e.end ? "–" + e.end : ""} · ${e.repeat && e.repeat !== "once" ? REPEAT_LABEL[e.repeat] : fmtDay(e.date)}` });
      } else for (const [day, at] of Object.entries(e.skipDeleted || {})) {
        out.push({ key: `s:${e.id}:${day}`, at, kind: "日程（单天）", title: e.title, sub: `${fmtDay(day)} 这一天 · ${e.start}` });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  function applyTrash(key, action) { // action: "restore" | "purge"
    const [k, id, day] = key.split(":");
    if (k === "g") {
      const g = state.goals.find((y) => y.id === id); if (!g) return;
      if (action === "restore") delete g.deletedAt; else state.goals = state.goals.filter((y) => y !== g);
    } else if (k === "l") {
      const x = state.lists.find((y) => y.id === id); if (!x) return;
      if (action === "restore") delete x.deletedAt; else state.lists = state.lists.filter((y) => y !== x);
    } else if (k === "t") {
      const t = state.todos.find((x) => x.id === id); if (!t) return;
      if (action === "restore") delete t.deletedAt; else state.todos = state.todos.filter((x) => x !== t);
    } else {
      const e = state.events.find((x) => x.id === id); if (!e) return;
      if (k === "e") { if (action === "restore") delete e.deletedAt; else state.events = state.events.filter((x) => x !== e); }
      else if (action === "restore") restoreSkip(e, day); else dropSkipRecord(e, day);
    }
  }

  // things that have sat in the trash for more than 30 days are removed for good
  function purgeOld() {
    const cutoff = new Date(Date.now() - TRASH_DAYS * 86400000).toISOString();
    const n = trashEntries().filter((x) => x.at < cutoff);
    n.forEach((x) => applyTrash(x.key, "purge"));
    return n.length;
  }

  function renderTrashCount() {
    const n = trashEntries().length;
    $("#trashCount").textContent = n ? ` ${n}` : "";
  }

  function trashHtml() {
    const list = trashEntries();
    if (!list.length) return `<p class="trash-empty">垃圾箱是空的 🍃</p>`;
    return `<p class="trash-hint">删除的内容会在这里保留 ${TRASH_DAYS} 天，之后自动清除。</p>
      <ul class="trash-list">${list.map((x) => `
        <li><div class="trash-main"><span class="trash-kind">${x.kind}</span> <b>${esc(x.title)}</b>
          <small>${esc(x.sub)} · 删除于 ${fmtWhen(x.at)}</small></div>
          <div class="trash-btns"><button type="button" class="ghost" data-restore="${esc(x.key)}">↩︎ 恢复</button>
          <button type="button" class="ghost danger" data-purge="${esc(x.key)}">彻底删除</button></div></li>`).join("")}
      </ul>`;
  }

  async function openTrash() {
    const body = $("#editBody");
    const onClick = (e) => {
      const b = e.target.closest("[data-restore],[data-purge]"); if (!b) return;
      if (b.dataset.purge && !confirm("彻底删除后就找不回来了，确定吗？")) return;
      applyTrash(b.dataset.restore || b.dataset.purge, b.dataset.restore ? "restore" : "purge");
      save(); render();
      body.innerHTML = trashHtml();
    };
    body.addEventListener("click", onClick);
    const has = trashEntries().length;
    const r = await openDialog("🗑 垃圾箱", trashHtml(), [
      ...(has ? [{ value: "empty", label: "清空垃圾箱", cls: "ghost danger" }] : []),
      { value: "close", label: "关闭", cls: "primary" },
    ]);
    body.removeEventListener("click", onClick);
    if (r === "empty" && trashEntries().length && confirm("清空后里面的内容就找不回来了，确定吗？")) {
      trashEntries().forEach((x) => applyTrash(x.key, "purge"));
      save(); render();
    }
  }
  $("#trashBtn").onclick = openTrash;

  // little "moved to trash · undo" bar
  let toastTimer;
  function toast(msg, undo) {
    let el = $("#toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
    el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button type="button">撤销</button>` : ""}`;
    el.classList.add("show");
    if (undo) el.querySelector("button").onclick = () => { undo(); save(); render(); el.classList.remove("show"); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 6000);
  }

  // backup / restore
  $("#exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `planner-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $("#importInput").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.events) || !Array.isArray(data.todos)) throw new Error("bad");
      if (!confirm("恢复备份会覆盖当前浏览器里的所有数据，确定吗？")) return;
      state = { ...blank(), ...data };
      save(); render();
      alert("恢复成功 ✓");
    } catch (_) {
      alert("文件格式不对，无法恢复。");
    } finally { e.target.value = ""; }
  };

  // keep "now" line & countdowns fresh; roll over at midnight
  let lastToday = todayStr();
  setInterval(() => {
    const t = todayStr();
    if (t !== lastToday && selected === lastToday) selected = t;
    lastToday = t;
    if (!$("#editDlg").open) { renderDate(); renderWeek(); renderSchedule(); renderTodos(); renderSummary(); }
  }, 30000);

  // bridge used by cloud.js
  window.Planner = {
    get: () => state,
    replace(next) {
      state = next ? { ...blank(), ...next } : blank();
      if (purgeOld()) save();
      render();
    },
    // data saved by the old browser-only version, merged into the account once on first sign-in
    legacy() { const s = load(); return s.todos.length || s.events.length || Object.keys(s.notes).length || Object.keys(s.moods).length ? s : null; },
    clearLegacy() { localStorage.removeItem(STORE_KEY); },
    dialog: openDialog,
    // used by lists.js
    commit() { save(); render(); },
    toast: (msg, undo) => toast(msg, undo),
    trash: (key, action) => applyTrash(key, action),
    deleteEvent: (ev) => deleteEvent(ev),
    renderHooks: [],
    selected: () => selected,
    setDay: (d) => setDay(d),
    profile: () => profile,
    setProfile(p) { profile = p; render(); },
    saveProfile(patch) {
      profile = { ...(profile || {}), ...patch };
      if (window.PlannerCloud?.saveProfile) window.PlannerCloud.saveProfile(patch); else render();
    },
    util: { liveGoals, leftText, fmtDue, DAY_START, lmin, evEnd, toMin, MOODS, esc, pad, ymd, parseYmd, addDays, uid, todayStr, WEEK, REPEAT_LABEL, eventsOn, isEventDone, liveTodos, dueDay, slotOf },
  };

  render();
})();
