# PyParty

Multiplayer Python coding. Make a room, share the link, and everyone edits the
same file live (with each other's cursors and a chat). Hit **Run** (or Ctrl+Enter)
and the code runs in your browser; everyone in the room sees the output.

- Server: Python (FastAPI + WebSockets) keeps the shared file in sync.
- Running code: [Pyodide](https://pyodide.org) (real Python 3.12 in the browser).
  Code never runs on the server, so hosting it publicly is safe and cheap.
  `import numpy`, `pandas`, etc. load automatically.
- `input()` reads from the "Program input" box, one line per call.

## Run it on your computer

```bash
pip install -r requirements.txt
uvicorn server:app --port 8000
```

Open http://localhost:8000. Friends on the same Wi-Fi can join at
`http://<your-computer's-IP>:8000` if you start it with `--host 0.0.0.0`.

## Put it online (free, Render.com)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/p10603797-ship-it/pyparty)

1. Click the button above and sign in to Render (you can sign in with GitHub).
2. Click **Deploy**. It reads `render.yaml` and takes a few minutes.
3. Open your `https://pyparty-xxxx.onrender.com` link, create a room, and send the
   invite link (or just the room code) to a friend.

Railway, Fly.io or any host that runs `uvicorn server:app --host 0.0.0.0 --port $PORT`
also works (see `Procfile`).

Notes:
- Run **one** server instance. Rooms live in memory, so a restart clears them
  (download your code with the Download button if you want to keep it).
- Render's free tier sleeps after ~15 idle minutes; the first visit afterwards takes ~30s.

## Tests

```bash
python test_ot.py
```

Simulates thousands of laggy multi-user editing sessions and checks every copy
ends up identical (also checks `static/ot.js` matches `ot.py`; needs Node).
