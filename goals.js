/* Long-term goals: a strip on the home page + a page of their own (#goals).
   A goal has milestones (steps) and short-term goals (to-dos with t.goal = goal.id);
   its progress is the average completion of all of them. */
(() => {
  "use strict";
  const P = window.Planner;
  const { esc, uid, ymd, pad, liveTodos, liveGoals, fmtDue } = P.util;
  const $ = (s) => document.querySelector(s);

  const linked = (g) => liveTodos().filter((t) => t.goal === g.id);
  const todoShare = (t) => { if (t.done) return 1; const s = t.subs || []; return s.length ? s.filter((x) => x.done).length / s.length : 0; };
  function progress(g) {
    const parts = [...(g.steps || []).map((x) => (x.done ? 1 : 0)), ...linked(g).map(todoShare)];
    return g.done ? 1 : parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  }
  const pct = (p) => (p == null ? "—" : `${Math.round(p * 100)}%`);
  const nowLocal = () => { const n = new Date(); return `${ymd(n)}T${pad(n.getHours())}:${pad(n.getMinutes())}`; };
  const find = (id) => liveGoals().find((g) => g.id === id);

  /* ---------- home strip ---------- */
  function ring(p, size = 34) {
    const r = size / 2 - 3, c = 2 * Math.PI * r, v = p ?? 0;
    return `<svg class="gs-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="bg"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  }
  function renderStrip() {
    const active = liveGoals().filter((g) => !g.done);
    const box = $("#goalStrip");
    if (!active.length) {
      box.className = "goal-strip empty";
      box.innerHTML = `<span class="gs-label">🌟 长期目标</span><span class="gs-empty">还没有长期目标。点这里，写下一件你想花很久去做成的事 →</span>`;
      return;
    }
    box.className = "goal-strip";
    const shown = active.slice(0, 4);
    box.innerHTML = `<span class="gs-label">🌟 长期目标</span>
      <div class="gs-items">${shown.map((g) => {
        const p = progress(g);
        return `<div class="gs-item" data-open-goal="${g.id}">${ring(p)}<span class="gs-pct">${pct(p)}</span>
          <div class="gs-txt"><b>${esc(g.emoji || "🌟")} ${esc(g.title)}</b>${g.target ? `<small>${esc(g.target)}</small>` : ""}</div></div>`;
      }).join("")}${active.length > shown.length ? `<span class="gs-more">+${active.length - shown.length}</span>` : ""}</div>
      <span class="gs-go">查看全部 →</span>`;
  }

  /* ---------- the goals page ---------- */
  const page = $("#goalsPage");
  let focusId = null, addingStep = null, showDone = false;

  function open(id) {
    focusId = id || null;
    if (location.hash !== "#goals") history.pushState(null, "", "#goals");
    show();
  }
  function show() {
    page.hidden = false;
    document.body.classList.add("goals-open");
    renderPage();
    if (focusId) setTimeout(() => page.querySelector(`[data-goal="${focusId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
    else page.scrollTop = 0;
  }
  function hide() { page.hidden = true; document.body.classList.remove("goals-open"); addingStep = null; }
  function close() { if (location.hash === "#goals") history.back(); else hide(); }
  addEventListener("hashchange", () => (location.hash === "#goals" ? show() : hide()));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !page.hidden && !$("#editDlg").open && !addingStep) close(); });
  $("#goalsBack").onclick = close;
  $("#goalNew").onclick = () => editGoal(null);
  const strip = $("#goalStrip");
  strip.onclick = (e) => open(e.target.closest("[data-open-goal]")?.dataset.openGoal);
  strip.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  // the 🌟 chip on a short-term goal jumps to its long-term goal
  document.addEventListener("click", (e) => {
    const c = e.target.closest(".goal-chip[data-open-goal]"); if (c) { e.stopPropagation(); open(c.dataset.openGoal); }
  }, true);

  function goalCard(g) {
    const p = progress(g), steps = g.steps || [], todos = linked(g);
    const openT = todos.filter((t) => !t.done).sort((a, b) => (a.due || "~").localeCompare(b.due || "~"));
    const doneT = todos.filter((t) => t.done);
    return `<article class="gcard ${g.done ? "achieved" : ""} ${g.id === focusId ? "focus" : ""}" data-goal="${g.id}">
      <header>
        <span class="gc-emoji">${esc(g.emoji || "🌟")}</span>
        <div class="gc-h"><h2>${esc(g.title)}</h2>${g.target ? `<span class="gc-target">🎯 ${esc(g.target)}</span>` : ""}</div>
        <div class="gc-acts">
          <button type="button" class="icon-btn" data-gedit="${g.id}" title="编辑">✎</button>
          <button type="button" class="icon-btn" data-gdel="${g.id}" title="删除">🗑</button>
        </div>
      </header>
      ${g.why ? `<p class="gc-why">“${esc(g.why)}”</p>` : ""}
      <div class="gc-prog"><i><b style="width:${Math.round((p ?? 0) * 100)}%"></b></i><span>${g.done ? "🏆 已达成" : pct(p)}</span></div>

      <h3>里程碑 <small>${steps.filter((x) => x.done).length}/${steps.length}</small></h3>
      <ul class="gc-steps">${steps.map((x) => `
        <li class="${x.done ? "is-done" : ""}"><input type="checkbox" class="chk sm" data-step-done="${g.id}:${x.id}" ${x.done ? "checked" : ""} />
          <span>${esc(x.title)}</span><button type="button" class="icon-btn" data-step-del="${g.id}:${x.id}" title="删除">✕</button></li>`).join("")}
        ${addingStep === g.id ? `<li class="sub-add"><input type="text" data-step-input="${g.id}" placeholder="里程碑，回车添加；Esc 结束" /></li>`
          : g.done ? "" : `<li><button type="button" class="link-btn" data-step-new="${g.id}">＋ 加一个里程碑</button></li>`}
      </ul>

      <h3>短期目标 <small>${doneT.length}/${todos.length} 完成</small></h3>
      <ul class="gc-todos">${openT.map((t) => `
        <li><input type="checkbox" class="chk sm" data-gtodo-done="${t.id}" />
          <span class="gt-t">${esc(t.title)}</span>
          <small>${t.due ? `⏰ ${fmtDue(t)}` : "没有截止"}${(t.subs || []).length ? ` · ${Math.round(todoShare(t) * 100)}%` : ""}</small></li>`).join("")}
        ${doneT.length ? `<li class="gt-done">✔️ 已完成 ${doneT.length} 个：${doneT.slice(-4).map((t) => esc(t.title)).join("、")}${doneT.length > 4 ? "…" : ""}</li>` : ""}
        ${g.done ? "" : `<li><button type="button" class="link-btn" data-gtodo-new="${g.id}">＋ 拆一个短期目标</button><span class="hint"> 会出现在每天的「🎯 短期目标」里</span></li>`}
      </ul>

      <footer>${g.done
        ? `<button type="button" class="ghost small" data-gdone="${g.id}">↩︎ 重新打开</button>`
        : `<button type="button" class="ghost small" data-gdone="${g.id}">🏁 标记为已达成</button>`}
        <span class="gc-since">开始于 ${esc((g.createdAt || "").slice(0, 10))}</span></footer>
    </article>`;
  }

  function renderPage() {
    if (page.hidden) return;
    const typing = document.activeElement?.dataset?.stepInput ? document.activeElement.value : null;
    const all = liveGoals();
    const active = all.filter((g) => !g.done), done = all.filter((g) => g.done);
    $("#goalList").innerHTML = !all.length
      ? `<div class="gp-empty"><p>长期目标是那些需要几个月、甚至几年去做成的事：<br>拿到某个 offer、学会一门语言、跑完一场马拉松、写完一本书……</p>
          <button type="button" class="primary" data-gnew>＋ 写下第一个长期目标</button></div>`
      : `<div class="gcards">${active.map(goalCard).join("")}</div>
        ${done.length ? `<button type="button" class="ghost small gp-toggle" data-toggle-done>🏆 已达成的目标 ${done.length} ${showDone ? "▾" : "▸"}</button>
          ${showDone ? `<div class="gcards">${done.map(goalCard).join("")}</div>` : ""}` : ""}`;
    const box = addingStep && page.querySelector(`[data-step-input="${addingStep}"]`);
    if (box) { if (typing != null) box.value = typing; box.focus(); }
  }

  page.addEventListener("click", async (e) => {
    const b = e.target.closest("button, input[type=checkbox]"); if (!b) return;
    const d = b.dataset;
    const s = P.get();
    if ("gnew" in d) editGoal(null);
    else if (d.gedit) editGoal(d.gedit);
    else if (d.gdel) {
      const g = find(d.gdel); if (!g) return;
      g.deletedAt = new Date().toISOString(); P.commit();
      P.toast(`已把长期目标「${g.title}」放进垃圾箱`, () => P.trash(`g:${g.id}`, "restore"));
    } else if (d.gdone) {
      const g = find(d.gdone); if (!g) return;
      g.done = !g.done; g.doneAt = g.done ? nowLocal() : null; P.commit();
      if (g.done) P.toast(`🏆 恭喜！「${g.title}」达成了`);
    } else if ("toggleDone" in d) { showDone = !showDone; renderPage(); }
    else if (d.stepNew) { addingStep = d.stepNew; renderPage(); }
    else if (d.stepDone) {
      const [gid, sid] = d.stepDone.split(":"); const x = (find(gid)?.steps || []).find((y) => y.id === sid); if (!x) return;
      x.done = b.checked; P.commit();
    } else if (d.stepDel) {
      const [gid, sid] = d.stepDel.split(":"); const g = find(gid); if (!g) return;
      const i = g.steps.findIndex((y) => y.id === sid); if (i < 0) return;
      const [gone] = g.steps.splice(i, 1); P.commit();
      P.toast(`已删除里程碑「${gone.title}」`, () => { const x = find(gid); if (x) (x.steps ||= []).splice(i, 0, gone); });
    } else if (d.gtodoDone) {
      const t = s.todos.find((x) => x.id === d.gtodoDone); if (!t) return;
      t.done = true; t.doneAt = nowLocal(); P.commit();
      P.toast(`完成了「${t.title}」✓`, () => { const x = P.get().todos.find((y) => y.id === t.id); if (x) { x.done = false; x.doneAt = null; } });
    } else if (d.gtodoNew) newTodoFor(d.gtodoNew);
  });
  page.addEventListener("keydown", (e) => {
    const inp = e.target.closest("[data-step-input]"); if (!inp) return;
    if (e.key === "Escape") { e.stopPropagation(); addingStep = null; renderPage(); return; }
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    const v = inp.value.trim(); if (!v) return;
    const g = find(inp.dataset.stepInput); if (!g) return;
    (g.steps ||= []).push({ id: uid(), title: v, done: false });
    inp.value = ""; P.commit();
  });
  page.addEventListener("focusout", (e) => {
    const inp = e.target.closest("[data-step-input]");
    if (inp && !inp.value.trim()) setTimeout(() => { if (addingStep === inp.dataset.stepInput && !page.querySelector("[data-step-input]:focus")) { addingStep = null; renderPage(); } }, 150);
  });

  async function editGoal(id) {
    const g = id ? find(id) : null;
    const r = await P.dialog(g ? "编辑长期目标" : "新的长期目标", `
      <div class="two"><label class="emoji-l">图标<input type="text" id="gEmoji" value="${esc(g?.emoji || "🌟")}" maxlength="4" /></label>
      <label>想做成什么？<input type="text" id="gTitle" value="${esc(g?.title || "")}" placeholder="例如：拿到暑期实习 offer" /></label></div>
      <label>为什么想做成它？<textarea id="gWhy" rows="2" placeholder="写给以后想放弃的自己（可不填）">${esc(g?.why || "")}</textarea></label>
      <label>希望什么时候做成？<input type="text" id="gTarget" value="${esc(g?.target || "")}" placeholder="例如：2027 年夏天 / 毕业前（可不填）" /></label>
      ${g ? "" : `<label>先想几个里程碑？<textarea id="gSteps" rows="3" placeholder="一行一个（可不填），例如：&#10;改好简历&#10;投 20 家公司&#10;拿到第一个面试"></textarea></label>`}`,
      [{ value: "cancel", label: "取消" }, { value: "ok", label: g ? "保存" : "创建", cls: "primary" }]);
    if (r !== "ok") return;
    const title = $("#gTitle").value.trim(); if (!title) return;
    const vals = { title, emoji: $("#gEmoji").value.trim() || "🌟", why: $("#gWhy").value.trim(), target: $("#gTarget").value.trim() };
    const s = P.get();
    if (g) { const cur = find(g.id); if (cur) Object.assign(cur, vals); focusId = g.id; }
    else {
      const steps = ($("#gSteps").value || "").split("\n").map((x) => x.trim()).filter(Boolean).map((t) => ({ id: uid(), title: t, done: false }));
      const ng = { id: uid(), ...vals, steps, done: false, doneAt: null, createdAt: new Date().toISOString() };
      (s.goals ||= []).push(ng); focusId = ng.id;
    }
    P.commit();
  }

  async function newTodoFor(gid) {
    const g = find(gid); if (!g) return;
    const r = await P.dialog(`拆一个短期目标`, `
      <p class="hint">属于「${esc(g.emoji || "🌟")} ${esc(g.title)}」。它会出现在每天的「🎯 短期目标」里。</p>
      <label>具体要做什么？<input type="text" id="ntTitle" placeholder="例如：这周改完简历" /></label>
      <label class="inline-chk"><input type="checkbox" id="ntNoDue" /> 不设截止日期</label>
      <div class="two" id="ntDueRow"><label>截止日期<input type="date" id="ntDate" value="${P.selected()}" /></label>
      <label>时间<input type="time" id="ntTime" value="23:59" /></label></div>`,
      [{ value: "cancel", label: "取消" }, { value: "ok", label: "添加", cls: "primary" }]);
    if (r !== "ok") return;
    const title = $("#ntTitle").value.trim(); if (!title) return;
    const noDue = $("#ntNoDue").checked;
    P.get().todos.push({ id: uid(), title, due: noDue || !$("#ntDate").value ? "" : `${$("#ntDate").value}T${$("#ntTime").value || "23:59"}`,
      prio: 1, tag: "", goal: gid, done: false, doneAt: null, createdAt: new Date().toISOString() });
    focusId = gid; P.commit();
  }
  $("#editBody").addEventListener("change", (e) => { if (e.target.id === "ntNoDue") $("#ntDueRow").hidden = e.target.checked; });

  // for the weekly AI pack
  P.goalSummary = () => {
    const active = liveGoals().filter((g) => !g.done);
    if (!active.length) return [];
    const L = ["【我的长期目标】"];
    for (const g of active) {
      L.push(`- ${g.emoji || "🌟"}${g.title}（进度 ${pct(progress(g))}${g.target ? `，希望 ${g.target} 做成` : ""}）${g.why ? `——为什么：${g.why}` : ""}`);
      const st = g.steps || [];
      if (st.length) L.push(`  里程碑：${st.map((x) => `${x.done ? "✅" : "⬜"}${x.title}`).join(" ")}`);
      const open = linked(g).filter((t) => !t.done);
      if (open.length) L.push(`  进行中的短期目标：${open.map((t) => t.title).join("、")}`);
    }
    return L;
  };
  P.goalProgress = progress;
  P.openGoal = open;

  P.renderHooks.push(renderStrip, renderPage);
  renderStrip();
  if (location.hash === "#goals") show();
})();
