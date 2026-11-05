"""Tiny operational-transform library for plain text.

An op is a dict:
    {"t": "i", "p": pos, "s": text}   insert text at pos
    {"t": "d", "p": pos, "n": count}  delete count chars starting at pos

Positions and lengths are in UTF-16 code units so they match JavaScript
string indices in the browser. static/ot.js is a line-for-line port.
"""


def u16len(s: str) -> int:
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def _ins(p, s):
    return {"t": "i", "p": p, "s": s}


def _del(p, n):
    return {"t": "d", "p": p, "n": n}


def xform(a, b, b_first):
    """Transform op a against op b (both made on the same document).

    Returns (a2, b2): lists of ops, where a2 applies after b and b2 applies
    after a. b_first decides who goes first when both insert at one spot.
    """
    if a["t"] == "i" and b["t"] == "i":
        la, lb = u16len(a["s"]), u16len(b["s"])
        if b["p"] < a["p"] or (b["p"] == a["p"] and b_first):
            return [_ins(a["p"] + lb, a["s"])], [b]
        return [a], [_ins(b["p"] + la, b["s"])]

    if a["t"] == "i" and b["t"] == "d":
        b2, a2 = xform(b, a, not b_first)
        return a2, b2

    if a["t"] == "d" and b["t"] == "i":
        p, n, q, lb = a["p"], a["n"], b["p"], u16len(b["s"])
        if q <= p:
            return [_del(p + lb, n)], [b]
        if q >= p + n:
            return [a], [_ins(q - n, b["s"])]
        # Insert lands inside the deleted range: keep the inserted text and
        # delete around it (higher range first so positions stay valid).
        return [_del(q + lb, p + n - q), _del(p, q - p)], [_ins(p, b["s"])]

    # delete vs delete
    def remap(x, q, m):
        if x <= q:
            return x
        if x >= q + m:
            return x - m
        return q

    p, n, q, m = a["p"], a["n"], b["p"], b["n"]
    a_from, a_to = remap(p, q, m), remap(p + n, q, m)
    b_from, b_to = remap(q, p, n), remap(q + m, p, n)
    a2 = [_del(a_from, a_to - a_from)] if a_to > a_from else []
    b2 = [_del(b_from, b_to - b_from)] if b_to > b_from else []
    return a2, b2


def transform(A, B, b_first):
    """Transform op list A against op list B. Returns (A2, B2)."""
    if not A or not B:
        return A, B
    if len(A) == 1 and len(B) == 1:
        return xform(A[0], B[0], b_first)
    if len(A) > 1:
        a0, b1 = transform(A[:1], B, b_first)
        rest, b2 = transform(A[1:], b1, b_first)
        return a0 + rest, b2
    a1, b0 = transform(A, B[:1], b_first)
    a2, rest = transform(a1, B[1:], b_first)
    return a2, b0 + rest


class Doc:
    """Text stored as UTF-16-LE bytes so indices match the browser."""

    def __init__(self, text=""):
        self.buf = bytearray(text.encode("utf-16-le", "surrogatepass"))

    def __len__(self):
        return len(self.buf) // 2

    def text(self):
        return self.buf.decode("utf-16-le", "surrogatepass")

    def valid(self, ops):
        size = len(self)
        for op in ops:
            if op.get("t") == "i":
                if not isinstance(op.get("s"), str) or not isinstance(op.get("p"), int):
                    return False
                if not 0 <= op["p"] <= size:
                    return False
                size += u16len(op["s"])
            elif op.get("t") == "d":
                if not isinstance(op.get("p"), int) or not isinstance(op.get("n"), int):
                    return False
                if op["n"] < 1 or op["p"] < 0 or op["p"] + op["n"] > size:
                    return False
                size -= op["n"]
            else:
                return False
        return True

    def apply(self, ops):
        for op in ops:
            i = op["p"] * 2
            if op["t"] == "i":
                self.buf[i:i] = op["s"].encode("utf-16-le", "surrogatepass")
            else:
                del self.buf[i : i + op["n"] * 2]
