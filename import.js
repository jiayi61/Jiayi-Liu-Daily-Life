/* Import from outside apps, always through a preview where you untick what you don't want.
   - Canvas: upload the calendar .ics file, or paste the feed link once and refresh with one click
     (the link is fetched through your own small proxy, see proxy/canvas-worker.js — Canvas blocks
     direct reads from other websites).
   - Gmail: Claude reads the mail (MCP tool stage_import) and drops candidates into users/{uid}/inbox;
     the planner shows a bar and the same preview.
   Imported to-dos remember where they came from (`src`), so the same item is never imported twice. */
(() => {
  const P = window.Planner;
  const { esc, uid, todayStr, fmtDue } = P.util;
  const $ = (s, r = document) => r.querySelector(s);
  // Filled in after deploying proxy/canvas-worker.js; each person can also set their own in the dialog.
  const DEFAULT_PROXY = "";
  const PAST_KEY = "planner-import-past";
  const proxy = () => (P.profile()?.canvasProxy || DEFAULT_PROXY).trim();

  /* ---------- .ics parsing ---------- */
  const unesc = (s) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
  const pad = (n) => String(n).padStart(2, "0");
  function icsTime(val, params) {
    // 20261205T045900Z (UTC) · 20261205T235900 (wall time) · 20261205 (all day)
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(val.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, , z] = m;
    if (!h || /VALUE=DATE(?!-)/.test(params)) return { date: `${y}-${mo}-${d}`, time: "", allDay: true };
    if (z) {
      const t = new Date(Date.UTC(+y, mo - 1, +d, +h, +mi));
      return { date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`, time: `${pad(t.getHours())}:${pad(t.getMinutes())}` };
    }
    return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` }; // TZID wall time — treated as local
  }
  function parseIcs(text) {
    const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
    const out = [];
    let cur = null;
    const canvas = /instructure|canvas/i.test(text.slice(0, 600));
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") { cur = {}; continue; }
      if (line === "END:VEVENT") { if (cur?.SUMMARY && cur.DTSTART) out.push(cur); cur = null; continue; }
      if (!cur) continue;
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [name, ...ps] = line.slice(0, i).split(";");
      const key = name.toUpperCase();
      if (["SUMMARY", "DESCRIPTION", "UID", "URL", "LOCATION"].includes(key)) cur[key] = unesc(line.slice(i + 1)).trim();
      if (key === "DTSTART" || key === "DTEND") cur[key] = icsTime(line.slice(i + 1), ps.join(";"));
    }
    return out.map((v) => toCandidate(v, canvas)).filter(Boolean);
  }

  // "HW 3 [APMA3101_001_2026_3 - Linear Algebra]" → title "HW 3", course "APMA 3101"
  function courseOf(summary) {
    const b = /\s*\[([^\]]+)\]\s*$/.exec(summary);
    if (!b) return { title: summary, course: "" };
    const code = /([A-Z]{2,5})[\s_-]?(\d{3,5})/.exec(b[1]);
    return { title: summary.slice(0, b.index).trim() || summary, course: code ? `${code[1]} ${code[2]}` : b[1].split(/\s+-\s+/).pop().trim() };
  }
  function toCandidate(v, canvas) {
    const { title, course } = canvas ? courseOf(v.SUMMARY) : { title: v.SUMMARY, course: "" };
    const s = v.DTSTART;
    if (!s) return null;
    const ref = v.UID || `${v.SUMMARY}|${s.date}`;
    // Canvas: assignments (and quizzes/discussions with a due date) become to-dos; other calendar entries become events
    const isTask = canvas ? /assignment|quiz|discussion/i.test(`${v.UID} ${v.URL}`) || !v.DTEND || (v.DTEND.date === s.date && v.DTEND.time === s.time) : false;
    if (isTask || s.allDay && !canvas) {
      return { kind: "todo", src: `${canvas ? "canvas" : "ics"}:${ref}`, title, tag: tagFor(course), due: `${s.date}T${s.time || "23:59"}`, note: v.URL || "" };
    }
    const e = v.DTEND || s;
    return { kind: "event", src: `${canvas ? "canvas" : "ics"}:${ref}`, title, tag: tagFor(course), date: s.date, start: s.time || "09:00",
      end: e.date === s.date && e.time > (s.time || "") ? e.time : addHour(s.time || "09:00"), note: v.LOCATION || "" };
  }
  const addHour = (t) => `${pad(Math.min(23, +t.slice(0, 2) + 1))}:${t.slice(3, 5)}`;

  // reuse a tag the user already has when it is the same course ("APMA3101" ≈ "APMA 3101")
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s_\-·]/g, "");
  function tagFor(course) {
    if (!course) return "";
    const known = [...new Set([...P.get().todos.map((t) => t.tag), ...(P.profile()?.categories || []).map((c) => c.label)].filter(Boolean))];
    return known.find((k) => norm(k) === norm(course)) || known.find((k) => norm(k).includes(norm(course))) || course;
  }

  /* ---------- duplicates ---------- */
  function mark(items) {
    const s = P.get();
    const srcs = new Set([...s.todos, ...s.events].filter((x) => !x.deletedAt).map((x) => x.src).filter(Boolean));
    return items.map((x) => {
      if (srcs.has(x.src)) return { ...x, state: "done" };
      // same day and one title contains the other → probably added by hand already
      const day = x.kind === "todo" ? x.due?.slice(0, 10) : x.date;
      const t = norm(x.title);
      const like = x.kind === "todo"
        ? s.todos.some((y) => !y.deletedAt && y.due?.slice(0, 10) === day && (norm(y.title).includes(t) || t.includes(norm(y.title))))
        : s.events.some((y) => !y.deletedAt && y.date === day && norm(y.title) === t);
      return { ...x, state: like ? "like" : "new" };
    });
  }
  const isPast = (x) => (x.kind === "todo" ? (x.due || "~").slice(0, 10) : x.date) < todayStr();

  /* ---------- preview ---------- */
  async function preview(title, raw, { inboxIds } = {}) {
    const items = mark(raw).sort((a, b) => (a.due || a.date || "~").localeCompare(b.due || b.date || "~"));
    if (!items.length) { alert("没有找到可以导入的内容。"); return; }
    let showPast = localStorage.getItem(PAST_KEY) === "1";
    const picked = new Set(items.map((x, i) => (x.state === "new" ? i : -1)).filter((i) => i >= 0));
    const visible = (x) => showPast || !isPast(x) || x.state === "done";
    const past = items.filter(isPast).length;
    const row = (x, i) => {
      const when = x.kind === "todo" ? (x.due ? `⏰ ${fmtDue(x)}` : "无截止") : `📅 ${x.date.slice(5).replace("-", "/")} ${x.start}–${x.end}`;
      const why = x.state === "done" ? " · 已导入过" : x.state === "like" ? " · 好像已经有了" : "";
      return `<li class="${x.state === "done" ? "dup" : ""}" ${visible(x) ? "" : "hidden"}><label>
        <input type="checkbox" data-imp="${i}" ${x.state === "done" ? "disabled" : picked.has(i) ? "checked" : ""} />
        ${esc(x.title)} ${x.tag ? `<span class="rv-tag">${esc(x.tag)}</span>` : ""}
        <br><small>${x.kind === "todo" ? "短期目标" : "日程"} · ${when}${isPast(x) ? " · 已过期" : ""}${why}${x.from ? ` · 来自「${esc(x.from)}」` : ""}</small></label></li>`;
    };
    const body = `<div class="imp">
      <div class="imp-bar">
        <button type="button" class="ghost small" data-all="1">全选</button>
        <button type="button" class="ghost small" data-all="0">全不选</button>
        ${past ? `<label class="imp-past"><input type="checkbox" id="impPast" ${showPast ? "checked" : ""} /> 显示已过期的（${past}）</label>` : ""}
      </div>
      <ul class="rv-list imp-list">${items.map(row).join("")}</ul>
      <p class="hint" id="impCount"></p></div>`;
    const dlg = $("#editDlg");
    const wait = P.dialog(title, body, [
      { value: "cancel", label: "取消" },
      ...(inboxIds ? [{ value: "drop", label: "全部忽略" }] : []),
      { value: "ok", label: "导入", cls: "primary" },
    ]);
    const okBtn = $('.dlg-actions button[value="ok"]', dlg);
    const sync = () => {
      const n = [...picked].filter((i) => visible(items[i])).length;
      const nt = [...picked].filter((i) => visible(items[i]) && items[i].kind === "todo").length;
      okBtn.textContent = n ? `导入 ${n} 项` : "导入";
      okBtn.disabled = !n;
      $("#impCount").textContent = `共 ${items.length} 项：勾选的 ${nt} 个会变成短期目标，${n - nt} 个会变成日程。`;
    };
    const box = $(".imp", dlg);
    box.onchange = (e) => {
      const i = e.target.dataset.imp;
      if (i != null) e.target.checked ? picked.add(+i) : picked.delete(+i);
      if (e.target.id === "impPast") {
        showPast = e.target.checked;
        localStorage.setItem(PAST_KEY, showPast ? "1" : "0");
        box.querySelectorAll("[data-imp]").forEach((c) => { c.closest("li").hidden = !visible(items[c.dataset.imp]); });
      }
      sync();
    };
    box.onclick = (e) => {
      const all = e.target.dataset.all;
      if (all == null) return;
      box.querySelectorAll("[data-imp]:not(:disabled)").forEach((c) => {
        if (c.closest("li").hidden) return;
        c.checked = all === "1";
        c.checked ? picked.add(+c.dataset.imp) : picked.delete(+c.dataset.imp);
      });
      sync();
    };
    sync();
    const r = await wait;
    if (r !== "ok" && r !== "drop") return;
    const s = P.get();
    const chosen = r === "ok" ? [...picked].filter((i) => visible(items[i])).map((i) => items[i]) : [];
    const now = new Date().toISOString();
    for (const x of chosen) {
      if (x.kind === "todo") {
        s.todos.push({ id: uid(), title: x.title, due: x.due || "", prio: 1, tag: x.tag || "", src: x.src,
          ...(x.note ? { note: x.note } : {}), done: false, doneAt: null, createdAt: now });
      } else {
        const cs = P.profile()?.categories || [];
        const c = cs.find((y) => norm(y.label) === norm(x.tag)) || cs.find((y) => /学习|上课|study|class/i.test(y.label)) || cs[0];
        s.events.push({ id: uid(), title: x.title, date: x.date, start: x.start, end: x.end, note: x.note || "", cat: c?.id || "", color: c?.color || "#5b86b0", src: x.src,
          repeat: "once", skip: [], doneOn: [] });
      }
    }
    // inbox items are cleared whether they were imported or not — unticked ones stay unticked
    if (inboxIds) s.inbox = (s.inbox || []).filter((x) => !inboxIds.includes(x.id));
    P.commit();
    if (chosen.length) P.toast(`已导入 ${chosen.length} 项`);
    else if (r === "drop") P.toast("已忽略这些待导入");
  }

  /* ---------- Canvas ---------- */
  async function fromFile(file) {
    const text = await file.text();
    if (!/BEGIN:VCALENDAR/.test(text)) { alert("这不是日历文件（.ics）。"); return; }
    const canvas = /instructure|canvas/i.test(text.slice(0, 600));
    await preview(canvas ? "从 Canvas 导入" : "从日历文件导入", parseIcs(text));
  }
  async function fromFeed(feed) {
    const px = proxy();
    if (!px) { alert("还没有设置代理地址。"); return; }
    let text;
    try {
      const r = await fetch(`${px.replace(/\/$/, "")}/?url=${encodeURIComponent(feed)}`);
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`);
      text = await r.text();
    } catch (e) {
      alert("读取 Canvas 订阅链接失败：" + e.message);
      return;
    }
    await preview("从 Canvas 导入", parseIcs(text));
  }

  /* ---------- Gmail (via Claude) ---------- */
  const inbox = () => (P.get().inbox || []).filter((x) => x.title);
  function openInbox(source) {
    const list = inbox().filter((x) => !source || x.source === source);
    if (!list.length) return;
    const one = new Set(list.map((x) => x.source)).size === 1;
    const name = (one && { gmail: "Gmail", canvas: "Canvas" }[list[0].source]) || "Claude 找到的内容";
    preview(`从 ${name} 导入`, list.map((x) => ({
      kind: x.kind === "event" ? "event" : "todo", src: x.src || `${x.source || "inbox"}:${x.id}`, title: x.title, tag: tagFor(x.tag) || x.tag || "",
      due: x.due || "", date: x.date, start: x.start, end: x.end, note: x.note || "", from: x.from || "",
    })), { inboxIds: list.map((x) => x.id) });
  }

  /* ---------- source picker ---------- */
  async function open() {
    const p = P.profile() || {};
    const n = inbox().length;
    const r = P.dialog("📥 从其他软件导入", `
      <div class="imp-src">
        <section>
          <h4>🎓 Canvas</h4>
          <p class="hint">在 Canvas 左边点「日历」，右下角点「日历订阅」，会得到一个链接。用浏览器打开它会下载一个 .ics 文件。</p>
          <label class="ghost imp-file">选择 .ics 文件<input type="file" id="impFile" accept=".ics,text/calendar" hidden /></label>
          ${p.canvasFeed && proxy() ? `<button type="button" class="primary" id="impFeed">🔄 一键刷新 Canvas</button>` : ""}
          <details ${p.canvasFeed && !proxy() ? "open" : ""}><summary>设置一键刷新</summary>
            <label>Canvas 日历订阅链接<input type="url" id="impFeedUrl" value="${esc(p.canvasFeed || "")}" placeholder="https://courseworks2.columbia.edu/feeds/calendars/user_….ics" /></label>
            <label>代理地址${DEFAULT_PROXY ? "（不填就用默认的）" : ""}<input type="url" id="impProxy" value="${esc(p.canvasProxy || "")}" placeholder="${esc(DEFAULT_PROXY || "https://canvas-proxy.你的名字.workers.dev")}" /></label>
            <p class="hint">Canvas 不允许网页直接读取订阅链接，所以要经过一个代理。部署方法见 GitHub 仓库里的 proxy/README.md。订阅链接只保存在你自己的账号里。</p>
            <button type="button" class="ghost small" id="impSave">保存</button>
          </details>
        </section>
        <section>
          <h4>✉️ Gmail</h4>
          <p class="hint">在 Claude 里说「读我的邮件，把 ddl 放进日程本的待导入」。Claude 读完后，这里会出现待导入的内容，由你勾选。</p>
          ${n ? `<button type="button" class="primary" id="impInbox">查看 ${n} 项待导入</button>` : `<p class="hint">现在没有待导入的内容。</p>`}
        </section>
        <section>
          <h4>📅 其他日历</h4>
          <p class="hint">Google 日历、Outlook、Apple 日历导出的 .ics 文件也可以用上面的「选择 .ics 文件」。</p>
        </section>
      </div>`, [{ value: "cancel", label: "关闭" }]);
    const dlg = $("#editDlg");
    $("#impFile", dlg).onchange = (e) => { const f = e.target.files[0]; if (f) { dlg.close("file"); fromFile(f); } };
    const feedBtn = $("#impFeed", dlg);
    if (feedBtn) feedBtn.onclick = () => { dlg.close("feed"); fromFeed(p.canvasFeed); };
    const ib = $("#impInbox", dlg);
    if (ib) ib.onclick = () => { dlg.close("inbox"); openInbox(); };
    $("#impSave", dlg).onclick = () => {
      const feed = $("#impFeedUrl", dlg).value.trim(), px = $("#impProxy", dlg).value.trim();
      if (feed && !/^https:\/\/[^/]+\/feeds\/calendars\/[\w.-]+\.ics$/.test(feed)) { alert("订阅链接应该长这样：https://…/feeds/calendars/user_….ics"); return; }
      P.saveProfile({ canvasFeed: feed, canvasProxy: px });
      dlg.close("saved");
      setTimeout(open, 0);
    };
    await r;
  }

  /* ---------- "Claude found N deadlines" bar ---------- */
  function renderNudge() {
    const el = $("#importNudge");
    if (!el) return;
    const list = inbox();
    el.hidden = !list.length;
    if (!list.length) return;
    const by = list.reduce((m, x) => ((m[x.source] = (m[x.source] || 0) + 1), m), {});
    const what = Object.entries(by).map(([k, v]) => `${{ gmail: "Gmail", canvas: "Canvas" }[k] || k} ${v} 项`).join("、");
    el.innerHTML = `📥 Claude 帮你找到了 ${what}，点这里勾选要导入的`;
  }

  $("#importBtn").onclick = open;
  $("#importNudge").onclick = () => openInbox();
  P.renderHooks.push(renderNudge);
  P.importer = { parseIcs, preview, open, openInbox };
})();
