"""PyParty: a multiplayer Python editor.

Run locally:   uvicorn server:app --reload
Then open:     http://localhost:8000
"""

import json
import os
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from ot import Doc, transform

STATIC = Path(__file__).parent / "static"
MAX_DOC = 200_000        # max characters in one room's code
MAX_HISTORY = 2_000      # ops kept for transforming late edits
MAX_USERS = 20           # per room
EMPTY_ROOM_TTL = 60 * 60 # keep an empty room's code for an hour
COLORS = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#cc5de8",
          "#ff922b", "#20c997", "#f06595", "#94d82d", "#748ffc"]

STARTER = '''# Welcome to PyParty!
# Everyone in this room edits this file together, live.
# Press Run (or Ctrl+Enter) to run it. Python runs right in your browser.

def greet(name):
    return f"Hello, {name}!"

for friend in ["Ada", "Guido", "you"]:
    print(greet(friend))
'''

LANGS = {"python", "javascript", "lua", "sql", "html"}

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def isolate(request, call_next):
    # Cross-origin isolation lets the code runner pause for input() while it runs.
    response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    return response


class Room:
    def __init__(self, code):
        self.code = code
        self.doc = Doc(STARTER)
        self.lang = "python"
        self.history = []        # list of op lists; history[i] made version offset+i+1
        self.offset = 0          # version before history[0]
        self.users = {}          # id -> {"ws", "name", "color"}
        self.empty_since = None

    @property
    def version(self):
        return self.offset + len(self.history)

    def user_list(self):
        return [{"id": uid, "name": u["name"], "color": u["color"]}
                for uid, u in self.users.items() if u["joined"]]

    async def send(self, ws, msg):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            pass

    async def broadcast(self, msg, skip=None):
        for uid, u in list(self.users.items()):
            if uid != skip and u["joined"]:
                await self.send(u["ws"], msg)

    def init_msg(self, uid):
        return {"type": "init", "id": uid, "color": self.users[uid]["color"],
                "doc": self.doc.text(), "version": self.version,
                "users": self.user_list(), "room": self.code, "lang": self.lang}


rooms: dict[str, Room] = {}


def cleanup():
    now = time.time()
    for code, room in list(rooms.items()):
        if room.empty_since and now - room.empty_since > EMPTY_ROOM_TTL:
            del rooms[code]


def well_formed(ops) -> bool:
    if not isinstance(ops, list) or not 0 < len(ops) <= 500:
        return False
    for o in ops:
        if not isinstance(o, dict) or type(o.get("p")) is not int:
            return False
        if o.get("t") == "i" and isinstance(o.get("s"), str):
            continue
        if o.get("t") == "d" and type(o.get("n")) is int and o["n"] > 0:
            continue
        return False
    return True


def clean_code(code: str) -> str:
    return "".join(c for c in code.lower() if c.isalnum() or c == "-")[:32]


@app.get("/")
async def home():
    return FileResponse(STATIC / "index.html")


@app.get("/new")
async def new_room():
    words = ["snake", "loop", "byte", "pixel", "turtle", "lambda", "tuple", "comet", "nova", "spark"]
    code = f"{secrets.choice(words)}-{secrets.randbelow(9000) + 1000}"
    return RedirectResponse(f"/r/{code}")


@app.get("/r/{code}")
async def room_page(code: str):
    return FileResponse(STATIC / "room.html")


@app.websocket("/ws/{code}")
async def ws_endpoint(ws: WebSocket, code: str):
    code = clean_code(code)
    await ws.accept()
    if not code:
        await ws.close()
        return
    cleanup()
    room = rooms.get(code) or rooms.setdefault(code, Room(code))
    if len(room.users) >= MAX_USERS:
        await room.send(ws, {"type": "error", "text": "This room is full."})
        await ws.close()
        return

    uid = secrets.token_hex(4)
    used = {u["color"] for u in room.users.values()}
    color = next((c for c in COLORS if c not in used), secrets.choice(COLORS))
    room.users[uid] = {"ws": ws, "name": "Guest", "color": color, "joined": False}
    room.empty_since = None

    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except (ValueError, TypeError):
                continue
            kind = msg.get("type")

            if kind == "join":
                name = str(msg.get("name") or "Guest").strip()[:24] or "Guest"
                room.users[uid].update(name=name, joined=True)
                await room.send(ws, room.init_msg(uid))
                await room.broadcast({"type": "users", "users": room.user_list()})
                await room.broadcast({"type": "system", "text": f"{name} joined"}, skip=uid)

            elif kind == "op":
                ops, base = msg.get("ops"), msg.get("version")
                if (not well_formed(ops) or not isinstance(base, int)
                        or base < room.offset or base > room.version):
                    await room.send(ws, room.init_msg(uid))  # resync
                    continue
                for past in room.history[base - room.offset:]:
                    ops, _ = transform(ops, past, True)
                grows = sum(len(o["s"]) for o in ops if o["t"] == "i")
                if not room.doc.valid(ops) or len(room.doc) + grows > MAX_DOC:
                    await room.send(ws, room.init_msg(uid))  # reject + resync
                    continue
                room.doc.apply(ops)
                room.history.append(ops)
                if len(room.history) > MAX_HISTORY:
                    drop = len(room.history) - MAX_HISTORY
                    room.history = room.history[drop:]
                    room.offset += drop
                await room.send(ws, {"type": "ack", "version": room.version})
                await room.broadcast({"type": "op", "version": room.version,
                                      "ops": ops, "from": uid}, skip=uid)

            elif kind == "lang":
                if msg.get("lang") in LANGS and msg["lang"] != room.lang:
                    room.lang = msg["lang"]
                    u = room.users[uid]
                    await room.broadcast({"type": "lang", "lang": room.lang,
                                          "name": u["name"]}, skip=uid)

            elif kind == "cursor":
                p = msg.get("p")
                if isinstance(p, int):
                    await room.broadcast({"type": "cursor", "id": uid, "p": p}, skip=uid)

            elif kind == "chat":
                text = str(msg.get("text") or "").strip()[:500]
                if text:
                    u = room.users[uid]
                    await room.broadcast({"type": "chat", "name": u["name"],
                                          "color": u["color"], "text": text})

            elif kind == "output":
                u = room.users[uid]
                await room.broadcast({
                    "type": "output", "id": uid, "name": u["name"], "color": u["color"],
                    "run": str(msg.get("run", ""))[:32],
                    "text": str(msg.get("text", ""))[:20_000],
                    "done": bool(msg.get("done")), "error": bool(msg.get("error")),
                    "stopped": bool(msg.get("stopped")), "html": bool(msg.get("html")),
                }, skip=uid)

    except WebSocketDisconnect:
        pass
    finally:
        user = room.users.pop(uid, None)
        if not room.users:
            room.empty_since = time.time()
        elif user:
            await room.broadcast({"type": "users", "users": room.user_list()})
            await room.broadcast({"type": "system", "text": f"{user['name']} left"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
