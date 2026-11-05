(() => {
  const $ = id => document.getElementById(id);
  const room = decodeURIComponent(location.pathname.split("/r/")[1] || "").toLowerCase();
  $("roomCode").textContent = room;
  $("modalRoom").textContent = room;
  document.title = `PyParty · ${room}`;

  // ---------- editor ----------
  const cm = CodeMirror.fromTextArea($("editor"), {
    mode: "python", theme: "dracula", lineNumbers: true, indentUnit: 4,
    matchBrackets: true, autoCloseBrackets: true, readOnly: "nocursor",
    extraKeys: {
      Tab: c => c.somethingSelected() ? c.indentSelection("add") : c.replaceSelection(" ".repeat(c.getOption("indentUnit")), "end"),
      "Shift-Tab": c => c.indentSelection("subtract"),
      "Ctrl-/": "toggleComment", "Cmd-/": "toggleComment",
      "Ctrl-Enter": () => run(), "Cmd-Enter": () => run(),
    },
  });

  // ---------- sync state (see ot.py for the algorithm) ----------
  let ws, myId, version = 0, shadow = "", outstanding = null, buffer = [];
  let users = [], retry = 0;
  const cursors = {}; // user id -> bookmark

  function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  // Turn whatever the editor changed into one delete + one insert (by diffing).
  function diffOps(before, after) {
    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    let endB = before.length, endA = after.length;
    while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) { endB--; endA--; }
    // Don't split an emoji (surrogate pair) between ops.
    const isHigh = c => c >= 0xd800 && c <= 0xdbff, isLow = c => c >= 0xdc00 && c <= 0xdfff;
    if (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;
    if (endB < before.length && isLow(before.charCodeAt(endB))) { endB++; endA++; }
    const ops = [];
    if (endB > start) ops.push({ t: "d", p: start, n: endB - start });
    if (endA > start) ops.push({ t: "i", p: start, s: after.slice(start, endA) });
    return ops;
  }

  cm.on("changes", () => {
    const now = cm.getValue();
    if (now === shadow) return; // remote edit we already accounted for
    const ops = diffOps(shadow, now);
    shadow = now;
    if (!ops.length) return;
    if (outstanding) buffer = buffer.concat(ops);
    else { outstanding = ops; send({ type: "op", version, ops }); }
  });

  function applyRemote(ops) {
    if (outstanding) [outstanding, ops] = OT.transform(outstanding, ops, true);
    if (buffer.length) [buffer, ops] = OT.transform(buffer, ops, true);
    shadow = OT.apply(shadow, ops);
    cm.operation(() => {
      for (const o of ops) {
        const from = cm.posFromIndex(o.p);
        if (o.t === "i") cm.replaceRange(o.s, from, null, "remote");
        else cm.replaceRange("", from, cm.posFromIndex(o.p + o.n), "remote");
      }
    });
    if (cm.getValue() !== shadow) resetDoc(shadow); // should never happen
  }

  function resetDoc(text) {
    const cursor = cm.indexFromPos(cm.getCursor());
    shadow = text;
    cm.setValue(text);
    cm.setCursor(cm.posFromIndex(Math.min(cursor, text.length)));
  }

  // ---------- remote cursors ----------
  let cursorTimer;
  cm.on("cursorActivity", () => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => send({ type: "cursor", p: cm.indexFromPos(cm.getCursor()) }), 60);
  });

  function showCursor(id, p) {
    const u = users.find(x => x.id === id);
    if (!u) return;
    if (cursors[id]) cursors[id].clear();
    const el = document.createElement("span");
    el.className = "remote-cursor";
    el.style.borderColor = u.color;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.style.background = u.color;
    tag.textContent = u.name;
    el.appendChild(tag);
    cursors[id] = cm.setBookmark(cm.posFromIndex(Math.min(p, shadow.length)), { widget: el, insertLeft: true });
  }

  // ---------- people + chat ----------
  function renderUsers() {
    const box = $("users");
    box.innerHTML = "";
    for (const u of users) {
      const a = document.createElement("div");
      a.className = "avatar";
      a.style.background = u.color;
      a.textContent = u.name.slice(0, 2).toUpperCase();
      a.title = u.name + (u.id === myId ? " (you)" : "");
      box.appendChild(a);
    }
    for (const id of Object.keys(cursors)) {
      if (!users.some(u => u.id === id)) { cursors[id].clear(); delete cursors[id]; }
    }
  }

  function addMessage(text, name, color) {
    const div = document.createElement("div");
    div.className = "msg" + (name ? "" : " system");
    if (name) {
      const b = document.createElement("b");
      b.style.color = color;
      b.textContent = name;
      div.appendChild(b);
    }
    div.appendChild(document.createTextNode(text));
    const box = $("messages");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.appendChild(div);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  $("chatForm").addEventListener("submit", e => {
    e.preventDefault();
    const text = $("chatInput").value.trim();
    if (text) send({ type: "chat", text });
    $("chatInput").value = "";
  });

  // ---------- connection ----------
  function connect(name) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(room)}`);
    ws.onopen = () => { retry = 0; send({ type: "join", name }); };
    ws.onclose = () => {
      $("dot").classList.remove("on");
      cm.setOption("readOnly", "nocursor");
      setTimeout(() => connect(name), Math.min(1000 * 2 ** retry++, 10000));
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      switch (m.type) {
        case "init":
          myId = m.id; version = m.version; outstanding = null; buffer = []; users = m.users;
          resetDoc(m.doc);
          setLang(m.lang || "python", false);
          cm.setOption("readOnly", false);
          cm.focus();
          $("dot").classList.add("on");
          renderUsers();
          break;
        case "ack":
          version = m.version;
          outstanding = null;
          if (buffer.length) { outstanding = buffer; buffer = []; send({ type: "op", version, ops: outstanding }); }
          break;
        case "op":
          version = m.version;
          applyRemote(m.ops);
          break;
        case "users": users = m.users; renderUsers(); break;
        case "lang": setLang(m.lang, false); addMessage(`${m.name} switched the room to ${LANGS[m.lang].name}`); break;
        case "cursor": showCursor(m.id, m.p); break;
        case "chat": addMessage(m.text, m.name, m.color); break;
        case "system": addMessage(m.text); break;
        case "output": showRemoteOutput(m); break;
        case "error": addMessage(m.text); break;
      }
    };
  }

  // ---------- languages ----------
  const LANGS = {
    python: { name: "Python", mode: "python", ext: "py", indent: 4, starter:
`# Welcome to PyParty!
# Everyone in this room edits this file together, live.
# Press Run (or Ctrl+Enter) to run it. Python runs right in your browser.

