// Cloud sync: Firebase Auth + Firestore. Falls back to local-only if not configured.
//
// Firestore layout (one document per item, so a server / native app can query them later):
//   users/{uid}/todos/{id}   { title, due, dueAt(Timestamp), prio, tag, done, doneAt, createdAt, updatedAt }
//   users/{uid}/events/{id}  { title, start, end, note, color, repeat, date, skip[], doneOn[], updatedAt }
//   users/{uid}/days/{date}  { note, mood, updatedAt }
//   users/{uid}/lists/{id}   { type, name, date, note, city?, person?, occasion?, createdAt, deletedAt? }  (movies, restaurants, gifts…)
//   users/{uid}/listTypes/{id} { label, icon }  user-made list kinds
//   users/{uid}/goals/{id}   { title, emoji, why, target, steps[{id,title,done}], done, doneAt, createdAt, deletedAt? }  long-term goals
//   users/{uid}/inbox/{id}   { source, kind, title, due?, date?, start?, end?, tag, note, from, src, createdAt }  found by Claude, waiting for you to tick what to import
import { FIREBASE_CONFIG, ALLOWED_EMAILS } from "./firebase-config.js";

const V = "10.12.2";
const box = document.getElementById("syncBox");
const gate = document.getElementById("gate");
const gateMsg = document.getElementById("gateMsg");
const gateBtns = document.getElementById("gateBtns");
function lock(msg, showButtons) {
  document.body.classList.add("locked");
  gate.hidden = false;
  gateMsg.textContent = msg || "";
  gateBtns.hidden = !showButtons;
}
function unlock() {
  document.body.classList.remove("locked");
  gate.hidden = true;
}
// state arrays that map 1:1 to a collection of {id}-keyed documents
const ARRAYS = ["todos", "events", "lists", "listTypes", "goals", "reviews", "inbox"];
const NAMES = [...ARRAYS, "days"];
const emptyMirror = () => Object.fromEntries(NAMES.map((n) => [n, new Map()]));
const META_FIELDS = ["updatedAt", "dueAt"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const show = (html) => { box.innerHTML = html; };

// key-order-independent JSON, used to compare local vs remote items
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
const clean = (data) => { const o = { ...data }; META_FIELDS.forEach((k) => delete o[k]); return o; };

async function waitForPlanner() {
  while (!window.Planner) await new Promise((r) => setTimeout(r, 20));
  return window.Planner;
}

async function main() {
  const Planner = await waitForPlanner();

  // local testing only: http://localhost:<port>/?emu  talks to the Firebase emulator
  const EMU = location.hostname === "localhost" && new URLSearchParams(location.search).has("emu");
  const config = EMU ? { apiKey: "demo-key", authDomain: "localhost", projectId: "demo-planner" } : FIREBASE_CONFIG;

  if (!config.apiKey) {
    lock("网站还没有配置 Firebase，暂时无法登录。", false);
    return;
  }
  lock("加载中…", false);

  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);

  const app = initializeApp(config);
  const a = auth.getAuth(app);
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
  if (EMU) {
    auth.connectAuthEmulator(a, "http://127.0.0.1:9099", { disableWarnings: true });
    fs.connectFirestoreEmulator(db, "127.0.0.1", 8085);
  }

  let user = null;
  let unsubs = [];
  let ready = false;
  let timer = null;
  // mirror of what Firestore has, per collection: Map<id, cleanedData>
  let mirror = emptyMirror();
  let profile = null; // { nickname, role, categories[] } from users/{uid}/meta/profile

  const col = (name) => fs.collection(db, "users", user.uid, name);

  /* ---------- status UI ---------- */
  function status(kind) {
    const label = { ok: "☁️ 已同步", saving: "⏳ 同步中…", offline: "📴 离线 · 联网后自动同步", err: "⚠️ 同步失败" }[kind];
    const name = esc(profile?.nickname || user.displayName || user.email);
    const avatar = user.photoURL ? `<img src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer" />` : "👤";
    show(`<span class="sync ${kind}">${label}</span>
      <span class="who" id="whoBtn" title="${esc(user.email)} · 点击修改称呼">${avatar}<span>${name}</span></span>
      <button class="ghost" id="logoutBtn">退出</button>`);
    document.getElementById("logoutBtn").onclick = logout;
    document.getElementById("whoBtn").onclick = () => askProfile(true);
  }

  /* ---------- who is this? (asked once per account, editable by clicking the name) ---------- */
  const profileRef = () => fs.doc(db, "users", user.uid, "meta", "profile");
  function applyName() {
    const nick = profile?.nickname || (user.displayName || user.email.split("@")[0]).split(" ")[0];
    document.getElementById("appTitle").textContent = `${nick}'s Daily Planner`;
    document.title = `${nick}'s Daily Planner · 每日日程本`;
  }
  async function loadProfile() {
    const uidAtStart = user.uid;
    try { const snap = await fs.getDoc(profileRef()); if (user?.uid === uidAtStart) profile = snap.exists() ? snap.data() : null; }
    catch (e) { console.warn("profile", e); return; } // offline with no cache: just use the Google name for now
    if (user?.uid !== uidAtStart) return;
    applyName(); if (ready) status("ok");
    Planner.setProfile(profile);
    // first visit (or before tags existed): ask name + what they do, and suggest tags
    if (!profile?.nickname || !profile?.categories) {
      while (document.getElementById("editDlg").open) await new Promise((r) => setTimeout(r, 300));
      const res = await Planner.onboard(profile, user.displayName || "");
      if (res && user?.uid === uidAtStart) saveProfile(res);
    }
  }
  function saveProfile(patch) {
    profile = { ...(profile || {}), ...patch };
    applyName(); status(ready ? "ok" : "saving");
    Planner.setProfile(profile);
    fs.setDoc(profileRef(), { ...profile, updatedAt: fs.serverTimestamp() }).catch((e) => { console.error(e); status("err"); });
  }
  async function askProfile(editing) {
    if (document.getElementById("editDlg").open) return;
    const gName = user.displayName || "";
    const nick = profile?.nickname ?? gName.split(" ")[0];
    const r = await Planner.dialog(editing ? "修改称呼" : "欢迎！先认识一下你 👋", `
      <label>希望我们怎么称呼你？<input type="text" id="pfNick" value="${esc(nick)}" placeholder="例如：小王" /></label>
      ${editing ? "" : `<p class="hint">只需要填一次，之后点右上角的名字可以修改。</p>`}`, [
      ...(editing ? [{ value: "cancel", label: "取消" }] : []),
      { value: "ok", label: "保存", cls: "primary" },
    ]);
    if (r !== "ok" || !user) return;
    const k = document.getElementById("pfNick").value.trim() || gName.split(" ")[0];
    if (!k) return;
    saveProfile({ nickname: k });
  }

  /* ---------- state <-> documents ---------- */
  function docsFromState(s) {
    const days = new Map();
    for (const d of new Set([...Object.keys(s.notes || {}), ...Object.keys(s.moods || {})])) {
      const note = s.notes?.[d] || "", mood = s.moods?.[d] || "";
      if (note || mood) days.set(d, { note, mood });
    }
    const strip = (o) => JSON.parse(JSON.stringify(o)); // drop undefined
    return {
      ...Object.fromEntries(ARRAYS.map((n) => [n, new Map((s[n] || []).map((x) => [x.id, strip(x)]))])),
      days,
    };
  }

  function stateFromDocs(m, base) {
    const s = { ...base, ...Object.fromEntries(ARRAYS.map((n) => [n, [...m[n].values()]])), notes: {}, moods: {} };
    for (const [d, v] of m.days) { if (v.note) s.notes[d] = v.note; if (v.mood) s.moods[d] = v.mood; }
    return s;
  }

  /* ---------- push local changes ---------- */
  async function push() {
    timer = null;
    if (!user || !ready) return;
    const local = docsFromState(Planner.get());
    const ops = [];
    for (const name of NAMES) {
      const L = local[name], R = mirror[name];
      for (const [id, v] of L) if (!R.has(id) || stable(R.get(id)) !== stable(v)) ops.push(["set", name, id, v]);
      for (const id of R.keys()) if (!L.has(id)) ops.push(["del", name, id]);
    }
    if (!ops.length) return;

    // optimistic: mirror now reflects what we are writing, so our own echoes are ignored
    for (const [op, name, id, v] of ops) op === "set" ? mirror[name].set(id, v) : mirror[name].delete(id);

    status(navigator.onLine ? "saving" : "offline");
    try {
      const commits = [];
      for (let i = 0; i < ops.length; i += 450) {
        const batch = fs.writeBatch(db);
        for (const [op, name, id, v] of ops.slice(i, i + 450)) {
          const ref = fs.doc(col(name), id);
          if (op === "del") { batch.delete(ref); continue; }
          const data = { ...v, updatedAt: fs.serverTimestamp() };
          if (name === "todos" && v.due) data.dueAt = fs.Timestamp.fromDate(new Date(v.due));
          batch.set(ref, data);
        }
        commits.push(batch.commit());
      }
      if (!navigator.onLine) return; // queued in the offline cache, sent when back online
      await Promise.all(commits);
      if (!timer) status("ok");
    } catch (e) {
      console.error(e);
      status("err");
    }
  }

  window.PlannerCloud = {
    saveProfile: (patch) => user && saveProfile(patch),
    queue() {
      if (!user || !ready) return;
      clearTimeout(timer);
      timer = setTimeout(push, 500);
    },
  };
  const flush = () => { if (timer) { clearTimeout(timer); push(); } };
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  addEventListener("online", () => user && status("ok"));
  addEventListener("offline", () => user && status("offline"));

  /* ---------- pull remote changes ---------- */
  function subscribe() {
    const names = NAMES;
    const firstLoaded = new Set();

    names.forEach((name) => {
      unsubs.push(fs.onSnapshot(col(name), (snap) => {
        if (!ready) {
          // initial load: take everything (including our own not-yet-sent writes from the offline cache)
          mirror[name] = new Map(snap.docs.map((d) => [d.id, clean(d.data())]));
          firstLoaded.add(name);
          if (firstLoaded.size === names.length) initialMerge(snap.metadata.fromCache);
          return;
        }
        let changed = false;
        const local = docsFromState(Planner.get());
        for (const ch of snap.docChanges()) {
          if (ch.doc.metadata.hasPendingWrites) continue; // our own write in flight
          const id = ch.doc.id;
          if (ch.type === "removed") {
            if (!mirror[name].has(id)) continue;
            mirror[name].delete(id); local[name].delete(id); changed = true;
          } else {
            const v = clean(ch.doc.data());
            if (mirror[name].has(id) && stable(mirror[name].get(id)) === stable(v)) continue; // ack of our own write
            mirror[name].set(id, v); local[name].set(id, v); changed = true;
          }
        }
        if (changed) Planner.replace(stateFromDocs(local, Planner.get()), { fromCloud: true });
        if (!timer) status(navigator.onLine ? "ok" : "offline");
      }, (err) => { console.error(err); status("err"); }));
    });
  }

  function initialMerge(fromCache) {
    const merged = Object.fromEntries(NAMES.map((n) => [n, new Map(mirror[n])]));
    const legacy = Planner.legacy();
    if (legacy) {
      // data from the old browser-only version: move it into the account once (cloud wins on conflicts)
      const local = docsFromState(legacy);
      for (const name of NAMES) for (const [id, v] of local[name]) if (!merged[name].has(id)) merged[name].set(id, v);
      Planner.clearLegacy();
    }
    ready = true;
    Planner.replace(stateFromDocs(merged, Planner.get()), { fromCloud: true });
    status(fromCache && !navigator.onLine ? "offline" : "ok");
    push(); // uploads anything that was only local
  }

  /* ---------- auth ---------- */
  async function googleLogin() {
    const provider = new auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(a, provider);
    } catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        await auth.signInWithRedirect(a, provider);
      } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        alert("登录失败：" + e.message);
      }
    }
  }

  async function emailLogin() {
    const r = await Planner.dialog("用邮箱登录", `
      <label>邮箱<input type="email" id="lgEmail" autocomplete="username" /></label>
      <label>密码（至少 6 位）<input type="password" id="lgPass" autocomplete="current-password" /></label>
      <p class="hint">第一次使用请点「注册」，之后在其他设备上用同样的邮箱和密码「登录」。</p>`, [
      { value: "cancel", label: "取消" },
      { value: "signup", label: "注册" },
      { value: "login", label: "登录", cls: "primary" },
    ]);
    if (r !== "login" && r !== "signup") return;
    const email = document.getElementById("lgEmail").value.trim();
    const pass = document.getElementById("lgPass").value;
    try {
      if (r === "signup") await auth.createUserWithEmailAndPassword(a, email, pass);
      else await auth.signInWithEmailAndPassword(a, email, pass);
    } catch (e) {
      const msg = {
        "auth/invalid-credential": "邮箱或密码不对。",
        "auth/wrong-password": "密码不对。",
        "auth/user-not-found": "这个邮箱还没注册，请先点「注册」。",
        "auth/email-already-in-use": "这个邮箱已经注册过了，请直接「登录」。",
        "auth/weak-password": "密码至少要 6 位。",
        "auth/invalid-email": "邮箱格式不对。",
        "auth/operation-not-allowed": "Firebase 里还没有开启「电子邮件/密码」登录方式。",
      }[e.code];
      alert(msg || "登录失败：" + e.message);
    }
  }

  async function logout() {
    flush();
    if (!confirm("确定退出登录？（数据都在云端，重新登录就会回来）")) return;
    unsubs.forEach((u) => u()); unsubs = [];
    ready = false;
    Planner.replace(null);
    lock("正在退出…", false);
    await auth.signOut(a);
    // remove this device's offline copy so the next person sees nothing
    await fs.terminate(db).catch(() => {});
    await fs.clearIndexedDbPersistence(db).catch(() => {});
    location.reload();
  }

  document.getElementById("loginBtn").onclick = googleLogin;
  document.getElementById("emailBtn").onclick = emailLogin;
  function showLogin() {
    show("");
    Planner.replace(null);
    lock("", true);
  }

  // surface errors from a redirect sign-in (used when the popup is blocked)
  auth.getRedirectResult(a).catch((e) => {
    console.error(e);
    alert("Google 登录没有成功（" + e.code + "）。可以换用「邮箱登录」，或在 Chrome / Safari 里打开网站再试。");
  });

  auth.onAuthStateChanged(a, (u) => {
    unsubs.forEach((x) => x()); unsubs = [];
    user = u; ready = false; profile = null; Planner.setProfile(null);
    mirror = emptyMirror();
    if (!u) { showLogin(); return; }
    if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(u.email)) {
      alert("这个账号没有权限使用这个日程本。");
      auth.signOut(a);
      return;
    }
    unlock();
    applyName();
    status("saving");
    subscribe();
    loadProfile();
  });
}

main().catch((e) => {
  console.error(e);
  lock("加载失败，请检查网络后刷新页面。", false);
});
