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

  /* ---------- .ics parsing (Canvas, Apple / iCloud, Google, Outlook) ---------- */
  const unesc = (s) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
  const pad = (n) => String(n).padStart(2, "0");
  const ymdOf = (t) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const hmOf = (t) => `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const dayMs = 86400000;
  const shift = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); return ymdOf(new Date(y, m - 1, d + n)); };
  const dow = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).getDay(); };
  const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const WD_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  // offset (ms) of a named time zone at a UTC instant; throws for names Intl doesn't know
  function tzOffset(tz, ms) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  }
  function icsTime(val, params) {
    // 20261205T045900Z (UTC) · TZID=America/New_York:20261205T235900 · 20261205 (all day)
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(val.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, , z] = m;
    if (!h || /VALUE=DATE(?!-)/.test(params)) return { date: `${y}-${mo}-${d}`, time: "", allDay: true };
    const wall = Date.UTC(+y, mo - 1, +d, +h, +mi);
    let t = null;
    if (z) t = new Date(wall);
    else {
      const tz = /TZID=("?)([^;"]+)\1/.exec(params)?.[2];
      if (tz) {
        try { let u = wall - tzOffset(tz, wall); u = wall - tzOffset(tz, u); t = new Date(u); } catch (_) { /* unknown zone name: keep wall time */ }
      }
    }
    return t ? { date: ymdOf(t), time: hmOf(t) } : { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  }

  function parseIcs(text) {
    const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
    const raw = [];
    let cur = null, depth = 0;
    const canvas = /instructure|canvas/i.test(text.slice(0, 600));
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") { cur = { EXDATE: [] }; depth = 0; continue; }
      if (line === "END:VEVENT") { if (cur?.SUMMARY && cur.DTSTART) raw.push(cur); cur = null; continue; }
      if (!cur) continue;
      if (line.startsWith("BEGIN:")) { depth++; continue; } // VALARM inside an event
      if (line.startsWith("END:")) { depth--; continue; }
      if (depth > 0) continue;
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [name, ...ps] = line.slice(0, i).split(";");
      const key = name.toUpperCase(), val = line.slice(i + 1), params = ps.join(";");
      if (["SUMMARY", "DESCRIPTION", "UID", "URL", "LOCATION", "STATUS", "RRULE"].includes(key)) cur[key] = unesc(val).trim();
      if (key === "DTSTART" || key === "DTEND" || key === "RECURRENCE-ID") cur[key] = icsTime(val, params);
      if (key === "EXDATE") val.split(",").forEach((x) => { const t = icsTime(x, params); if (t) cur.EXDATE.push(t.date); });
    }
    // a changed single occurrence of a repeating event comes as its own VEVENT with RECURRENCE-ID:
    // the original date is skipped on the series and the changed one is imported on its own
    const byUid = new Map(raw.filter((v) => !v["RECURRENCE-ID"]).map((v) => [v.UID, v]));
    for (const v of raw) if (v["RECURRENCE-ID"]) byUid.get(v.UID)?.EXDATE.push(v["RECURRENCE-ID"].date);
    return raw.filter((v) => !/CANCELLED/i.test(v.STATUS || ""))
      .flatMap((v) => expand(v, canvas)).filter(Boolean);
  }

  // "HW 3 [APMA3101_001_2026_3 - Linear Algebra]" → title "HW 3", course "APMA 3101"
  function courseOf(summary) {
    const b = /\s*\[([^\]]+)\]\s*$/.exec(summary);
    if (!b) return { title: summary, course: "" };
    const code = /([A-Z]{2,5})[\s_-]?(\d{3,5})/.exec(b[1]);
    return { title: summary.slice(0, b.index).trim() || summary, course: code ? `${code[1]} ${code[2]}` : b[1].split(/\s+-\s+/).pop().trim() };
  }

  /* repeating events: the planner knows daily / weekdays / weekly (+ optional `until`).
     WEEKLY on several days (a class on Mon/Wed) becomes one weekly event per day; anything
     fancier (every 2 weeks, monthly, yearly) is spread out into single days for the next year. */
  function rruleOf(s) {
    if (!s) return null;
    const r = Object.fromEntries(s.split(";").map((kv) => kv.split("=")));
    return { freq: r.FREQ, interval: +(r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null,
      until: r.UNTIL ? icsTime(r.UNTIL, /T/.test(r.UNTIL) ? "" : "VALUE=DATE")?.date : null,
      byday: r.BYDAY ? r.BYDAY.split(",") : null };
  }
  function occurrences(start, r, from, to, cap) {
    // dates of the series between from..to (inclusive), at most `cap`
    const out = [];
    let n = 0;
    const days = r.byday?.map((d) => WD.indexOf(d.replace(/^[+-]?\d+/, ""))).filter((d) => d >= 0);
    const [y0, m0, d0] = start.split("-").map(Number);
    for (let k = 0; k < 5000 && out.length < cap; k++) {
      let batch = [];
      if (r.freq === "DAILY") batch = [shift(start, k * r.interval)];
      else if (r.freq === "WEEKLY") {
        const wk = shift(start, k * 7 * r.interval - dow(start));
        batch = (days?.length ? days : [dow(start)]).sort().map((d) => shift(wk, d)).filter((x) => x >= start);
      } else if (r.freq === "MONTHLY") { const t = new Date(y0, m0 - 1 + k * r.interval, d0); if (t.getDate() === d0) batch = [ymdOf(t)]; }
      else if (r.freq === "YEARLY") { const t = new Date(y0 + k * r.interval, m0 - 1, d0); if (t.getDate() === d0) batch = [ymdOf(t)]; }
      else return [start];
      for (const x of batch) {
        if (r.until && x > r.until) return out;
        if (r.count && ++n > r.count) return out;
        if (x > to) return out;
        if (x >= from) out.push(x);
      }
    }
    return out;
  }
  function expand(v, canvas) {
    const base = toCandidate(v, canvas);
    if (!base) return [];
    const r = rruleOf(v.RRULE);
    if (!r || canvas) return [base];
    const start = v.DTSTART.date, skip = [...new Set(v.EXDATE)];
    const plain = (r.byday || []).every((d) => /^[A-Z]{2}$/.test(d));
    // until for COUNT-limited series = date of the last occurrence
    const until = r.until || (r.count ? occurrences(start, r, start, "9999-12-31", r.count).pop() : null);
    if (base.kind === "event" && r.interval === 1 && plain && (r.freq === "DAILY" || r.freq === "WEEKLY")) {
      const days = r.freq === "WEEKLY" ? (r.byday?.length ? r.byday : [WD[dow(start)]]) : null;
      const common = { ...base, ...(until ? { until } : {}), skip };
      if (r.freq === "DAILY") return [{ ...common, repeat: "daily" }];
      if (days.length === 5 && ["MO", "TU", "WE", "TH", "FR"].every((d) => days.includes(d))) {
        const first = occurrences(start, r, start, "9999-12-31", 1)[0] || start;
        return [{ ...common, date: first, repeat: "weekdays" }];
      }
      return days.map((d) => {
        let first = start;
        while (WD[dow(first)] !== d) first = shift(first, 1);
        if (until && first > until) return null;
        return { ...common, date: first, repeat: "weekly", src: days.length > 1 ? `${base.src}#${d}` : base.src };
      });
    }
    const today = todayStr();
    return occurrences(start, r, shift(today, -60), shift(today, 366), 60).filter((d) => !skip.includes(d)).map((d) => {
      const x = { ...base, src: `${base.src}@${d}` };
      if (x.kind === "todo") x.due = `${d}${x.due.slice(10)}`; else x.date = d;
      return x;
    });
  }

  function toCandidate(v, canvas) {
    const { title, course } = canvas ? courseOf(v.SUMMARY) : { title: v.SUMMARY, course: "" };
    const s = v.DTSTART;
    if (!s) return null;
    const ref = (v.UID || `${v.SUMMARY}|${s.date}`) + (v["RECURRENCE-ID"] ? `@${v["RECURRENCE-ID"].date}` : "");
    const src = `${canvas ? "canvas" : "ics"}:${ref}`;
    // Canvas: assignments (and quizzes/discussions with a due date) become to-dos; other calendar entries become events
    const isTask = canvas && (/assignment|quiz|discussion/i.test(`${v.UID} ${v.URL}`) || !v.DTEND || (v.DTEND.date === s.date && v.DTEND.time === s.time));
    if (isTask) return { kind: "todo", src, title, tag: tagFor(course), due: `${s.date}T${s.time || "23:59"}`, note: v.URL || "" };
    if (s.allDay) {
      // all-day entries (birthdays, trips, holidays) have no time slot in the day view → to-do on that day, unticked by default
      const last = v.DTEND?.allDay ? shift(v.DTEND.date, -1) : s.date;
      return { kind: "todo", src, title: last > s.date ? `${title}（到 ${+last.slice(5, 7)}/${+last.slice(8)}）` : title, tag: tagFor(course),
        due: `${s.date}T23:59`, note: v.LOCATION || "", soft: true, allDay: true };
    }
    const e = v.DTEND || s;
    // ends on a later day: keep it if it is the small hours (the planner day runs to 05:00), else stop at 23:59
    const end = e.date === s.date ? (e.time > s.time ? e.time : addHour(s.time))
      : e.date === shift(s.date, 1) && e.time <= "05:00" ? e.time : "23:59";
    return { kind: "event", src, title, tag: tagFor(course), date: s.date, start: s.time, end, note: v.LOCATION || "" };
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
        : s.events.some((y) => !y.deletedAt && y.date === day && norm(y.title) === t && (y.repeat || "once") === (x.repeat || "once"));
      return { ...x, state: like ? "like" : "new" };
    });
  }
  const isPast = (x) => (x.kind === "todo" ? (x.due || "~").slice(0, 10) : x.repeat && x.repeat !== "once" ? x.until || "9999" : x.date) < todayStr();
  const fmtDay = (d) => `${+d.slice(5, 7)}/${+d.slice(8)}`;
  const whenOf = (x) => {
    if (x.kind === "todo") return x.allDay ? `📅 ${fmtDay(x.due)} 全天` : x.due ? `⏰ ${fmtDue(x)}` : "无截止";
    const rep = { daily: "每天", weekdays: "工作日", weekly: `每${WD_CN[dow(x.date)]}` }[x.repeat];
    return rep ? `🔁 ${rep} ${x.start}–${x.end}，${fmtDay(x.date)} 起${x.until ? `到 ${fmtDay(x.until)}` : ""}` : `📅 ${fmtDay(x.date)} ${x.start}–${x.end}`;
  };

  /* ---------- preview ---------- */
  async function preview(title, raw, { inboxIds } = {}) {
    // repeating events first (they are usually the routine: classes, gym), then by date
    const key = (x) => `${x.repeat && x.repeat !== "once" ? 0 : 1}${x.due || x.date || "~"}`;
    const items = mark(raw).sort((a, b) => key(a).localeCompare(key(b)));
    if (!items.length) { alert("没有找到可以导入的内容。"); return; }
    let showPast = localStorage.getItem(PAST_KEY) === "1";
    const picked = new Set(items.map((x, i) => (x.state === "new" && !x.soft ? i : -1)).filter((i) => i >= 0));
    const visible = (x) => showPast || !isPast(x) || x.state === "done";
    const past = items.filter(isPast).length;
    const row = (x, i) => {
      const when = whenOf(x);
      const why = x.state === "done" ? " · 已导入过" : x.state === "like" ? " · 好像已经有了" : "";
      return `<li class="${x.state === "done" ? "dup" : ""}" ${visible(x) ? "" : "hidden"}><label>
        <input type="checkbox" data-imp="${i}" ${x.state === "done" ? "disabled" : picked.has(i) ? "checked" : ""} />
        ${esc(x.title)} ${x.tag ? `<span class="rv-tag">${esc(x.tag)}</span>` : ""}
        <br><small>${x.kind === "todo" ? (x.allDay ? "全天事项 → 短期目标" : "短期目标") : "日程"} · ${when}${isPast(x) ? " · 已过期" : ""}${why}${x.from ? ` · 来自「${esc(x.from)}」` : ""}</small></label></li>`;
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
          repeat: x.repeat || "once", ...(x.until ? { until: x.until } : {}), skip: x.skip || [], doneOn: [] });
      }
    }
    // inbox items are cleared whether they were imported or not — unticked ones stay unticked
    if (inboxIds) s.inbox = (s.inbox || []).filter((x) => !inboxIds.includes(x.id));
    P.commit();
    if (chosen.length) P.toast(`已导入 ${chosen.length} 项`);
    else if (r === "drop") P.toast("已忽略这些待导入");
  }

  /* ---------- files and subscription links ---------- */
  // calendars whose subscription link can be refreshed with one click (through the proxy)
  const FEEDS = {
    canvas: { name: "Canvas", key: "canvasFeed", re: /^https:\/\/[^/]+\/feeds\/calendars\/[\w.-]+\.ics$/,
      eg: "https://courseworks2.columbia.edu/feeds/calendars/user_….ics" },
    apple: { name: "Apple 日历", key: "appleFeed", re: /^https:\/\/p\d+-caldav\.icloud\.com\/published\/2\/[\w-]+$/,
      eg: "webcal://p…-caldav.icloud.com/published/2/…" },
  };
  const feedUrl = (u) => u.trim().replace(/^webcal:\/\//i, "https://");
  async function fromFile(file) {
    const text = await file.text();
    if (!/BEGIN:VCALENDAR/.test(text)) { alert("这不是日历文件（.ics）。"); return; }
    const canvas = /instructure|canvas/i.test(text.slice(0, 600));
    const apple = /PRODID:[^\n]*Apple/i.test(text.slice(0, 600));
    await preview(canvas ? "从 Canvas 导入" : apple ? "从 Apple 日历导入" : "从日历文件导入", parseIcs(text));
  }
  async function fromFeed(kind) {
    const f = FEEDS[kind], px = proxy();
    if (!px) { alert("还没有设置代理地址。"); return; }
    let text;
    try {
      const r = await fetch(`${px.replace(/\/$/, "")}/?url=${encodeURIComponent(P.profile()[f.key])}`);
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160)}`);
      text = await r.text();
    } catch (e) {
      alert(`读取${f.name}订阅链接失败：` + e.message);
      return;
    }
    await preview(`从${f.name}导入`, parseIcs(text));
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
    const fileBtn = `<label class="ghost imp-file">选择 .ics 文件<input type="file" class="imp-file-in" accept=".ics,text/calendar" hidden /></label>`;
    const refresh = (kind) => {
      const f = FEEDS[kind], has = !!p[f.key];
      return `${has && proxy() ? `<button type="button" class="primary" data-feed="${kind}">🔄 一键刷新${f.name}</button>` : ""}
        <details ${has && !proxy() ? "open" : ""}><summary>设置一键刷新</summary>
          <label>${f.name}订阅链接<input type="url" data-feed-url="${kind}" value="${esc(p[f.key] || "")}" placeholder="${esc(f.eg)}" /></label>
          <button type="button" class="ghost small" data-feed-save>保存</button>
        </details>`;
    };
    const r = P.dialog("📥 从其他软件导入", `
      <div class="imp-src">
        <section>
          <h4>🎓 Canvas</h4>
          <p class="hint">在 Canvas 左边点「日历」，右下角点「日历订阅」，会得到一个链接。用浏览器打开它会下载一个 .ics 文件。</p>
          ${fileBtn}${refresh("canvas")}
        </section>
        <section>
          <h4>🍎 Apple 日历</h4>
          <p class="hint"><b>Mac：</b>打开「日历」App，左边点选一个日历，菜单栏「文件 → 导出 → 导出…」，存下 .ics 文件后在这里选择它。每个日历要分别导出。</p>
          <p class="hint"><b>一键刷新（iPhone 也能设置）：</b>只适用于 iCloud 日历。iPhone 上打开「日历」→ 底部「日历」→ 点日历右边的 ⓘ → 打开「公开日历」→「共享链接」→ 拷贝；Mac 上右键日历 →「共享日历」→ 勾选「公开」。把 webcal:// 开头的链接粘贴到下面。注意：拿到这个链接的人都能看到这个日历。</p>
          ${fileBtn}${refresh("apple")}
        </section>
        <section>
          <h4>✉️ Gmail</h4>
          <p class="hint">在 Claude 里说「读我的邮件，把 ddl 放进日程本的待导入」。Claude 读完后，这里会出现待导入的内容，由你勾选。</p>
          ${n ? `<button type="button" class="primary" id="impInbox">查看 ${n} 项待导入</button>` : `<p class="hint">现在没有待导入的内容。</p>`}
        </section>
        <section>
          <h4>📅 其他日历</h4>
          <p class="hint">Google 日历、Outlook 导出的 .ics 文件也可以直接导入。</p>
          ${fileBtn}
        </section>
        <details class="imp-proxy" ${(p.canvasFeed || p.appleFeed) && !proxy() ? "open" : ""}><summary>⚙️ 一键刷新用的代理</summary>
          <label>代理地址${DEFAULT_PROXY ? "（不填就用默认的）" : ""}<input type="url" id="impProxy" value="${esc(p.canvasProxy || "")}" placeholder="${esc(DEFAULT_PROXY || "https://canvas-proxy.你的名字.workers.dev")}" /></label>
          <p class="hint">Canvas 和 iCloud 都不允许网页直接读取订阅链接，所以要经过一个代理。部署方法见 GitHub 仓库里的 proxy/README.md。订阅链接只保存在你自己的账号里。</p>
          <button type="button" class="ghost small" data-feed-save>保存</button>
        </details>
      </div>`, [{ value: "cancel", label: "关闭" }]);
    const dlg = $("#editDlg");
    dlg.querySelectorAll(".imp-file-in").forEach((inp) => {
      inp.onchange = (e) => { const f = e.target.files[0]; if (f) { dlg.close("file"); fromFile(f); } };
    });
    dlg.querySelectorAll("[data-feed]").forEach((b) => { b.onclick = () => { dlg.close("feed"); fromFeed(b.dataset.feed); }; });
    const ib = $("#impInbox", dlg);
    if (ib) ib.onclick = () => { dlg.close("inbox"); openInbox(); };
    dlg.querySelectorAll("[data-feed-save]").forEach((b) => {
      b.onclick = () => {
        const patch = { canvasProxy: $("#impProxy", dlg).value.trim() };
        for (const [kind, f] of Object.entries(FEEDS)) {
          const u = feedUrl($(`[data-feed-url="${kind}"]`, dlg).value);
          if (u && !f.re.test(u)) { alert(`${f.name}订阅链接应该长这样：${f.eg}`); return; }
          patch[f.key] = u;
        }
        P.saveProfile(patch);
        dlg.close("saved");
        setTimeout(open, 0);
      };
    });
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
