// Runs code off the main thread so infinite loops can be stopped.
// One worker = one language. Messages in:  {type:"init", lang, sab} / {type:"run", code, stdin}
// Messages out: ready | out | err | input (waiting for a line) | done
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const WASMOON = "https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/dist/";
const SQLJS = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";

let lang, runtime, ctl, data, fallbackLines = [];
const out = text => postMessage({ type: "out", text });
const err = text => postMessage({ type: "err", text });

// Blocks until the page sends a line of input. Returns null on end-of-input.
function readLine() {
  if (!ctl) return fallbackLines.length ? fallbackLines.shift() : null;
  postMessage({ type: "input" });
  Atomics.wait(ctl, 0, 0);
  const eof = ctl[2] === 1;
  const text = new TextDecoder().decode(data.slice(0, ctl[1]));
  Atomics.store(ctl, 0, 0);
  return eof ? null : text;
}

const loaders = {
  async python() {
    importScripts(PYODIDE + "pyodide.js");
    return loadPyodide({ indexURL: PYODIDE });
  },
  async javascript() { return true; },
  async lua() {
    importScripts(WASMOON + "index.js");
    return new wasmoon.LuaFactory(WASMOON + "glue.wasm");
  },
  async sql() {
    importScripts(SQLJS + "sql-wasm.js");
    return initSqlJs({ locateFile: f => SQLJS + f });
  },
};

const runners = {
  async python(py, code) {
    const decoder = new TextDecoder();
    const writer = send => ({ isatty: true, write: buf => { send(decoder.decode(buf, { stream: true })); return buf.length; } });
    py.setStdout(writer(out));
    py.setStderr(writer(err));
    py.setStdin({ stdin: () => { const s = readLine(); return s === null ? undefined : s + "\n"; } });
    const globals = py.globals.get("dict")();
    globals.set("__name__", "__main__");
    try {
      await py.loadPackagesFromImports(code, { messageCallback: () => {} });
      await py.runPythonAsync(code, { globals, filename: "main.py" });
    } catch (e) {
      // Trim Pyodide's internal frames so the traceback starts at the user's code.
      let msg = String(e.message || e);
      const at = msg.indexOf('  File "main.py"');
      if (at > 0) msg = "Traceback (most recent call last):\n" + msg.slice(at);
      throw new Error(msg);
    } finally {
      globals.destroy();
    }
  },

  async javascript(_, code) {
    const fmt = v => typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } })();
    const line = send => (...a) => send(a.map(fmt).join(" ") + "\n");
    self.console = { log: line(out), info: line(out), debug: line(out), warn: line(err), error: line(err) };
    self.input = self.prompt = (q = "") => { if (q) out(String(q)); return readLine(); };
    const AsyncFunction = (async () => {}).constructor;
    try {
      await new AsyncFunction(code)();
    } catch (e) {
      throw new Error(e && e.name ? `${e.name}: ${e.message}` : String(e));
    }
  },

  async lua(factory, code) {
    const lua = await factory.createEngine();
    lua.global.set("__out", s => out(s));
    lua.global.set("__in", () => readLine());
    await lua.doString(`
      print = function(...)
        local t = table.pack(...)
        for i = 1, t.n do t[i] = tostring(t[i]) end
        __out(table.concat(t, "\\t") .. "\\n")
      end
      io.write = function(...)
        local t = table.pack(...)
        for i = 1, t.n do t[i] = tostring(t[i]) end
        __out(table.concat(t))
      end
      io.read = function(fmt)
        local s = __in()
        if s == nil then return nil end
        if fmt == "n" or fmt == "*n" then return tonumber(s) end
        return s
      end`);
    try {
      await lua.doString(code);
    } catch (e) {
      throw new Error(String(e.message || e).replace(/\[string ".*?"\]:(\d+):/g, "line $1:"));
    } finally {
      lua.global.close();
    }
  },

  async sql(SQL, code) {
    const db = new SQL.Database();
    try {
      const results = db.exec(code);
      if (!results.length) out("Done. (No rows returned.)\n");
      for (const { columns, values } of results) out(table(columns, values) + "\n");
    } finally {
      db.close();
    }
  },
};

function table(columns, rows) {
  const cell = v => v === null ? "NULL" : String(v);
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map(r => cell(r[i]).length)));
  const line = cells => "| " + cells.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |";
  const sep = "+-" + widths.map(w => "-".repeat(w)).join("-+-") + "-+";
  return [sep, line(columns), sep, ...rows.map(r => line(r.map(cell))), sep,
          `(${rows.length} row${rows.length === 1 ? "" : "s"})`].join("\n");
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    lang = m.lang;
    if (m.sab) { ctl = new Int32Array(m.sab, 0, 3); data = new Uint8Array(m.sab, 12); }
    try {
      runtime = await loaders[lang]();
      postMessage({ type: "ready" });
    } catch (x) {
      err(`Could not load ${lang}: ${x.message || x}\n`);
    }
    return;
  }
  fallbackLines = (m.stdin || "").split("\n");
  if (fallbackLines[fallbackLines.length - 1] === "") fallbackLines.pop();
  try {
    await runners[lang](runtime, m.code);
    postMessage({ type: "done" });
  } catch (x) {
    const msg = String(x.message || x);
    err(msg.endsWith("\n") ? msg : msg + "\n");
    postMessage({ type: "done", error: true });
  }
};
