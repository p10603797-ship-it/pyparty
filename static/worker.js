// Runs Python (Pyodide) off the main thread so infinite loops can be stopped.
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

const ready = loadPyodide().then(py => { postMessage({ type: "ready" }); return py; });

onmessage = async (e) => {
  const { code, stdin } = e.data;
  const py = await ready;
  const lines = (stdin || "").split("\n");
  let i = 0;
  py.setStdin({ stdin: () => (i < lines.length && !(i === lines.length - 1 && lines[i] === "") ? lines[i++] : undefined) });
  py.setStdout({ batched: s => postMessage({ type: "out", text: s + "\n" }) });
  py.setStderr({ batched: s => postMessage({ type: "err", text: s + "\n" }) });
  const globals = py.globals.get("dict")();
  globals.set("__name__", "__main__");
  try {
    await py.loadPackagesFromImports(code, { messageCallback: () => {} });
    await py.runPythonAsync(code, { globals, filename: "main.py" });
    postMessage({ type: "done" });
  } catch (err) {
    // Trim Pyodide's internal frames so the traceback starts at the user's code.
    let msg = String(err.message || err);
    const at = msg.indexOf('  File "main.py"');
    if (at > 0) msg = "Traceback (most recent call last):\n" + msg.slice(at);
    postMessage({ type: "err", text: msg.endsWith("\n") ? msg : msg + "\n" });
    postMessage({ type: "done", error: true });
  } finally {
    globals.destroy();
  }
};
