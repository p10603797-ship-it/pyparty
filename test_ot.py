"""Fuzz test: several clients type at once over a laggy network; all docs must match.

Run: python test_ot.py
"""
import json
import random
import subprocess
from pathlib import Path

from ot import Doc, transform


def apply_text(text, ops):
    d = Doc(text)
    d.apply(ops)
    return d.text()


def random_ops(text, rng):
    ops, cur = [], text
    for _ in range(rng.randint(1, 3)):
        if cur and rng.random() < 0.4:
            p = rng.randrange(len(cur))
            n = rng.randint(1, min(4, len(cur) - p))
            op = {"t": "d", "p": p, "n": n}
        else:
            op = {"t": "i", "p": rng.randint(0, len(cur)), "s": rng.choice("abcxyz") * rng.randint(1, 3)}
        ops.append(op)
        cur = apply_text(cur, [op])
    return ops


class Server:
    def __init__(self, text):
        self.doc, self.history = text, []

    def receive(self, base, ops):
        for past in self.history[base:]:
            ops, _ = transform(ops, past, True)
        self.doc = apply_text(self.doc, ops)
        self.history.append(ops)
        return len(self.history), ops


class Client:
    def __init__(self, text):
        self.doc, self.version = text, 0
        self.outstanding, self.buffer, self.inbox = None, [], []

    def local_edit(self, rng, outbox):
        ops = random_ops(self.doc, rng)
        self.doc = apply_text(self.doc, ops)
        if self.outstanding is None:
            self.outstanding = ops
            outbox.append((self, self.version, ops))
        else:
            self.buffer += ops

    def handle(self, msg, outbox):
        kind, version, ops = msg
        if kind == "ack":
            self.version = version
            self.outstanding = None
            if self.buffer:
                self.outstanding, self.buffer = self.buffer, []
                outbox.append((self, self.version, self.outstanding))
        else:
            if self.outstanding:
                self.outstanding, ops = transform(self.outstanding, ops, True)
            if self.buffer:
                self.buffer, ops = transform(self.buffer, ops, True)
            self.doc = apply_text(self.doc, ops)
            self.version = version


def run_fuzz(seed):
    rng = random.Random(seed)
    start = "hello world\nprint(1)\n"
    server = Server(start)
    clients = [Client(start) for _ in range(rng.randint(2, 4))]
    to_server = []
    for _ in range(300):
        r = rng.random()
        if r < 0.35:
            rng.choice(clients).local_edit(rng, to_server)
        elif r < 0.6 and to_server:
            client, base, ops = to_server.pop(0)
            version, ops = server.receive(base, ops)
            for c in clients:
                c.inbox.append(("ack", version, None) if c is client else ("op", version, ops))
        else:
            c = rng.choice(clients)
            if c.inbox:
                c.handle(c.inbox.pop(0), to_server)
    # drain everything
    while to_server or any(c.inbox for c in clients):
        while to_server:
            client, base, ops = to_server.pop(0)
            version, ops = server.receive(base, ops)
            for c in clients:
                c.inbox.append(("ack", version, None) if c is client else ("op", version, ops))
        for c in clients:
            while c.inbox:
                c.handle(c.inbox.pop(0), to_server)
    for c in clients:
        assert c.doc == server.doc, (seed, c.doc, server.doc)


def check_js_matches_python(rng):
    cases = []
    for _ in range(2000):
        text = "".join(rng.choice("abc\n") for _ in range(rng.randint(0, 12)))
        A, B = random_ops(text, rng), random_ops(text, rng)
        first = rng.random() < 0.5
        cases.append({"A": A, "B": B, "first": first, "py": list(transform(A, B, first))})
    js = Path(__file__).parent / "static" / "ot.js"
    script = (f"const OT=require({json.dumps(str(js))});"
              "const cases=JSON.parse(require('fs').readFileSync(0,'utf8'));"
              "let bad=0;for(const c of cases){const r=OT.transform(c.A,c.B,c.first);"
              "if(JSON.stringify(r)!==JSON.stringify(c.py))bad++;}console.log(bad);")
    out = subprocess.run(["node", "-e", script], input=json.dumps(cases),
                         capture_output=True, text=True, check=True).stdout.strip()
    assert out == "0", f"{out} JS/Python mismatches"


if __name__ == "__main__":
    for seed in range(3000):
        run_fuzz(seed)
    print("convergence: 3000 random sessions OK")
    check_js_matches_python(random.Random(1))
    print("ot.js matches ot.py on 2000 random cases")
    d = Doc("a😀b")
    d.apply([{"t": "d", "p": 1, "n": 2}])
    assert d.text() == "ab"
    print("emoji / UTF-16 indexing OK")
