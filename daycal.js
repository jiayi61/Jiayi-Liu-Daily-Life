/* Day calendar (05:00 → 05:00, Apple-Calendar style: tap/drag to create, drag to move, drag bottom edge to resize),
   schedule tags (categories) with role-based presets + onboarding, and the weekly "where did my time go" card. */
(() => {
  "use strict";
  const P = window.Planner;
  const { DAY_START, lmin, evEnd, esc, pad, ymd, parseYmd, addDays, uid, todayStr, WEEK, REPEAT_LABEL, eventsOn, isEventDone } = P.util;
  const $ = (s) => document.querySelector(s);

  /* ================= tags ================= */
  const PALETTE = ["#4a7bd0", "#e0719b", "#e2a33a", "#5aa36b", "#8a6bc0", "#e07b4a", "#4aa8b0", "#b0876a", "#c8654a", "#7d8a99"];
  const T = (id, emoji, label, color) => ({ id, emoji, label, color });
  const PRESETS = {
    student: { label: "🎒 学生", tags: [T("study", "📕", "学习", "#4a7bd0"), T("class", "🏫", "上课", "#4aa8b0"), T("exam", "✏️", "作业考试", "#8a6bc0"), T("sport", "💪", "运动", "#5aa36b"), T("social", "👫", "社交", "#e0719b"), T("hobby", "🎨", "兴趣", "#e07b4a"), T("fun", "🎮", "休闲", "#e2a33a"), T("life", "🛋", "日常", "#7d8a99")] },
    grad: { label: "🔬 研究生 / 科研", tags: [T("research", "🔬", "科研", "#4a7bd0"), T("writing", "📄", "论文写作", "#8a6bc0"), T("class", "🏫", "上课", "#4aa8b0"), T("meeting", "🤝", "组会 / 会议", "#e07b4a"), T("study", "📕", "学习", "#b0876a"), T("sport", "💪", "运动", "#5aa36b"), T("fun", "🎮", "休闲", "#e2a33a"), T("life", "🛋", "日常", "#7d8a99")] },
    work: { label: "💼 上班族", tags: [T("work", "💼", "工作", "#4a7bd0"), T("meeting", "🤝", "会议", "#e07b4a"), T("growth", "📈", "学习成长", "#8a6bc0"), T("commute", "🚇", "通勤", "#b0876a"), T("sport", "💪", "运动", "#5aa36b"), T("family", "👨‍👩‍👧", "家人朋友", "#e0719b"), T("fun", "🎮", "休闲", "#e2a33a"), T("life", "🛋", "日常", "#7d8a99")] },
    free: { label: "🎨 自由职业 / 创作者", tags: [T("create", "🎨", "创作", "#4a7bd0"), T("client", "💼", "客户项目", "#e07b4a"), T("promo", "📣", "运营推广", "#e0719b"), T("growth", "📈", "学习成长", "#8a6bc0"), T("sport", "💪", "运动", "#5aa36b"), T("social", "👫", "社交", "#4aa8b0"), T("fun", "🎮", "休闲", "#e2a33a"), T("life", "🛋", "日常", "#7d8a99")] },
    founder: { label: "🚀 创业", tags: [T("product", "🚀", "产品", "#4a7bd0"), T("meeting", "🤝", "会议", "#e07b4a"), T("sales", "💰", "销售 / 融资", "#e2a33a"), T("team", "👥", "团队", "#4aa8b0"), T("growth", "📈", "学习", "#8a6bc0"), T("sport", "💪", "运动", "#5aa36b"), T("family", "🏠", "家人", "#e0719b"), T("life", "🛋", "日常", "#7d8a99")] },
    other: { label: "🌱 其他", tags: [T("main", "📌", "正事", "#4a7bd0"), T("study", "📕", "学习", "#8a6bc0"), T("health", "💪", "健康", "#5aa36b"), T("social", "👫", "社交", "#e0719b"), T("fun", "🎮", "休闲", "#e2a33a"), T("life", "🛋", "日常", "#7d8a99")] },
  };
  const copyTags = (role) => PRESETS[role || "other"].tags.map((t) => ({ ...t }));
  const cats = () => P.profile()?.categories || copyTags("other");
  const NONE = { id: "", emoji: "▫️", label: "未分类", color: "#9a958c" };
  const catOf = (ev) => cats().find((c) => c.id === ev.cat) || (ev.cat ? NONE : { ...NONE, color: ev.color || NONE.color });

  /* ================= onboarding (asked once; cloud.js calls this) ================= */
  P.onboard = async (prof, googleName) => {
    const first = !prof?.nickname;
    const nick = prof?.nickname ?? (googleName || "").split(" ")[0];
    const body = $("#editBody");
    const roleChips = Object.entries(PRESETS).map(([k, v]) =>
      `<label class="pick"><input type="radio" name="obRole" value="${k}" ${prof?.role === k ? "checked" : ""} /><span>${v.label}</span></label>`).join("");
    const preview = () => {
      const r = body.querySelector('[name="obRole"]:checked')?.value;
      $("#obTags").innerHTML = r ? copyTags(r).map((t, i) => `<span class="tagchip" style="--c:${t.color}">${i + 1}. ${t.emoji} ${esc(t.label)}</span>`).join("")
        : `<span class="hint">选一个身份，我会推荐一组标签</span>`;
    };
    const onChange = (e) => { if (e.target.name === "obRole") preview(); };
    body.addEventListener("change", onChange);
    const p = P.dialog(first ? "欢迎！先认识一下你 👋" : "再多认识你一点 👋", `
      <label>希望我们怎么称呼你？<input type="text" id="pfNick" value="${esc(nick)}" placeholder="例如：小王" /></label>
      <div class="ob-label">你现在主要在做什么？</div>
      <div class="picks">${roleChips}</div>
      <div class="ob-label">推荐给你的日程标签 <small>按常用程度排好了</small></div>
      <div class="tagchips" id="obTags"></div>
      <p class="hint">之后可以在日程表上的「🏷 标签」里随时增删、改名、调顺序。</p>`,
      [{ value: "ok", label: "开始使用", cls: "primary" }]);
    preview();
    const r = await p;
    body.removeEventListener("change", onChange);
    if (r !== "ok") return null;
    const role = body.querySelector('[name="obRole"]:checked')?.value || "other";
    return { nickname: $("#pfNick").value.trim() || nick || "我", role, categories: copyTags(role) };
  };

  /* ================= tag manager ================= */
  async function manageTags() {
    let work = cats().map((c) => ({ ...c }));
    const body = $("#editBody");
    const read = () => body.querySelectorAll(".tm-row").forEach((row, i) => {
      work[i].emoji = row.querySelector("[data-k=emoji]").value.trim() || "•";
      work[i].label = row.querySelector("[data-k=label]").value.trim();
      work[i].color = row.querySelector("[data-k=color]").value;
    });
    const html = () => `
      <p class="hint">排在前面的标签，新建日程时会排在前面。删掉标签后，用过它的日程会显示为「未分类」。</p>
      <ul class="tm-list">${work.map((c, i) => `
        <li class="tm-row">
          <input data-k="emoji" value="${esc(c.emoji)}" maxlength="4" class="tm-emoji" aria-label="图标" />
          <input data-k="label" value="${esc(c.label)}" class="tm-label" aria-label="名字" />
          <input data-k="color" type="color" value="${c.color}" aria-label="颜色" />
          <button type="button" class="icon-btn" data-up="${i}" ${i ? "" : "disabled"} title="上移">↑</button>
          <button type="button" class="icon-btn" data-down="${i}" ${i < work.length - 1 ? "" : "disabled"} title="下移">↓</button>
          <button type="button" class="icon-btn" data-del="${i}" title="删除">✕</button>
        </li>`).join("")}</ul>
      <div class="tm-foot"><button type="button" class="ghost small" data-add>＋ 添加标签</button>
        <select id="tmPreset"><option value="">按身份重新推荐…</option>${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></div>`;
    const redraw = () => { body.innerHTML = html(); };
    const onClick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      read();
      const i = +(b.dataset.up ?? b.dataset.down ?? b.dataset.del);
      if (b.dataset.up) [work[i - 1], work[i]] = [work[i], work[i - 1]];
      else if (b.dataset.down) [work[i + 1], work[i]] = [work[i], work[i + 1]];
      else if (b.dataset.del) work.splice(i, 1);
      else if (b.hasAttribute("data-add")) work.push({ id: uid(), emoji: "📌", label: "", color: PALETTE[work.length % PALETTE.length] });
      else return;
      redraw();
      if (b.hasAttribute("data-add")) body.querySelector(".tm-row:last-child .tm-label")?.focus();
    };
    const onChange = (e) => {
      if (e.target.id !== "tmPreset" || !e.target.value) return;
      if (!confirm("用推荐的标签替换现在这一组吗？（已有日程里同名的标签会保留）")) { e.target.value = ""; return; }
      work = copyTags(e.target.value); redraw();
    };
    body.addEventListener("click", onClick);
    body.addEventListener("change", onChange);
    const r = await P.dialog("🏷 日程标签", html(), [{ value: "cancel", label: "取消" }, { value: "ok", label: "保存", cls: "primary" }]);
    body.removeEventListener("click", onClick);
    body.removeEventListener("change", onChange);
    if (r !== "ok") return;
    read();
    work = work.filter((c) => c.label);
    if (!work.length) return;
    P.saveProfile({ categories: work });
  }
  $("#tagsBtn").onclick = manageTags;

  /* ================= event dialog (new / edit) ================= */
  const hm = (m) => { m = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const fmtRange = (s, e) => `${hm(s)}${e != null ? ` – ${hm(e)}` : ""}${e != null && e > 1440 && s < 1440 ? "（次日）" : ""}`;

  async function eventDialog(ev, preset) {
    const isNew = !ev;
    const d = ev || { title: "", start: hm(preset.s), end: hm(preset.e), note: "", repeat: "once", cat: cats()[0]?.id || "" };
    const catPicks = [...cats(), ...(d.cat && !cats().some((c) => c.id === d.cat) ? [NONE] : [])].map((c) =>
      `<label class="pick" style="--c:${c.color}"><input type="radio" name="eCat" value="${esc(c.id)}" ${c.id === (cats().some((x) => x.id === d.cat) ? d.cat : "") ? "checked" : ""} /><span>${c.emoji} ${esc(c.label)}</span></label>`).join("");
    const reps = ["once", "daily", "weekdays", "weekly"].map((v) => `<option value="${v}" ${d.repeat === v ? "selected" : ""}>${{ once: "仅这一天", ...REPEAT_LABEL }[v]}</option>`).join("");
    const btns = isNew ? [{ value: "cancel", label: "取消" }, { value: "ok", label: "添加", cls: "primary" }]
      : [{ value: "delete", label: "删除", cls: "ghost danger" }, { value: "cancel", label: "取消" }, { value: "ok", label: "保存", cls: "primary" }];
    const p = P.dialog(isNew ? "新日程" : "编辑日程", `
      <label>做什么？<input type="text" id="eTitle" value="${esc(d.title)}" placeholder="例如：图书馆自习" /></label>
      <div class="ob-label">标签</div>
      <div class="picks">${catPicks}</div>
      <div class="two"><label>开始<input type="time" id="eStart" value="${d.start}" /></label>
      <label>结束<input type="time" id="eEnd" value="${d.end || ""}" /></label></div>
      <p class="hint">一天从早上 5:00 到第二天凌晨 5:00，凌晨的时间也记在这一页。</p>
      <div class="two"><label>重复<select id="eRepeat">${reps}</select></label>
      <label>地点 / 备注<input type="text" id="eNote" value="${esc(d.note)}" placeholder="可不填" /></label></div>`, btns);
    if (isNew) setTimeout(() => $("#eTitle").focus(), 30);
    const r = await p;
    if (r === "delete") { const cur = P.get().events.find((x) => x.id === ev.id); if (cur) P.deleteEvent(cur); return; }
    if (r !== "ok") return;
    const title = $("#eTitle").value.trim(), start = $("#eStart").value;
    if (!title || !start) return;
    // no tag picked (e.g. an older event) → keep what it had
    const cat = document.querySelector('[name="eCat"]:checked')?.value ?? d.cat ?? "";
    const vals = { title, start, end: $("#eEnd").value, note: $("#eNote").value.trim(), repeat: $("#eRepeat").value, cat,
      color: cats().find((c) => c.id === cat)?.color || d.color || NONE.color };
    const s = P.get();
    if (isNew) s.events.push({ id: uid(), ...vals, date: P.selected(), skip: [], doneOn: [] });
    else {
      const cur = s.events.find((x) => x.id === ev.id); if (!cur) return;
      Object.assign(cur, vals);
      if (cur.repeat === "once") cur.date = P.selected();
    }
    P.commit();
  }
  $("#newEvBtn").onclick = () => {
    const now = todayStr() === P.selected() ? Math.ceil(lmin(hm(new Date().getHours() * 60 + new Date().getMinutes())) / 30) * 30 : 9 * 60;
    const s = Math.min(Math.max(now, DAY_START), DAY_START + 1440 - 60);
    eventDialog(null, { s, e: s + 60 });
  };

  /* ================= day grid ================= */
  const H = 48;                       // px per hour
  const PX = H / 60;                  // px per minute
  const END = DAY_START + 1440;       // 05:00 next morning
  const SNAP = 15;
  const snap = (m) => Math.round(m / SNAP) * SNAP;
  const box = $("#dayCal");
  let drag = null;          // active pointer interaction
  let pendingRender = false;
  let scrolledFor = null;   // day we last auto-scrolled for

  // side-by-side columns for overlapping events
  function layout(list) {
    const items = list.map((ev) => {
      const s = lmin(ev.start), e = Math.min(evEnd(ev) ?? s + 30, END);
      return { ev, s, e: Math.max(e, s + 15) };
    }).sort((a, b) => a.s - b.s || b.e - a.e);
    let cluster = [], clusterEnd = -1;
    const flush = () => { const n = Math.max(...cluster.map((x) => x.col)) + 1; cluster.forEach((x) => (x.n = n)); cluster = []; };
    for (const it of items) {
      if (cluster.length && it.s >= clusterEnd) flush();
      const cols = [];
      cluster.forEach((x) => { if (x.e > it.s) cols[x.col] = true; });
      it.col = cols.findIndex((v) => !v); if (it.col < 0) it.col = cols.length;
      cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
    }
    if (cluster.length) flush();
    return items;
  }

  function hourLabel(h) {
    const hh = h % 24;
    return hh === 0 ? "0:00<small>次日</small>" : `${hh}:00`;
  }

  function renderDay(day) {
    if (drag?.active) { pendingRender = true; return; }
    const scroller = box.querySelector(".dc-scroll");
    const keep = scroller ? scroller.scrollTop : null;
    const items = layout(eventsOn(day));
    const isToday = day === todayStr();
    const now = new Date();
    const nowM = lmin(hm(now.getHours() * 60 + now.getMinutes()));
    let html = `<div class="dc-scroll"><div class="dc-grid" style="height:${24 * H}px">`;
    for (let h = 5; h < 29; h++) html += `<div class="dc-hour" style="top:${(h * 60 - DAY_START) * PX}px"><span>${hourLabel(h)}</span></div>`;
    html += `<div class="dc-lane">`;
    for (const it of items) {
      const { ev } = it, c = catOf(ev), done = isEventDone(ev, day);
      const h = (it.e - it.s) * PX;
      const past = isToday ? it.e <= nowM : day < todayStr();
      html += `<div class="dc-ev ${done ? "done" : ""} ${past ? "past" : ""} ${h < 34 ? "tiny" : ""}" data-id="${ev.id}"
          style="top:${(it.s - DAY_START) * PX}px;height:${h - 2}px;left:calc(${(it.col / it.n) * 100}% + 1px);width:calc(${100 / it.n}% - 3px);--c:${c.color}">
        <input type="checkbox" class="dc-chk" data-done="${ev.id}" ${done ? "checked" : ""} aria-label="完成" />
        <div class="dc-t">${esc(ev.title)}</div>
        <div class="dc-m"><span class="dc-time">${fmtRange(it.s, evEnd(ev))}</span>${ev.note ? ` · ${esc(ev.note)}` : ""}${ev.repeat && ev.repeat !== "once" ? " ↻" : ""}</div>
        <div class="dc-resize"></div>
      </div>`;
    }
    html += `</div>`;
    if (isToday) html += `<div class="dc-now" style="top:${(nowM - DAY_START) * PX}px"></div>`;
    html += `</div></div>`;
    box.innerHTML = html;
    const sc = box.querySelector(".dc-scroll");
    if (scrolledFor !== day) {
      scrolledFor = day;
      const first = items[0]?.s;
      const target = isToday ? nowM - 90 : first != null ? first - 30 : 7 * 60;
      sc.scrollTop = Math.max(0, (target - DAY_START) * PX);
    } else if (keep != null) sc.scrollTop = keep;
    renderTime();
  }
  P.renderDay = renderDay;

  const minuteAt = (clientY) => {
    const g = box.querySelector(".dc-grid").getBoundingClientRect();
    return DAY_START + (clientY - g.top) / PX;
  };

  box.addEventListener("click", (e) => {
    const chk = e.target.closest("[data-done]");
    if (chk) {
      const ev = P.get().events.find((x) => x.id === chk.dataset.done); if (!ev) return;
      const day = P.selected();
      ev.doneOn = chk.checked ? [...new Set([...(ev.doneOn || []), day])] : (ev.doneOn || []).filter((d) => d !== day);
      P.commit();
    }
  });

  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("[data-done]")) return;
    const el = e.target.closest(".dc-ev");
    const touch = e.pointerType !== "mouse";
    if (!el) {
      if (touch) return; // taps on empty space are handled by "click" below (keeps native scrolling)
      if (!e.target.closest(".dc-grid")) return;
      const m = snap(minuteAt(e.clientY));
      drag = { mode: "create", a: m, b: m + 60, y0: e.clientY, active: false, id: e.pointerId };
      try { box.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
      e.preventDefault();
      return;
    }
    const ev = P.get().events.find((x) => x.id === el.dataset.id); if (!ev) return;
    const s = lmin(ev.start), en = evEnd(ev);
    drag = { mode: e.target.closest(".dc-resize") ? "resize" : "move", el, ev, s, e: en ?? s + 30, hadEnd: en != null,
      y0: e.clientY, active: false, touch, id: e.pointerId, lastY: e.clientY };
    if (touch) {
      drag.timer = setTimeout(() => { if (drag && !drag.cancelled) { drag.active = true; el.classList.add("dragging"); navigator.vibrate?.(10); } }, 350);
    }
    try { box.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
  });

  box.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (drag.touch && !drag.active) {
      // finger moved before the long-press: treat it as scrolling
      if (Math.abs(dy) > 6) { drag.cancelled = true; clearTimeout(drag.timer); }
      if (drag.cancelled) { box.querySelector(".dc-scroll").scrollTop -= e.clientY - drag.lastY; drag.lastY = e.clientY; }
      return;
    }
    if (!drag.active) { if (Math.abs(dy) < 4) return; drag.active = true; drag.el?.classList.add("dragging"); }
    e.preventDefault();
    const dm = snap(dy / PX);
    if (drag.mode === "create") {
      const m = snap(minuteAt(e.clientY));
      drag.lo = Math.max(DAY_START, Math.min(drag.a, m)); drag.hi = Math.min(END, Math.max(drag.a + SNAP, m));
      let g = box.querySelector(".dc-ghost");
      if (!g) { g = document.createElement("div"); g.className = "dc-ghost"; box.querySelector(".dc-lane").appendChild(g); }
      g.style.top = `${(drag.lo - DAY_START) * PX}px`; g.style.height = `${(drag.hi - drag.lo) * PX}px`;
      g.textContent = fmtRange(drag.lo, drag.hi);
      return;
    }
    let ns = drag.s, ne = drag.e;
    if (drag.mode === "move") { const len = drag.e - drag.s; ns = Math.max(DAY_START, Math.min(END - len, drag.s + dm)); ne = ns + len; }
    else ne = Math.max(drag.s + SNAP, Math.min(END, drag.e + dm));
    drag.ns = ns; drag.ne = ne;
    drag.el.style.top = `${(ns - DAY_START) * PX}px`;
    drag.el.style.height = `${(ne - ns) * PX - 2}px`;
    drag.el.querySelector(".dc-time").textContent = fmtRange(ns, ne);
    // keep the dragged block in view
    const sc = box.querySelector(".dc-scroll"), r = sc.getBoundingClientRect();
    if (e.clientY < r.top + 30) sc.scrollTop -= 12; else if (e.clientY > r.bottom - 30) sc.scrollTop += 12;
  });

  const endDrag = async (e, cancelled) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    clearTimeout(d.timer);
    d.el?.classList.remove("dragging");
    if (cancelled) { renderDay(P.selected()); return; }
    if (d.mode === "create") {
      box.querySelector(".dc-ghost")?.remove();
      if (d.active) eventDialog(null, { s: d.lo, e: d.hi });
      else { const m = Math.min(Math.max(Math.floor(d.a / 30) * 30, DAY_START), END - 60); eventDialog(null, { s: m, e: m + 60 }); }
      return;
    }
    if (!d.active) { if (!d.cancelled) eventDialog(d.ev); return; }
    if (d.ns == null || (d.ns === d.s && d.ne === d.e)) { renderDay(P.selected()); return; }
    await applyTimes(d.ev, d.ns, d.mode === "resize" || d.hadEnd ? d.ne : null);
    if (pendingRender) pendingRender = false;
    renderDay(P.selected());
  };
  box.addEventListener("pointerup", (e) => endDrag(e, false));
  box.addEventListener("pointercancel", (e) => endDrag(e, true));

  // touch: tap on an empty slot → new event there
  box.addEventListener("click", (e) => {
    if (e.target.closest(".dc-ev") || !e.target.closest(".dc-grid") || e.pointerType === "mouse" || matchMedia("(hover: hover)").matches) return;
    const m = Math.min(Math.max(Math.floor(minuteAt(e.clientY) / 30) * 30, DAY_START), END - 60);
    eventDialog(null, { s: m, e: m + 60 });
  });

  async function applyTimes(ev, ns, ne) {
    const s = P.get(), day = P.selected();
    const cur = s.events.find((x) => x.id === ev.id); if (!cur) return;
    const times = { start: hm(ns), end: ne == null ? cur.end : hm(ne) };
    if (cur.repeat && cur.repeat !== "once") {
      const r = await P.dialog("修改重复日程", `<p>「${esc(cur.title)}」是重复日程，要改哪些？</p>`, [
        { value: "cancel", label: "取消" }, { value: "one", label: "只改这一天" }, { value: "all", label: "所有重复都改", cls: "primary" }]);
      if (r === "one") {
        (cur.skip ||= []).push(day);
        const { id, skip, skipDeleted, doneOn, ...rest } = cur;
        s.events.push({ ...rest, ...times, id: uid(), repeat: "once", date: day, skip: [], doneOn: (doneOn || []).includes(day) ? [day] : [] });
      } else if (r === "all") Object.assign(cur, times);
      else return;
    } else Object.assign(cur, times);
    P.commit();
  }

  /* ================= weekly time ================= */
  const weekStart = (day) => addDays(day, -((parseYmd(day).getDay() + 6) % 7));
  function timeBy(from, to) {
    const map = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      for (const ev of eventsOn(d)) {
        const e = evEnd(ev); if (e == null) continue;
        const mins = Math.min(e, END) - lmin(ev.start); if (mins <= 0) continue;
        const c = catOf(ev);
        const key = c.id || `none`;
        const row = map.get(key) || { c, plan: 0, done: 0 };
        row.plan += mins; if (isEventDone(ev, d)) row.done += mins;
        map.set(key, row);
      }
    }
    return map;
  }
  const hrs = (m) => { const h = m / 60; return h === 0 ? "0" : h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h) + ""; };

  function renderTime() {
    const day = P.selected(), from = weekStart(day), to = addDays(from, 6);
    const cur = timeBy(from, to), prev = timeBy(addDays(from, -7), addDays(from, -1));
    $("#tcRange").textContent = `${+from.slice(5, 7)}/${+from.slice(8)} – ${+to.slice(5, 7)}/${+to.slice(8)}`;
    const order = [...cats().map((c) => c.id), "none"];
    const rows = [...cur.values()].sort((a, b) => b.done - a.done || order.indexOf(a.c.id || "none") - order.indexOf(b.c.id || "none"));
    if (!rows.length) { $("#timeStats").innerHTML = `<p class="empty">这周还没有带时间的日程。给日程打勾 ✅，这里就会统计你的时间花在了哪里。</p>`; return; }
    const plan = rows.reduce((a, r) => a + r.plan, 0), done = rows.reduce((a, r) => a + r.done, 0);
    const max = Math.max(...rows.map((r) => r.plan));
    $("#timeStats").innerHTML = `
      <div class="tc-total"><div><b>${hrs(done)}</b><span>小时 · 已完成</span></div><div><b>${hrs(plan)}</b><span>小时 · 计划</span></div><div><b>${plan ? Math.round((done / plan) * 100) : 0}%</b><span>完成率</span></div></div>
      <ul class="tc-rows">${rows.map((r) => {
        const p = prev.get(r.c.id || "none")?.done || 0, diff = r.done - p;
        return `<li style="--c:${r.c.color}">
          <span class="tc-name">${r.c.emoji} ${esc(r.c.label)}</span>
          <span class="tc-bar"><i class="plan" style="width:${(r.plan / max) * 100}%"></i><i class="done" style="width:${(r.done / max) * 100}%"></i></span>
          <span class="tc-num"><b>${hrs(r.done)}h</b> / ${hrs(r.plan)}h${diff ? `<em class="${diff > 0 ? "up" : "down"}">${diff > 0 ? "↑" : "↓"}${hrs(Math.abs(diff))}</em>` : ""}</span>
        </li>`;
      }).join("")}</ul>
      <p class="tc-note">只统计打了勾 ✅ 的日程；浅色是计划的时长。箭头是和上周比。</p>`;
  }

  // for the weekly AI pack (lists.js)
  P.timeSummary = (from, to) => {
    const rows = [...timeBy(from, to).values()].sort((a, b) => b.done - a.done);
    if (!rows.length) return [];
    const plan = rows.reduce((a, r) => a + r.plan, 0), done = rows.reduce((a, r) => a + r.done, 0);
    return [`【时间都花在哪了】（只算打了勾的；括号里是原本计划的）共完成 ${hrs(done)} 小时，计划 ${hrs(plan)} 小时`,
      ...rows.map((r) => `- ${r.c.emoji}${r.c.label}：${hrs(r.done)} 小时（计划 ${hrs(r.plan)}）`)];
  };
  P.tagPresets = PRESETS;

  renderDay(P.selected());
})();
