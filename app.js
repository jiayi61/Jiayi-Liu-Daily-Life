/* Daily Planner — UI and state; cloud.js syncs it to Firestore */
(() => {
  "use strict";

  const STORE_KEY = "jiayi-planner-v1";
  const COLORS = ["#c8654a", "#d9a23b", "#5f8f6b", "#5b86b0", "#8a6bb0", "#b5657f"];
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
  const todayStr = () => ymd(new Date());
  const TRASH_DAYS = 30;

  /* ---------- state ---------- */
  const blank = () => ({ version: 1, events: [], todos: [], notes: {}, moods: {} });
  let state = blank(); // filled in by cloud.js after sign-in
  let selected = todayStr();
  let filter = "all";
  let doneCollapsed = true;
  let pickedColor = COLORS[0];
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
  function save() {
    if (window.PlannerCloud) window.PlannerCloud.queue();
  }

  /* ---------- schedule logic ---------- */
  function occursOn(ev, day) {
    if ((ev.skip || []).includes(day)) return false;
    if (ev.repeat === "once" || !ev.repeat) return ev.date === day;
    if (day < ev.date) return false;
    const dow = parseYmd(day).getDay();
    if (ev.repeat === "daily") return true;
    if (ev.repeat === "weekdays") return dow >= 1 && dow <= 5;
    if (ev.repeat === "weekly") return dow === parseYmd(ev.date).getDay();
    return false;
  }
  const eventsOn = (day) =>
    liveEvents().filter((e) => occursOn(e, day)).sort((a, b) => toMin(a.start) - toMin(b.start) || (toMin(a.end) ?? 0) - (toMin(b.end) ?? 0));
  const isEventDone = (ev, day) => (ev.doneOn || []).includes(day);

  /* ---------- todo logic ---------- */
  const dueDate = (t) => new Date(t.due);
  const dueDay = (t) => t.due.slice(0, 10);

  function leftText(t) {
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

  function renderSchedule() {
    const list = eventsOn(selected);
    const isToday = selected === todayStr();
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const isPastDay = selected < todayStr();
    let html = "";
    let nowLineDrawn = !isToday;

    list.forEach((ev) => {
      const s = toMin(ev.start), e = toMin(ev.end) ?? s;
      if (!nowLineDrawn && s > nowMin) {
        html += `<li class="now-line" data-t="${pad(now.getHours())}:${pad(now.getMinutes())}"></li>`;
        nowLineDrawn = true;
      }
      const done = isEventDone(ev, selected);
      const current = isToday && nowMin >= s && nowMin < Math.max(e, s + 1);
      const past = isPastDay || (isToday && nowMin >= Math.max(e, s + 1));
      html += `<li class="tl-item ${current ? "now" : ""} ${past ? "past" : ""} ${done ? "done" : ""}" style="--c:${ev.color}">
        <div class="tl-time">${ev.start}${ev.end ? `<small>${ev.end}</small>` : ""}</div>
        <div class="tl-dot" style="background:${ev.color}"></div>
        <div class="tl-body">
          <input type="checkbox" class="chk" data-ev-done="${ev.id}" ${done ? "checked" : ""} aria-label="完成" />
          <div class="txt">
            <div class="ttl">${esc(ev.title)}<span class="badge-now">进行中</span></div>
            <div class="meta">${ev.end ? `${ev.start} – ${ev.end}` : ev.start}${ev.note ? " · " + esc(ev.note) : ""}${ev.repeat && ev.repeat !== "once" ? `<span class="rep">↻ ${REPEAT_LABEL[ev.repeat]}</span>` : ""}</div>
          </div>
          <button class="icon-btn" data-ev-edit="${ev.id}" title="编辑">✎</button>
          <button class="icon-btn" data-ev-del="${ev.id}" title="删除">✕</button>
        </div>
      </li>`;
    });
    if (!nowLineDrawn && list.length) html += `<li class="now-line" data-t="${pad(now.getHours())}:${pad(now.getMinutes())}"></li>`;
    $("#timeline").innerHTML = html;
    $("#schedEmpty").hidden = list.length > 0;
  }

  function todoItem(t) {
    const left = t.done ? null : leftText(t);
    return `<li class="todo ${t.done ? "is-done" : ""}" data-id="${t.id}">
      <input type="checkbox" class="chk" data-todo-done="${t.id}" ${t.done ? "checked" : ""} aria-label="完成" />
      <span class="prio p${t.prio}"></span>
      <div class="txt">
        <div class="ttl">${esc(t.title)}</div>
        <div class="meta">
          <span class="due">⏰ ${fmtDue(t)}</span>
          ${left ? `<span class="left ${left.cls}">${left.text}</span>` : ""}
          ${t.tag ? `<span class="tag"># ${esc(t.tag)}</span>` : ""}
        </div>
      </div>
      <button class="icon-btn" data-todo-edit="${t.id}" title="编辑">✎</button>
      <button class="icon-btn" data-todo-del="${t.id}" title="删除">✕</button>
    </li>`;
  }

  function renderTodos() {
    const now = Date.now();
    const byDue = (a, b) => dueDate(a) - dueDate(b) || b.prio - a.prio;
    const open = liveTodos().filter((t) => !t.done);
    const over = open.filter((t) => dueDate(t) < now).sort(byDue);
    const onDay = open.filter((t) => dueDay(t) === selected && dueDate(t) >= now).sort(byDue);
    const later = open.filter((t) => dueDay(t) !== selected && dueDate(t) >= now).sort(byDue);
    const done = liveTodos()
      .filter((t) => t.done && ((t.doneAt || "").slice(0, 10) === selected || dueDay(t) === selected))
      .sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));

    const groups = filter === "day"
      ? [
          ["over", "⚠️ 逾期（当天）", over.filter((t) => dueDay(t) === selected)],
          ["today", "📌 当天截止", onDay],
          ["done", "✔️ 已完成", done.filter((t) => dueDay(t) === selected)],
        ]
      : [
          ["over", "⚠️ 已逾期", over],
          ["today", selected === todayStr() ? "📌 今天截止" : "📌 当天截止", onDay],
          ["later", "🗓 即将到来", later],
          ["done", "✔️ 当天完成", done],
        ];

    let html = "", count = 0;
    for (const [cls, label, items] of groups) {
      if (!items.length) continue;
      count += items.length;
      const collapsed = cls === "done" && doneCollapsed ? "collapsed" : "";
      html += `<div class="group ${cls} ${collapsed}">
        <div class="group-h" ${cls === "done" ? 'data-toggle-done="1"' : ""}>${label} <span class="n">${items.length}</span>${cls === "done" ? (doneCollapsed ? " ▸" : " ▾") : ""}</div>
        <ul>${items.map(todoItem).join("")}</ul></div>`;
    }
    $("#todoGroups").innerHTML = html;
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
    $("#statOver").textContent = liveTodos().filter((t) => !t.done && dueDate(t) < Date.now()).length;
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

  async function editEvent(ev) {
    const opts = ["once", "daily", "weekdays", "weekly"]
      .map((v) => `<option value="${v}" ${ev.repeat === v ? "selected" : ""}>${{ once: "仅这一天", ...REPEAT_LABEL }[v]}</option>`).join("");
    const r = await openDialog("编辑日程", `
      <label>标题<input type="text" id="eTitle" value="${esc(ev.title)}" /></label>
      <div class="two"><label>开始<input type="time" id="eStart" value="${ev.start}" /></label>
      <label>结束<input type="time" id="eEnd" value="${ev.end || ""}" /></label></div>
      <label>备注<input type="text" id="eNote" value="${esc(ev.note)}" /></label>
      <label>重复<select id="eRepeat">${opts}</select></label>`, SAVE_BTNS);
    if (r !== "ok") return;
    const title = $("#eTitle").value.trim();
    if (!title || !$("#eStart").value) return;
    ev = state.events.find((x) => x.id === ev.id);
    if (!ev) return;
    Object.assign(ev, { title, start: $("#eStart").value, end: $("#eEnd").value, note: $("#eNote").value.trim(), repeat: $("#eRepeat").value });
    if (ev.repeat === "once") ev.date = selected;
    save(); render();
  }

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

  async function editTodo(t) {
    const r = await openDialog("编辑待办", `
      <label>内容<input type="text" id="xTitle" value="${esc(t.title)}" /></label>
      <div class="two"><label>截止日期<input type="date" id="xDate" value="${dueDay(t)}" /></label>
      <label>时间<input type="time" id="xTime" value="${t.due.slice(11, 16)}" /></label></div>
      <div class="two"><label>优先级<select id="xPrio">
        <option value="2" ${t.prio == 2 ? "selected" : ""}>🔴 重要</option>
        <option value="1" ${t.prio == 1 ? "selected" : ""}>🟡 普通</option>
        <option value="0" ${t.prio == 0 ? "selected" : ""}>🟢 随意</option></select></label>
      <label>标签<input type="text" id="xTag" value="${esc(t.tag)}" /></label></div>`, SAVE_BTNS);
    if (r !== "ok") return;
    const title = $("#xTitle").value.trim();
    if (!title || !$("#xDate").value) return;
    t = state.todos.find((x) => x.id === t.id);
    if (!t) return;
    Object.assign(t, { title, due: `${$("#xDate").value}T${$("#xTime").value || "23:59"}`, prio: Number($("#xPrio").value), tag: $("#xTag").value.trim() });
    save(); render();
  }

  /* ---------- events ---------- */
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

  // color picker
  $("#sColors").innerHTML = COLORS.map((c) => `<button type="button" data-color="${c}" style="background:${c}" class="${c === pickedColor ? "on" : ""}" aria-label="颜色"></button>`).join("");
  $("#sColors").onclick = (e) => {
    const b = e.target.closest("[data-color]"); if (!b) return;
    pickedColor = b.dataset.color;
    $("#sColors").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  };

  // add schedule
  $("#schedForm").onsubmit = (e) => {
    e.preventDefault();
    const title = $("#sTitle").value.trim();
    if (!title) return;
    let start = $("#sStart").value, end = $("#sEnd").value;
    if (end && toMin(end) < toMin(start)) [start, end] = [end, start];
    state.events.push({
      id: uid(), title, start, end, note: $("#sNote").value.trim(), color: pickedColor,
      repeat: $("#sRepeat").value, date: selected, skip: [], doneOn: [],
    });
    save();
    // next slot suggestion
    if (end) {
      $("#sStart").value = end;
      const m = Math.min(toMin(end) + 60, 23 * 60 + 59);
      $("#sEnd").value = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    }
    $("#sTitle").value = ""; $("#sNote").value = "";
    $("#sTitle").focus();
    render();
  };

  $("#timeline").addEventListener("click", (e) => {
    const t = e.target;
    const find = (id) => state.events.find((x) => x.id === id);
    if (t.dataset.evDone) {
      const ev = find(t.dataset.evDone);
      ev.doneOn ||= [];
      ev.doneOn = t.checked ? [...ev.doneOn, selected] : ev.doneOn.filter((d) => d !== selected);
      save(); render();
    } else if (t.dataset.evEdit) editEvent(find(t.dataset.evEdit));
    else if (t.dataset.evDel) deleteEvent(find(t.dataset.evDel));
  });

  // add todo
  $("#tDate").addEventListener("change", () => { $("#tDate").dataset.touched = "1"; });
  $("#todoForm").onsubmit = (e) => {
    e.preventDefault();
    const title = $("#tTitle").value.trim();
    if (!title || !$("#tDate").value) return;
    state.todos.push({
      id: uid(), title, due: `${$("#tDate").value}T${$("#tTime").value || "23:59"}`,
      prio: Number($("#tPrio").value), tag: $("#tTag").value.trim(),
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
      save();
      const li = t.closest(".todo");
      li.classList.add("pop");
      setTimeout(render, 280);
    } else if (t.dataset.todoEdit) editTodo(find(t.dataset.todoEdit));
    else if (t.dataset.todoDel) {
      const td = find(t.dataset.todoDel);
      td.deletedAt = new Date().toISOString();
      save(); render();
      toast(`已把「${td.title}」放进垃圾箱`, () => applyTrash(`t:${td.id}`, "restore"));
    } else if (t.closest("[data-toggle-done]")) { doneCollapsed = !doneCollapsed; renderTodos(); }
  });

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
      out.push({ key: `t:${t.id}`, at: t.deletedAt, kind: "待办", title: t.title, sub: `截止 ${t.due.replace("T", " ")}` });
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
    if (k === "t") {
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
  };

  render();
})();