def greet(name):
    return f"Hello, {name}!"

for friend in ["Ada", "Guido", "you"]:
    print(greet(friend))
` },
    javascript: { name: "JavaScript", mode: "javascript", ext: "js", indent: 2, starter:
`// Everyone in this room edits this file together, live.
// Press Run (or Ctrl+Enter). input("question") asks you to type something.

function greet(name) {
  return \`Hello, \${name}!\`;
}

const you = input("What's your name? ");
for (const friend of ["Ada", "Brendan", you]) {
  console.log(greet(friend));
}
` },
    lua: { name: "Lua", mode: "lua", ext: "lua", indent: 2, starter:
`-- Everyone in this room edits this file together, live.
-- Press Run (or Ctrl+Enter). io.read() asks you to type something.

local function greet(name)
  return "Hello, " .. name .. "!"
end

io.write("What's your name? ")
local you = io.read()
for _, friend in ipairs({"Ada", "Roberto", you}) do
  print(greet(friend))
end
` },
    sql: { name: "SQL", mode: "text/x-sqlite", ext: "sql", indent: 2, starter:
`-- Everyone in this room edits this file together, live.
-- Press Run (or Ctrl+Enter) to run the queries (SQLite).

CREATE TABLE players (name TEXT, score INTEGER);
INSERT INTO players VALUES ('Ada', 91), ('Linus', 78), ('you', 100);

SELECT name, score FROM players ORDER BY score DESC;
` },
    html: { name: "HTML / CSS / JS", mode: "htmlmixed", ext: "html", indent: 2, starter:
`<!-- Everyone in this room edits this page together, live.
     Press Run (or Ctrl+Enter) to see it on the right. -->
<style>
  body { font-family: sans-serif; text-align: center; padding: 40px; }
  button { font-size: 20px; padding: 10px 20px; }
</style>

<h1>Hello from our page!</h1>
<button onclick="count.textContent = Number(count.textContent) + 1">Click me</button>
<p>Clicks: <span id="count">0</span></p>
` },
  };
  let lang = "python";

  function setLang(l, fromMe) {
    if (!LANGS[l]) return;
    const changed = l !== lang || !worker;
    lang = l;
    $("lang").value = l;
    cm.setOption("mode", LANGS[l].mode);
    cm.setOption("indentUnit", LANGS[l].indent);
    if (fromMe) {
      // Swap in the new language's example if nobody has written real code yet.
      const cur = cm.getValue().trim();
      if (!cur || Object.values(LANGS).some(x => x.starter.trim() === cur)) cm.setValue(LANGS[l].starter);
      send({ type: "lang", lang: l });
    }
    if (changed) {
      if (running) stop(true);
      startWorker();
    }
  }
  $("lang").onchange = e => setLang(e.target.value, true);

  // ---------- running code ----------
  const out = $("output"), preview = $("preview");
  let worker, running = false, runId = null, shownRun = null, pending = "", flushTimer = null, outLen = 0;
  const MAX_OUT = 100_000;

  // Shared memory lets the worker pause on input() until you press Enter.
  const sab = self.crossOriginIsolated ? new SharedArrayBuffer(12 + 65536) : null;
  const ctl = sab && new Int32Array(sab, 0, 3), sdata = sab && new Uint8Array(sab, 12);
  $("stdinBox").hidden = !!sab; // only needed as a fallback

  function setRunButton(state) {
    const b = $("run");
    b.disabled = state === "loading";
    b.className = "btn " + (state === "running" ? "stop" : "run");
    b.textContent = state === "loading" ? `Loading ${LANGS[lang].name}…` : state === "running" ? "■ Stop" : "▶ Run";
  }

  function startWorker() {
    if (worker) worker.terminate();
    if (lang === "html") { worker = { terminate() {}, postMessage() {} }; setRunButton("idle"); return; }
    worker = new Worker("/static/worker.js");
    setRunButton("loading");
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === "ready") setRunButton("idle");
      else if (m.type === "out" || m.type === "err") { write(m.text, m.type === "err"); share(m.text, m.type === "err"); }
      else if (m.type === "input") askInput();
      else if (m.type === "done") finish(m.error);
    };
    worker.postMessage({ type: "init", lang, sab });
  }

  function showPane(html) {
    out.hidden = html;
    preview.hidden = !html;
  }

  function write(text, isErr) {
    if (outLen > MAX_OUT) return;
    outLen += text.length;
    if (outLen > MAX_OUT) text = "\n… output truncated …\n";
    const span = document.createElement("span");
    if (isErr) span.className = "err";
    span.textContent = text;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
  }

  function note(text) {
    const span = document.createElement("span");
    span.className = "note";
    span.textContent = text;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
  }

  function askInput() {
    const inp = document.createElement("input");
    inp.className = "term-input";
    inp.setAttribute("aria-label", "Type your answer and press Enter");
    inp.placeholder = "type here, press Enter";
    out.appendChild(inp);
    out.scrollTop = out.scrollHeight;
    inp.focus();
    inp.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const echo = document.createElement("span");
      echo.className = "echo";
      echo.textContent = inp.value + "\n";
      inp.replaceWith(echo);
      share(inp.value + "\n", false);
      const bytes = new TextEncoder().encode(inp.value).slice(0, 65536);
      sdata.set(bytes);
      Atomics.store(ctl, 1, bytes.length);
      Atomics.store(ctl, 2, 0);
      Atomics.store(ctl, 0, 1);
      Atomics.notify(ctl, 0);
    });
  }
  out.addEventListener("click", () => { const i = out.querySelector(".term-input"); if (i) i.focus(); });

  function resetOutput(who, color) {
    out.textContent = "";
    outLen = 0;
    $("outWho").textContent = who;
    $("outWho").style.color = color || "";
  }

  // Stream our output to the room in small batches.
  let shareErr = false;
  function share(text, isErr) {
    if (isErr !== shareErr && pending) flush();
    shareErr = isErr;
    pending += text;
    if (!flushTimer) flushTimer = setTimeout(flush, 200);
  }
  function flush(done, error, stopped) {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (pending || done) send({ type: "output", run: runId, text: pending, error: shareErr || !!error, done: !!done, stopped: !!stopped });
    pending = "";
  }

  function run() {
    if (running) return stop();
    if ($("run").disabled) return;
    runId = Math.random().toString(36).slice(2);
    shownRun = runId;
    if (lang === "html") {
      showPane(true);
      preview.srcdoc = cm.getValue();
      $("outWho").textContent = "— your page";
      $("outWho").style.color = "";
      send({ type: "output", run: runId, html: true, done: true });
      return;
    }
    running = true;
    shareErr = false;
    showPane(false);
    resetOutput("— your run");
    send({ type: "output", run: runId, text: "", done: false });
    setRunButton("running");
    worker.postMessage({ type: "run", code: cm.getValue(), stdin: $("stdin").value });
  }

  const endNote = (error, stopped) => stopped ? "\n[stopped]" : error ? "\n[finished with an error]" : "\n[finished]";
  function finish(error, stopped) {
    running = false;
    flush(true, error, stopped);
    const waiting = out.querySelector(".term-input");
    if (waiting) waiting.remove();
    note(endNote(error, stopped));
    setRunButton("idle");
  }

  function stop(noRestart) {
    worker.terminate();
    finish(false, true);
    if (noRestart !== true) startWorker();
  }

  function showRemoteOutput(m) {
    if (running) return; // don't clobber our own run
    if (m.html) {
      shownRun = m.run;
      showPane(true);
      preview.srcdoc = cm.getValue();
      $("outWho").textContent = `— ${m.name}'s page`;
      $("outWho").style.color = m.color;
      return;
    }
    showPane(false);
    if (m.run !== shownRun) { shownRun = m.run; resetOutput(`— ${m.name}'s run`, m.color); }
    if (m.text) write(m.text, m.error);
    if (m.done) note(endNote(m.error, m.stopped));
  }

  $("run").onclick = run;
  $("clear").onclick = () => { resetOutput(""); preview.srcdoc = ""; };

  // ---------- misc buttons ----------
  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 1600);
  }
  $("share").onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Invite link copied"); }
    catch { prompt("Copy this link:", location.href); }
  };
  $("download").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([cm.getValue()], { type: "text/plain" }));
    a.download = `${room}.${LANGS[lang].ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---------- start ----------
  setLang("python", false);
  let name = "";
  try { name = localStorage.getItem("pyparty-name") || ""; } catch {}
  if (name) connect(name);
  else {
    $("nameModal").hidden = false;
    $("nameInput").focus();
    $("nameForm").addEventListener("submit", e => {
      e.preventDefault();
      name = $("nameInput").value.trim();
      if (!name) return;
      try { localStorage.setItem("pyparty-name", name); } catch {}
      $("nameModal").hidden = true;
      connect(name);
    });
  }
})();
