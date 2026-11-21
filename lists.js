/* Lists side drawer (movies, restaurants, gifts…) + weekly "AI review pack":
   copy the week as plain text → chat with any AI → paste its reply back → confirm items into lists. */
(() => {
  "use strict";
  const P = window.Planner;
  const { esc, pad, ymd, parseYmd, addDays, uid, todayStr, WEEK, eventsOn, isEventDone, liveTodos, dueDay } = P.util;
  const $ = (s) => document.querySelector(s);

  /* ---------- list kinds ---------- */
  const NAME = ["name", "名字"], DATE = ["date", "日期"], NOTE = ["note", "备注"];
  const BUILTIN = [
    { id: "movie", label: "电影", icon: "🎬", aliases: ["影视", "电视剧", "剧", "纪录片", "影片"], cols: [NAME, DATE, NOTE] },
    { id: "book", label: "书", icon: "📖", aliases: ["书籍", "读书", "阅读", "书单"], cols: [NAME, DATE, NOTE] },
    { id: "restaurant", label: "餐厅", icon: "🍜", aliases: ["美食", "饭店", "餐馆", "咖啡馆", "探店"], cols: [NAME, DATE, ["city", "城市"], NOTE] },
    { id: "gift", label: "礼物", icon: "🎁", aliases: ["送礼"], cols: [["person", "送给谁 / 谁送的"], ["name", "东西"], DATE, ["occasion", "场合"]] },
    { id: "city", label: "城市", icon: "🧳", aliases: ["旅行", "旅游", "去过的城市"], cols: [["name", "城市名"], DATE, NOTE] },
  ];
  const custom = () => (P.get().listTypes || []).map((t) => ({ ...t, icon: t.icon || "📌", aliases: [], cols: [NAME, DATE, NOTE] }));
  const types = () => [...BUILTIN, ...custom()];
  const typeOf = (id) => types().find((t) => t.id === id);
  const findType = (tag) => {
    const k = tag.trim().toLowerCase();
    return types().find((t) => t.label.toLowerCase() === k || t.aliases.some((a) => a.toLowerCase() === k));
  };
  P.listLabel = (id) => typeOf(id)?.label;

  const items = () => (P.get().lists || []).filter((x) => !x.deletedAt);
  const itemsOf = (type) => items().filter((x) => x.type === type)
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || "").localeCompare(a.createdAt || ""));
  const titleOf = (x) => (x.person ? `${x.person} · ${x.name}` : x.name);
  const fmtDay = (day) => { const d = parseYmd(day); return `${d.getMonth() + 1}月${d.getDate()}日`; };
  const subOf = (x) => [x.date && fmtDay(x.date), x.city, x.occasion, x.note].filter(Boolean).join(" · ");

  // same thing already in the list? (name compared loosely; dates only when both have one)
  const norm = (s) => String(s || "").replace(/[《》「」"“”'‘’\s]/g, "").toLowerCase();
  const sameItem = (a, b) => a.type === b.type && norm(a.name) === norm(b.name) && norm(a.person) === norm(b.person)
    && (!a.date || !b.date || a.date === b.date);

  /* ---------- drawer ---------- */
  let current = "movie";
  const drawer = $("#listsDrawer");

  function openDrawer() { drawer.hidden = false; requestAnimationFrame(() => drawer.classList.add("open")); renderDrawer(); }
  function closeDrawer() { drawer.classList.remove("open"); setTimeout(() => (drawer.hidden = true), 220); }
  $("#listsBtn").onclick = openDrawer;
  drawer.querySelector(".drawer-bg").onclick = closeDrawer;
  $("#listsClose").onclick = closeDrawer;
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden && !$("#editDlg").open) closeDrawer(); });

  function fieldInputs(t, x = {}, prefix = "lf") {
    return t.cols.map(([k, label]) => k === "date"
      ? `<label>${label}<input type="date" data-${prefix}="${k}" value="${esc(x.date ?? todayStr())}" /></label>`
      : `<label>${label}<input type="text" data-${prefix}="${k}" value="${esc(x[k] || "")}" ${k === "name" || k === "person" ? "" : `placeholder="可不填"`} /></label>`).join("");
  }
  const readInputs = (root, prefix = "lf") => {
    const o = {};
    root.querySelectorAll(`[data-${prefix}]`).forEach((el) => { o[el.getAttribute(`data-${prefix}`)] = el.value.trim(); });
    return o;
  };

  function renderDrawer() {
    if (drawer.hidden) return;
    if (!typeOf(current)) current = "movie";
    const t = typeOf(current);
    $("#listTabs").innerHTML = types().map((x) => `<button type="button" class="chip ${x.id === current ? "on" : ""}" data-tab="${esc(x.id)}">${x.icon} ${esc(x.label)} <small>${itemsOf(x.id).length}</small></button>`).join("")
      + `<button type="button" class="chip add" data-newtype>＋ 新清单</button>`;
    const list = itemsOf(current);
    $("#listBody").innerHTML = `
      <form class="list-add" id="listAdd">${fieldInputs(t, {})}<button class="primary" type="submit">＋ 加入${esc(t.label)}</button></form>
      ${list.length ? `<ul class="list-items">${list.map((x) => `
        <li><div class="li-main"><b>${esc(titleOf(x))}</b><small>${esc(subOf(x))}</small></div>
          <button type="button" class="icon-btn" data-ledit="${x.id}" title="编辑">✎</button>
          <button type="button" class="icon-btn" data-ldel="${x.id}" title="删除">🗑</button></li>`).join("")}</ul>`
        : `<p class="list-empty">还没有${esc(t.label)}。可以手动加，也可以在「📦 每周回顾」里让 AI 帮你整理。</p>`}
      ${custom().some((c) => c.id === current) ? `<button type="button" class="ghost danger small" data-deltype>删除「${esc(t.label)}」这个清单</button>` : ""}`;
    $("#listAdd").onsubmit = (e) => {
      e.preventDefault();
      const v = readInputs(e.target);
      if (!v.name) { e.target.querySelector('[data-lf="name"]').focus(); return; }
      addItems([{ type: current, ...v }]);
      P.commit();
    };
  }
  P.onRender = renderDrawer;

  drawer.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.tab) { current = b.dataset.tab; renderDrawer(); }
    else if (b.hasAttribute("data-newtype")) newType();
    else if (b.hasAttribute("data-deltype")) {
      if (itemsOf(current).length) { alert("这个清单里还有内容，先把它们删掉，才能删除清单。"); return; }
      const s = P.get(); s.listTypes = s.listTypes.filter((x) => x.id !== current); current = "movie"; P.commit();
    } else if (b.dataset.ldel) {
      const x = items().find((y) => y.id === b.dataset.ldel); if (!x) return;
      x.deletedAt = new Date().toISOString(); P.commit();
      P.toast(`已把「${titleOf(x)}」放进垃圾箱`, () => P.trash(`l:${x.id}`, "restore"));
    } else if (b.dataset.ledit) editItem(b.dataset.ledit);
    else if (b.hasAttribute("data-openreview")) openReview(true);
  });

  async function newType() {
    const r = await P.dialog("新建清单", `
      <label>清单名字<input type="text" id="ntLabel" placeholder="例如：想去的地方、展览、演唱会" /></label>
      <label>图标（一个 emoji，可不填）<input type="text" id="ntIcon" placeholder="📌" maxlength="4" /></label>`,
      [{ value: "cancel", label: "取消" }, { value: "ok", label: "创建", cls: "primary" }]);
    if (r !== "ok") return;
    const label = $("#ntLabel").value.trim().replace(/^[#＃]/, "").replace(/[\s|｜]+/g, "");
    if (!label) return;
    if (findType(label)) { current = findType(label).id; renderDrawer(); return; }
    const t = { id: uid(), label, icon: $("#ntIcon").value.trim() || "📌" };
    P.get().listTypes.push(t); current = t.id; P.commit();
  }

  async function editItem(id) {
    let x = items().find((y) => y.id === id); if (!x) return;
    const t = typeOf(x.type) || { cols: [NAME, DATE, NOTE], label: "清单" };
    const r = await P.dialog(`编辑${t.label}`, fieldInputs(t, x, "le"),
      [{ value: "cancel", label: "取消" }, { value: "ok", label: "保存", cls: "primary" }]);
    if (r !== "ok") return;
    const v = readInputs($("#editBody"), "le");
    x = items().find((y) => y.id === id); if (!x || !v.name) return;
    Object.assign(x, v); P.commit();
  }

  function addItems(list) {
    const s = P.get();
    const now = new Date().toISOString();
    for (const it of list) {
      const o = { id: uid(), type: it.type, name: it.name, date: it.date || "", note: it.note || "", createdAt: now };
      for (const k of ["city", "person", "occasion"]) if (it[k]) o[k] = it[k];
      s.lists.push(o);
    }
  }

  /* ---------- weekly review pack ---------- */
  const weekStart = (day) => { const dow = (parseYmd(day).getDay() + 6) % 7; return addDays(day, -dow); }; // Monday
  const short = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const doneDay = (t) => (t.doneAt || "").slice(0, 10);

  function buildPack(from, to) {
    const s = P.get();
    const L = [];
    const kinds = types();
    L.push(`请你当我的每周回顾伙伴。下面是我 ${fmtDay(from)} 到 ${fmtDay(to)} 的日程、待办、笔记和心情。`);
    L.push(`请做两件事：`);
    L.push(`1. 先用几句话陪我回顾这段时间：做成了什么、拖延了什么、情绪和状态怎么样，再问我 1–2 个值得想一想的问题。`);
    L.push(`2. 从我的记录里找出和「${kinds.map((t) => t.label).join("、")}」有关的内容，严格按最后的【清单格式】列出来，全部放进一个代码块里。没把握的不要列；【已经记过的】不要重复列。`);
    L.push("");
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const day = parseYmd(d);
      const head = `【${day.getMonth() + 1}月${day.getDate()}日 ${WEEK[day.getDay()]}】${s.moods[d] ? ` 心情 ${s.moods[d]}` : ""}`;
      const evs = eventsOn(d);
      const tds = liveTodos().filter((t) => dueDay(t) === d || (t.done && doneDay(t) === d));
      const note = (s.notes[d] || "").trim();
      if (!evs.length && !tds.length && !note) { L.push(`${head}（没有记录）`); continue; }
      L.push(head);
      if (evs.length) {
        L.push("日程：");
        evs.forEach((e) => L.push(`- ${isEventDone(e, d) ? "✅" : "▫️"} ${e.start}${e.end ? "–" + e.end : ""} ${e.title}${e.note ? `（${e.note}）` : ""}`));
      }
      if (tds.length) {
        L.push("待办：");
        tds.sort((a, b) => a.due.localeCompare(b.due)).forEach((t) => {
          const when = `截止 ${short(t.due)} ${t.due.slice(11)}`;
          const st = t.done ? (doneDay(t) === dueDay(t) ? "按时完成" : `${short(doneDay(t))} 完成`) : (new Date(t.due) < new Date() ? "没完成" : "还没到截止");
          L.push(`- ${t.done ? "✅" : "⬜"} ${t.title}${t.tag ? ` #${t.tag}` : ""}（${when}，${st}）`);
        });
      }
      if (note) { L.push("笔记："); L.push(note); }
      L.push("");
    }
    const next = addDays(to, 7);
    const upcoming = liveTodos().filter((t) => !t.done && dueDay(t) > to && dueDay(t) <= next).sort((a, b) => a.due.localeCompare(b.due));
    const overdue = liveTodos().filter((t) => !t.done && dueDay(t) < from).sort((a, b) => a.due.localeCompare(b.due));
    if (upcoming.length || overdue.length) {
      L.push("【接下来 7 天要截止的】");
      upcoming.forEach((t) => L.push(`- ${t.title}（截止 ${short(t.due)} ${t.due.slice(11)}）`));
      overdue.forEach((t) => L.push(`- ${t.title}（早就过了截止 ${short(t.due)}，还没完成）`));
      if (!upcoming.length) L.push("- （无）");
      L.push("");
    }
    const known = items().filter((x) => x.date >= from && x.date <= to);
    if (known.length) {
      L.push("【已经记过的】");
      known.forEach((x) => L.push(`- ${typeOf(x.type)?.label || "清单"}：${titleOf(x)}`));
      L.push("");
    }
    L.push("【清单格式】每条一行，# 后面紧跟清单名，各项用 | 分隔，日期写成 YYYY-MM-DD，不知道的项留空：");
    kinds.forEach((t) => L.push(`#${t.label} ${t.cols.map(([, l]) => l).join(" | ")}`));
    L.push(`例如：#餐厅 某某面馆 | ${from} | 纽约 | 和室友一起去的`);
    return L.join("\n");
  }

  function rangeFor(which) {
    const today = todayStr();
    if (which === "last") { const a = addDays(weekStart(today), -7); return [a, addDays(a, 6)]; }
    const a = weekStart(today); return [a, addDays(a, 6)];
  }

  function reviewHtml() {
    const [a, b] = rangeFor("this");
    return `
      <ol class="review-steps">
        <li><b>复制这一周的记录</b>
          <div class="seg" id="rvRange">
            <button type="button" class="chip on" data-range="this">本周</button>
            <button type="button" class="chip" data-range="last">上周</button>
            <span class="rv-custom"><input type="date" id="rvFrom" value="${a}" /> – <input type="date" id="rvTo" value="${b}" /></span>
          </div>
          <textarea id="rvText" readonly rows="7"></textarea>
          <button type="button" class="primary" id="rvCopy">📋 复制</button> <span class="hint" id="rvCopied"></span>
        </li>
        <li><b>粘贴给任意 AI 聊 5 分钟</b>
          <p class="hint">DeepSeek、豆包、Kimi、ChatGPT、Claude 都可以。AI 会陪你回顾，并在最后按格式列出清单。</p></li>
        <li><b>把 AI 的整段回复粘贴回来</b>
          <textarea id="rvPaste" rows="5" placeholder="整段粘贴就行，我会自动找出 #电影、#餐厅 … 这些行"></textarea>
          <button type="button" class="primary" id="rvParse">🔍 识别清单</button>
          <div id="rvResult"></div>
        </li>
      </ol>`;
  }

  async function openReview(pasteOnly) {
    const body = $("#editBody");
    let found = [];
    const refresh = () => {
      const f = $("#rvFrom").value, t = $("#rvTo").value;
      if (f && t && f <= t) $("#rvText").value = buildPack(f, t);
    };
    const onClick = async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.range) {
        const [f, t] = rangeFor(b.dataset.range);
        $("#rvFrom").value = f; $("#rvTo").value = t;
        body.querySelectorAll("[data-range]").forEach((x) => x.classList.toggle("on", x === b));
        refresh();
      } else if (b.id === "rvCopy") {
        const ta = $("#rvText");
        try { await navigator.clipboard.writeText(ta.value); } catch (_) { ta.select(); document.execCommand("copy"); }
        $("#rvCopied").textContent = "已复制 ✓ 去粘贴给 AI 吧";
      } else if (b.id === "rvParse") {
        found = parseAI($("#rvPaste").value);
        showFound(found);
      } else if (b.id === "rvAdd") {
        const picked = found.filter((_, i) => body.querySelector(`[data-pick="${i}"]`)?.checked);
        if (!picked.length) return;
        // lists that don't exist yet are created once
        const s = P.get();
        for (const it of picked) if (it.newLabel) {
          let t = findType(it.newLabel);
          if (!t) { t = { id: uid(), label: it.newLabel, icon: "📌" }; s.listTypes.push(t); }
          it.type = t.id;
        }
        addItems(picked);
        P.commit();
        $("#rvResult").innerHTML = `<p class="rv-ok">已加入 ${picked.length} 条 ✓ 点右上角「📚 清单」可以查看。</p>`;
        $("#rvPaste").value = "";
      }
    };
    const onInput = (e) => { if (e.target.id === "rvFrom" || e.target.id === "rvTo") { body.querySelectorAll("[data-range]").forEach((x) => x.classList.remove("on")); refresh(); } };
    body.addEventListener("click", onClick);
    body.addEventListener("change", onInput);
    const done = P.dialog("📦 每周回顾", reviewHtml(), [{ value: "close", label: "关闭", cls: "primary" }]);
    refresh();
    if (pasteOnly) $("#rvPaste").focus();
    await done;
    body.removeEventListener("click", onClick);
    body.removeEventListener("change", onInput);
  }
  $("#reviewBtn").onclick = () => openReview(false);

  function showFound(found) {
    const box = $("#rvResult");
    if (!found.length) {
      box.innerHTML = `<p class="hint">没有找到清单行。AI 的回复里应该有像「#电影 沙丘2 | 2026-11-18 | 备注」这样的行。</p>`;
      return;
    }
    const fresh = found.filter((x) => !x.exists).length;
    box.innerHTML = `<p class="hint">找到 ${found.length} 条${found.length > fresh ? `，其中 ${found.length - fresh} 条已经记过了` : ""}。勾选要加入的：</p>
      <ul class="rv-list">${found.map((x, i) => {
        const t = x.type ? typeOf(x.type) : null;
        const tag = t ? `${t.icon} ${esc(t.label)}` : `📌 ${esc(x.newLabel)} <em>新清单</em>`;
        return `<li class="${x.exists ? "dup" : ""}"><label><input type="checkbox" data-pick="${i}" ${x.exists ? "disabled" : t ? "checked" : ""} />
          <span class="rv-tag">${tag}</span> <b>${esc(titleOf(x))}</b> <small>${esc(subOf(x))}${x.exists ? " · 已经记过" : ""}</small></label></li>`;
      }).join("")}</ul>
      ${fresh ? `<button type="button" class="primary" id="rvAdd">＋ 加入勾选的</button>` : ""}`;
  }

  /* ---------- parse "#电影 名字 | 日期 | 备注" lines ---------- */
  function normDate(v, yearHint) {
    v = v.trim(); if (!v) return "";
    let m;
    if ((m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(v))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
    if ((m = /^(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(v))) return `${yearHint}-${pad(+m[1])}-${pad(+m[2])}`;
    return null; // not a date
  }

  function parseAI(text) {
    const out = [];
    const year = todayStr().slice(0, 4);
    for (let line of String(text).split(/\r?\n/)) {
      line = line.trim().replace(/^(?:[-*•·]|\d+[.、)])\s*/, "").replace(/\*\*/g, "");
      const m = /^[#＃]([^\s#＃|｜]+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const t = findType(m[1]);
      const parts = m[2].split(/\s*[|｜]\s*/).map((x) => x.trim());
      if (!t && parts.length < 2) continue; // a stray hashtag, not a list line
      const cols = t ? t.cols : [NAME, DATE, NOTE];
      const it = t ? { type: t.id } : { newLabel: m[1] };
      const extra = [];
      cols.forEach(([k], i) => {
        let v = (parts[i] || "").replace(/^(无|空|-|—|N\/A|未知)$/i, "");
        if (k === "date") { const d = normDate(v, year); if (d === null) { extra.push(v); v = ""; } else v = d; }
        it[k] = v;
      });
      extra.push(...parts.slice(cols.length));
      const rest = extra.filter(Boolean).join("；");
      if (rest) { if (cols.some(([k]) => k === "note")) it.note = [it.note, rest].filter(Boolean).join("；"); else it.occasion = [it.occasion, rest].filter(Boolean).join("；"); }
      if (!it.name) continue;
      it.exists = !!it.type && (items().some((x) => sameItem(x, it)) || out.some((y) => sameItem(y, it)));
      out.push(it);
    }
    return out;
  }

  // exposed for the drawer's "paste AI result" shortcut and for tests
  P.lists = { parseAI, buildPack, openReview };
})();
