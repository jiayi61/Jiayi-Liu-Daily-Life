/* Monthly review (#month): free stat cards computed from the month's records
   ("认识自己" style), plus a pack to paste into any AI for a written portrait,
   which can be pasted back and kept (state.reviews, one per month). */
(() => {
  "use strict";
  const P = window.Planner;
  const { DAY_START, lmin, evEnd, MOODS, esc, pad, parseYmd, addDays, todayStr, WEEK, eventsOn, isEventDone, liveTodos, liveGoals, dueDay } = P.util;
  const $ = (s) => document.querySelector(s);
  const END = DAY_START + 1440;
  const SEEN_KEY = "planner-month-seen";

  /* ---------- small helpers ---------- */
  const ymOf = (d) => d.slice(0, 7);
  const shiftYm = (ym, n) => { const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const lastDay = (ym) => `${ym}-${pad(new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate())}`;
  const monthName = (ym) => `${+ym.slice(5, 7)} 月`;
  const short = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const hm = (m) => { m = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const hrs = (m) => { const h = m / 60; return h === 0 ? "0" : h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h) + ""; };
  const moodScore = (m) => { const i = MOODS.indexOf(m); return i < 0 ? null : 5 - i; };
  const catOf = (ev) => P.catOf?.(ev) || { id: "", emoji: "▫️", label: "未分类", color: "#9a958c" };
  const reviews = () => P.get().reviews || (P.get().reviews = []);
  const savedFor = (ym) => reviews().find((r) => r.id === `m-${ym}`);
  const evMins = (ev) => { const e = evEnd(ev); if (e == null) return 0; return Math.max(0, Math.min(e, END) - lmin(ev.start)); };

  /* ---------- the numbers ---------- */
  function stats(ym) {
    const s = P.get();
    const today = todayStr();
    const from = `${ym}-01`, to0 = lastDay(ym);
    const to = to0 > today ? today : to0; // the current month only counts up to today
    const D = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const evs = eventsOn(d);
      const done = evs.filter((e) => isEventDone(e, d));
      D.push({
        d, evs, done,
        doneMin: done.reduce((a, e) => a + evMins(e), 0),
        planMin: evs.reduce((a, e) => a + evMins(e), 0),
        todos: liveTodos().filter((t) => t.done && (t.doneAt || "").slice(0, 10) === d),
        note: (s.notes[d] || "").trim(),
        mood: s.moods[d] || "",
      });
    }
    const active = D.filter((x) => x.done.length || x.todos.length || x.note || x.mood);

    // time by tag (this month vs last month)
    const byCat = (days) => {
      const m = new Map();
      for (const x of days) for (const e of x.done) {
        const c = catOf(e), k = c.id || "none", r = m.get(k) || { c, min: 0 };
        r.min += evMins(e); m.set(k, r);
      }
      return m;
    };
    const cats = [...byCat(D).values()].sort((a, b) => b.min - a.min);
    const doneMin = D.reduce((a, x) => a + x.doneMin, 0), planMin = D.reduce((a, x) => a + x.planMin, 0);
    const prevYm = shiftYm(ym, -1), prev = [];
    for (let d = `${prevYm}-01`; d <= lastDay(prevYm); d = addDays(d, 1)) prev.push({ done: eventsOn(d).filter((e) => isEventDone(e, d)) });
    const prevCats = byCat(prev);
    const prevMin = [...prevCats.values()].reduce((a, r) => a + r.min, 0);

    // rhythm: when the first ticked thing starts and the last one ends
    const worked = D.filter((x) => x.done.length);
    const firsts = worked.map((x) => ({ d: x.d, m: Math.min(...x.done.map((e) => lmin(e.start))) }));
    const lasts = worked.map((x) => ({ d: x.d, m: Math.max(...x.done.map((e) => Math.min(evEnd(e) ?? lmin(e.start), END))) }));
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y.m, 0) / a.length) : null);
    const rhythm = worked.length < 3 ? null : {
      start: avg(firsts), end: avg(lasts),
      earliest: firsts.reduce((a, b) => (b.m < a.m ? b : a)),
      latest: lasts.reduce((a, b) => (b.m > a.m ? b : a)),
    };
    if (rhythm) {
      const bird = rhythm.start < 7.5 * 60 ? ["🐦", "早起鸟"] : rhythm.start < 9.5 * 60 ? ["☀️", "规律派"] : ["🌤", "慢热型"];
      rhythm.type = rhythm.end >= 1440 ? ["🦉", bird[1] === "早起鸟" ? "早起又熬夜的超人" : "夜猫子"] : bird;
    }

    // busiest day + strongest weekday
    // a day full of different things beats one long trip: each event counts at most 4 hours here
    const fullness = (x) => x.done.reduce((a, e) => a + Math.min(evMins(e), 240), 0);
    const busiest = worked.length ? worked.reduce((a, b) => (fullness(b) > fullness(a) ? b : a)) : null;
    const wd = Array.from({ length: 7 }, () => ({ min: 0, n: 0 }));
    D.forEach((x) => { const w = parseYmd(x.d).getDay(); wd[w].min += x.doneMin; wd[w].n++; });
    const wdAvg = wd.map((w, i) => ({ i, v: w.n ? w.min / w.n : 0 }));
    const bestWd = wdAvg.reduce((a, b) => (b.v > a.v ? b : a));

    // streak of recorded days
    let streak = 0, run = 0, streakEnd = null;
    D.forEach((x) => { const on = active.includes(x); run = on ? run + 1 : 0; if (run > streak) { streak = run; streakEnd = x.d; } });

    // short-term goals (to-dos)
    const doneT = D.flatMap((x) => x.todos);
    const withDue = doneT.filter((t) => t.due);
    const onTime = withDue.filter((t) => t.doneAt <= t.due);
    const late = liveTodos().filter((t) => !t.done && t.due && ymOf(dueDay(t)) === ym && dueDay(t) < today);
    const created = liveTodos().filter((t) => ymOf((t.createdAt || "").slice(0, 10)) === ym);
    const daysTaken = (t) => (t.createdAt ? Math.round((new Date(t.doneAt) - new Date(t.createdAt)) / 864e5) : 0);
    const slowest = doneT.filter((t) => daysTaken(t) >= 3).sort((a, b) => daysTaken(b) - daysTaken(a))[0];
    const subsDone = doneT.reduce((a, t) => a + (t.subs || []).length, 0);

    // long-term goals touched this month
    const goals = liveGoals().map((g) => ({ g, n: doneT.filter((t) => t.goal === g.id).length, p: P.goalProgress?.(g),
      achieved: g.done && ymOf((g.doneAt || "").slice(0, 10)) === ym })).filter((x) => x.n || x.achieved || !x.g.done);

    // moods, and what goes with a good day
    const moodDays = D.filter((x) => moodScore(x.mood) != null);
    const moodCount = MOODS.map((m) => ({ m, n: moodDays.filter((x) => x.mood === m).length }));
    const topMood = moodDays.length ? moodCount.reduce((a, b) => (b.n > a.n ? b : a)) : null;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    let moodLink = null;
    if (moodDays.length >= 6) {
      const ids = new Map();
      moodDays.forEach((x) => x.done.forEach((e) => { const c = catOf(e); if (c.id) ids.set(c.id, c); }));
      for (const c of ids.values()) {
        const withC = moodDays.filter((x) => x.done.some((e) => catOf(e).id === c.id)).map((x) => moodScore(x.mood));
        const without = moodDays.filter((x) => !x.done.some((e) => catOf(e).id === c.id)).map((x) => moodScore(x.mood));
        if (withC.length < 3 || without.length < 3) continue;
        const diff = mean(withC) - mean(without);
        if (diff > 0.3 && (!moodLink || diff > moodLink.diff)) moodLink = { c, diff, n: withC.length };
      }
    }
    const wdMood = Array.from({ length: 7 }, (_, i) => moodDays.filter((x) => parseYmd(x.d).getDay() === i).map((x) => moodScore(x.mood)));
    const happyWd = moodDays.length >= 6 ? wdMood.map((a, i) => ({ i, v: a.length >= 2 ? mean(a) : -1 })).reduce((a, b) => (b.v > a.v ? b : a)) : null;

    // notes + lists
    const notes = D.filter((x) => x.note);
    const longest = notes.reduce((a, b) => (!a || b.note.length > a.note.length ? b : a), null);
    const kinds = P.lists?.types?.() || [];
    const items = (s.lists || []).filter((x) => !x.deletedAt && ymOf(x.date || "") === ym);
    const lists = kinds.map((t) => ({ t, xs: items.filter((x) => x.type === t.id) })).filter((x) => x.xs.length);

    return { ym, from, to, partial: to < to0, D, active, cats, doneMin, planMin, prevMin, prevCats, rhythm, busiest, bestWd, streak, streakEnd,
      doneT, withDue, onTime, late, created, slowest, daysTaken, subsDone, goals, moodDays, moodCount, topMood, moodLink, happyWd, notes, longest, lists };
  }

  /* ---------- cards ---------- */
  const card = (cls, body) => `<section class="mcard ${cls}">${body}</section>`;
  const big = (n, unit) => `<div class="mc-big"><b>${n}</b>${unit ? `<span>${unit}</span>` : ""}</div>`;

  function cards(S) {
    const name = P.profile()?.nickname || "你";
    const out = [];
    const range = `${short(S.from)} – ${short(S.to)}${S.partial ? "（这个月还没过完）" : ""}`;
    out.push(card("mc-cover", `
      <p class="mc-kicker">${esc(name)} 的</p>
      <h2>${monthName(S.ym)}</h2>
      <p class="mc-range">${range}</p>
      <div class="mc-trio">
        <div><b>${S.active.length}</b><span>天有记录</span></div>
        <div><b>${hrs(S.doneMin)}</b><span>小时打了勾</span></div>
        <div><b>${S.doneT.length}</b><span>个短期目标完成</span></div>
      </div>
      ${S.streak >= 3 ? `<p class="mc-foot">最长连续记录了 <b>${S.streak}</b> 天（到 ${short(S.streakEnd)}）</p>` : ""}`));

    if (S.cats.length) {
      const top = S.cats[0], total = S.doneMin || 1;
      const diff = S.doneMin - S.prevMin;
      out.push(card("mc-time", `
        <h3>时间都去哪了</h3>
        <p class="mc-line">你把最多的时间给了 <b style="color:${top.c.color}">${top.c.emoji} ${esc(top.c.label)}</b></p>
        ${big(hrs(top.min), `小时 · 占 ${Math.round((top.min / total) * 100)}%`)}
        <div class="mc-stack">${S.cats.map((r) => `<i style="flex:${r.min};background:${r.c.color}" title="${esc(r.c.label)} ${hrs(r.min)}h"></i>`).join("")}</div>
        <ul class="mc-legend">${S.cats.slice(0, 6).map((r) => {
          const p = S.prevCats.get(r.c.id || "none")?.min || 0, d = r.min - p;
          return `<li><i style="background:${r.c.color}"></i>${r.c.emoji} ${esc(r.c.label)} <b>${hrs(r.min)}h</b>${S.prevMin && Math.abs(d) >= 60 ? `<em class="${d > 0 ? "up" : "down"}">${d > 0 ? "↑" : "↓"}${hrs(Math.abs(d))}</em>` : ""}</li>`;
        }).join("")}</ul>
        <p class="mc-foot">${S.prevMin ? `比上个月${diff >= 0 ? "多" : "少"}了 ${hrs(Math.abs(diff))} 小时。` : ""}计划了 ${hrs(S.planMin)} 小时，完成率 ${S.planMin ? Math.round((S.doneMin / S.planMin) * 100) : 0}%。</p>`));
    }

    if (S.rhythm) {
      const R = S.rhythm;
      out.push(card("mc-rhythm", `
        <h3>你的作息</h3>
        <div class="mc-type"><span>${R.type[0]}</span><b>${R.type[1]}</b></div>
        <p class="mc-line">平均 <b>${hm(R.start)}</b> 开始第一件事，<b>${hm(R.end)}</b> 结束最后一件</p>
        <p class="mc-foot">最早的一天：${short(R.earliest.d)} ${hm(R.earliest.m)} 就开始了<br>最晚的一天：${short(R.latest.d)} 忙到 ${hm(R.latest.m)}</p>`));
    }

    if (S.busiest && S.busiest.doneMin) {
      const B = S.busiest;
      out.push(card("mc-busy", `
        <h3>最充实的一天</h3>
        ${big(`${+B.d.slice(5, 7)}月${+B.d.slice(8)}日`, `${WEEK[parseYmd(B.d).getDay()]} · ${hrs(B.doneMin)} 小时`)}
        <ul class="mc-mini">${B.done.slice(0, 6).map((e) => `<li><i style="background:${catOf(e).color}"></i>${e.start} ${esc(e.title)}</li>`).join("")}${B.done.length > 6 ? `<li>…还有 ${B.done.length - 6} 件</li>` : ""}</ul>
        ${S.bestWd.v ? `<p class="mc-foot">平均来看，你最拼的是<b>${WEEK[S.bestWd.i]}</b>（每次约 ${hrs(S.bestWd.v)} 小时）</p>` : ""}`));
    }

    if (S.doneT.length || S.late.length) {
      out.push(card("mc-todo", `
        <h3>短期目标</h3>
        ${big(S.doneT.length, "个完成")}
        <p class="mc-line">${S.withDue.length ? `有截止日期的 ${S.withDue.length} 个里，<b>${S.onTime.length}</b> 个按时完成（${Math.round((S.onTime.length / S.withDue.length) * 100)}%）` : "这个月完成的都是没有截止日期的事"}</p>
        ${S.subsDone ? `<p class="mc-line">一共拆了 ${S.subsDone} 个小任务</p>` : ""}
        ${S.slowest ? `<p class="mc-foot">坚持最久才完成的：「${esc(S.slowest.title)}」，前后用了 ${S.daysTaken(S.slowest)} 天</p>` : ""}
        ${S.late.length ? `<p class="mc-foot warn">还有 ${S.late.length} 个过了截止没做完：${S.late.slice(0, 3).map((t) => esc(t.title)).join("、")}${S.late.length > 3 ? "…" : ""}</p>` : ""}`));
    }

    if (S.goals.length) {
      out.push(card("mc-goals", `
        <h3>离长期目标更近了吗</h3>
        <ul class="mc-goal">${S.goals.map(({ g, n, p, achieved }) => `
          <li data-open-goal="${g.id}"><span>${esc(g.emoji || "🌟")}</span><div><b>${esc(g.title)}</b>
            <small>${achieved ? "🏆 这个月达成了！" : n ? `这个月推进了 ${n} 个短期目标` : "这个月还没有推进"}</small></div>
            <em>${p == null ? "—" : Math.round(p * 100) + "%"}</em></li>`).join("")}</ul>`));
    }

    if (S.moodDays.length) {
      const max = Math.max(...S.moodCount.map((x) => x.n));
      out.push(card("mc-mood", `
        <h3>这个月的心情</h3>
        <div class="mc-type"><span>${S.topMood.m}</span><b>出现了 ${S.topMood.n} 天</b></div>
        <div class="mc-bars">${S.moodCount.map((x) => `<div><i style="height:${max ? (x.n / max) * 100 : 0}%"></i><span>${x.m}</span><small>${x.n}</small></div>`).join("")}</div>
        ${S.moodLink ? `<p class="mc-line">💡 有 <b>${S.moodLink.c.emoji} ${esc(S.moodLink.c.label)}</b> 的日子，你的心情明显更好</p>` : ""}
        ${S.happyWd && S.happyWd.v > 0 ? `<p class="mc-foot">心情最好的是${WEEK[S.happyWd.i]}。记了 ${S.moodDays.length} 天心情。</p>` : `<p class="mc-foot">记了 ${S.moodDays.length} 天心情。</p>`}`));
    }

    if (S.notes.length) {
      const chars = S.notes.reduce((a, x) => a + x.note.length, 0);
      out.push(card("mc-notes", `
        <h3>写下的话</h3>
        ${big(chars, `字 · ${S.notes.length} 天`)}
        ${S.longest ? `<blockquote>“${esc(S.longest.note.slice(0, 70))}${S.longest.note.length > 70 ? "…" : ""}”<cite>— ${short(S.longest.d)}，写得最多的一天</cite></blockquote>` : ""}`));
    }

    if (S.lists.length) {
      out.push(card("mc-lists", `
        <h3>这个月的收藏</h3>
        <ul class="mc-list">${S.lists.map(({ t, xs }) => `<li><span>${t.icon} ${esc(t.label)} <b>${xs.length}</b></span>
          <small>${xs.slice(0, 5).map((x) => esc(x.name)).join(" · ")}${xs.length > 5 ? " …" : ""}</small></li>`).join("")}</ul>`));
    }
    return out.join("");
  }

  /* ---------- AI portrait ---------- */
  function buildPack(S) {
    const s = P.get();
    const name = P.profile()?.nickname || "我";
    const L = [];
    L.push(`请你当一个温暖、细心、说真话的朋友，根据下面 ${name} 在 ${S.ym.slice(0, 4)} 年 ${monthName(S.ym)}的真实记录，给 ${name} 写一份「月度画像」，帮 ${name} 更认识自己。`);
    L.push(`要求：只根据记录说话，不要编造；语气像朋友，不说教；总共 400 字以内；按下面的格式：`);
    L.push(`关键词：词1 · 词2 · 词3`);
    L.push(`【这个月的你】2–3 句，从时间、作息、情绪、目标几个角度画像`);
    L.push(`【做得好的】2–3 点`);
    L.push(`【值得留意的】1–2 个规律或模式（比如拖延、作息、情绪和哪些事有关）`);
    L.push(`【下个月试试】3 条具体、能做到的小建议，尽量和长期目标联系起来`);
    L.push("");
    L.push(`【这个月的数字】${S.partial ? `（统计到 ${short(S.to)}，这个月还没过完）` : ""}`);
    L.push(`- 有记录的天数：${S.active.length} / ${S.D.length}，最长连续 ${S.streak} 天`);
    if (S.cats.length) L.push(`- 打勾完成的日程共 ${hrs(S.doneMin)} 小时（计划 ${hrs(S.planMin)} 小时；上个月 ${hrs(S.prevMin)} 小时）：${S.cats.map((r) => `${r.c.label} ${hrs(r.min)}h`).join("、")}`);
    if (S.rhythm) L.push(`- 作息：平均 ${hm(S.rhythm.start)} 开始第一件事，${hm(S.rhythm.end)} 结束最后一件；最早 ${short(S.rhythm.earliest.d)} ${hm(S.rhythm.earliest.m)}，最晚 ${short(S.rhythm.latest.d)} ${hm(S.rhythm.latest.m)}`);
    if (S.busiest?.doneMin) L.push(`- 最充实的一天：${short(S.busiest.d)}（${hrs(S.busiest.doneMin)} 小时）；平均最忙的是${WEEK[S.bestWd.i]}`);
    L.push(`- 短期目标：完成 ${S.doneT.length} 个${S.withDue.length ? `，有截止的 ${S.withDue.length} 个里按时 ${S.onTime.length} 个` : ""}；新加了 ${S.created.length} 个；过了截止还没完成 ${S.late.length} 个${S.late.length ? `（${S.late.map((t) => t.title).join("、")}）` : ""}`);
    if (S.moodDays.length) L.push(`- 心情（${MOODS.join(" ")} 从好到差）：${S.moodCount.filter((x) => x.n).map((x) => `${x.m}×${x.n}`).join(" ")}${S.moodLink ? `；有「${S.moodLink.c.label}」的日子心情更好` : ""}`);
    if (S.lists.length) L.push(`- 清单：${S.lists.map(({ t, xs }) => `${t.label} ${xs.length}（${xs.map((x) => x.name).join("、")}）`).join("；")}`);
    L.push("");
    const goals = P.goalSummary?.() || [];
    if (goals.length) L.push(...goals, "");
    L.push("【每天的记录】（✅ 是打了勾的日程，☑️ 是完成的短期目标）");
    for (const x of S.D) {
      const parts = [];
      if (x.mood) parts.push(`心情${x.mood}`);
      if (x.done.length) parts.push(x.done.map((e) => `✅${e.start} ${e.title}${catOf(e).id ? `[${catOf(e).label}]` : ""}`).join("；"));
      const missed = x.evs.filter((e) => !isEventDone(e, x.d));
      if (missed.length && x.d < todayStr()) parts.push(`没打勾：${missed.map((e) => e.title).join("、")}`);
      if (x.todos.length) parts.push(x.todos.map((t) => `☑️${t.title}`).join("；"));
      if (x.note) parts.push(`笔记：${x.note.replace(/\s+/g, " ").slice(0, 160)}${x.note.length > 160 ? "…" : ""}`);
      if (parts.length) L.push(`${short(x.d)} ${WEEK[parseYmd(x.d).getDay()]}｜${parts.join("｜")}`);
    }
    return L.join("\n");
  }

  function portraitHtml(r) {
    const lines = r.text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    let kw = [];
    const body = [];
    for (const ln of lines) {
      const m = /^(?:\*\*)?关键词(?:\*\*)?\s*[:：]\s*(.+)$/.exec(ln);
      if (m && !kw.length) { kw = m[1].replace(/\*\*/g, "").split(/\s*[·・|｜,，、/]\s*|\s{2,}/).map((x) => x.trim()).filter(Boolean).slice(0, 5); continue; }
      const h = /^(?:#+\s*)?(?:\*\*)?【([^】]+)】(?:\*\*)?\s*(.*)$/.exec(ln);
      if (h) { body.push(`<h4>${esc(h[1])}</h4>`); if (h[2]) body.push(`<p>${esc(h[2].replace(/\*\*/g, ""))}</p>`); continue; }
      body.push(`<p>${esc(ln.replace(/^#+\s*/, "").replace(/\*\*/g, ""))}</p>`);
    }
    return `${kw.length ? `<div class="mp-kw">${kw.map((k) => `<span>${esc(k)}</span>`).join("")}</div>` : ""}<div class="mp-body">${body.join("")}</div>
      <p class="mp-meta">保存于 ${esc((r.updatedAt || r.createdAt || "").slice(0, 10))}</p>`;
  }

  function aiCard(S) {
    const r = savedFor(S.ym);
    if (r && !editing) {
      return card("mc-ai has", `<h3>🪞 AI 眼中的${monthName(S.ym)}的你</h3>${portraitHtml(r)}
        <div class="mp-acts"><button type="button" class="ghost small" data-mp-redo>重新粘贴</button>
        <button type="button" class="ghost small" data-mp-del>删除</button></div>`);
    }
    return card("mc-ai", `
      <h3>🪞 让 AI 给你画个像</h3>
      <ol class="mp-steps">
        <li><button type="button" class="primary" data-mp-copy>📋 复制这个月的记录</button> <span class="hint" id="mpCopied"></span></li>
        <li>粘贴给 DeepSeek、豆包、Kimi、ChatGPT 或 Claude</li>
        <li>把它写的画像整段粘贴回来，存在这里：
          <textarea id="mpPaste" rows="5" placeholder="关键词：…&#10;【这个月的你】…">${esc(r?.text || "")}</textarea>
          <button type="button" class="primary" data-mp-save>保存画像</button>${r ? ` <button type="button" class="ghost small" data-mp-cancel>取消</button>` : ""}</li>
      </ol>`);
  }

  /* ---------- page ---------- */
  const page = $("#monthPage");
  let ym = null, editing = false;

  function defaultYm() { const t = todayStr(); return +t.slice(8) <= 7 ? shiftYm(ymOf(t), -1) : ymOf(t); }
  function open(m) {
    ym = m || defaultYm(); editing = false;
    localStorage.setItem(SEEN_KEY, ym);
    if (location.hash !== "#month") history.pushState(null, "", "#month");
    show();
  }
  function show() {
    ym ||= defaultYm();
    page.hidden = false; document.body.classList.add("goals-open");
    renderPage(); page.scrollTop = 0;
    renderNudge();
  }
  function hide() { page.hidden = true; if ($("#goalsPage").hidden) document.body.classList.remove("goals-open"); }
  function close() { if (location.hash === "#month") history.back(); else hide(); }
  addEventListener("hashchange", () => (location.hash === "#month" ? show() : hide()));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !page.hidden && !$("#editDlg").open) close(); });

  function renderPage() {
    if (page.hidden) return;
    const typing = $("#mpPaste")?.value;
    const S = stats(ym);
    const cur = ymOf(todayStr());
    $("#monthNav").innerHTML = `<button type="button" class="nav" data-mshift="-1" aria-label="上个月">‹</button>
      <b>${ym.slice(0, 4)} 年 ${monthName(ym)}</b>
      <button type="button" class="nav" data-mshift="1" aria-label="下个月" ${ym >= cur ? "disabled" : ""}>›</button>`;
    $("#monthCards").innerHTML = !S.active.length && !S.doneMin
      ? `<div class="gp-empty"><p>${monthName(ym)}还没有记录。<br>每天给日程打勾 ✅、写一句笔记、点一个心情，月底这里就会长出你的月度回顾。</p></div>`
      : `<div class="mcards">${cards(S)}${aiCard(S)}</div>`;
    if (typing != null && $("#mpPaste") && !$("#mpPaste").value) $("#mpPaste").value = typing;
  }

  page.addEventListener("click", async (e) => {
    const b = e.target.closest("button, [data-open-goal]"); if (!b) return;
    const d = b.dataset;
    if (b.id === "monthBack") close();
    else if (d.mshift) { ym = shiftYm(ym, +d.mshift); editing = false; renderPage(); page.scrollTop = 0; }
    else if ("mpCopy" in d) {
      const text = buildPack(stats(ym));
      try { await navigator.clipboard.writeText(text); $("#mpCopied").textContent = "已复制 ✓ 去粘贴给 AI 吧"; }
      catch (_) {
        await P.dialog("复制这个月的记录", `<textarea id="mpText" rows="12" readonly style="width:100%">${esc(text)}</textarea><p class="hint">全选后复制（⌘C / Ctrl+C）</p>`, [{ value: "ok", label: "好", cls: "primary" }]);
      }
    } else if ("mpSave" in d) {
      const text = $("#mpPaste").value.trim(); if (!text) return;
      const now = new Date().toISOString();
      const r = savedFor(ym);
      if (r) Object.assign(r, { text, updatedAt: now });
      else reviews().push({ id: `m-${ym}`, month: ym, text, createdAt: now });
      editing = false; P.commit();
      P.toast(`已保存${monthName(ym)}的画像 ✓`);
    } else if ("mpRedo" in d) { editing = true; renderPage(); $("#mpPaste")?.focus(); }
    else if ("mpCancel" in d) { editing = false; renderPage(); }
    else if ("mpDel" in d) {
      if (!confirm(`删除${monthName(ym)}的 AI 画像？删除后不能恢复（可以再粘贴一次）。`)) return;
      const s = P.get(); s.reviews = reviews().filter((x) => x.id !== `m-${ym}`); P.commit();
    } else if (d.openGoal) { hide(); P.openGoal?.(d.openGoal); } // ← back returns here
  });

  /* ---------- entry points ---------- */
  $("#monthBtn").onclick = () => open();
  // first week of a month: a gentle nudge on the home page to look back at last month
  function renderNudge() {
    const box = $("#monthNudge");
    const t = todayStr(), prev = shiftYm(ymOf(t), -1);
    const hasData = () => { for (let d = `${prev}-01`; d <= lastDay(prev); d = addDays(d, 1)) if (eventsOn(d).some((e) => isEventDone(e, d)) || P.get().moods[d]) return true; return false; };
    const show = +t.slice(8) <= 7 && localStorage.getItem(SEEN_KEY) !== prev && hasData();
    box.hidden = !show;
    if (show) box.innerHTML = `🌙 你的 <b>${monthName(prev)}回顾</b> 准备好了，来看看这个月的自己 →`;
  }
  $("#monthNudge").onclick = () => open(shiftYm(ymOf(todayStr()), -1));

  P.month = { stats, buildPack, open };
  P.renderHooks.push(renderPage, renderNudge);
  renderNudge();
  if (location.hash === "#month") show();
})();
