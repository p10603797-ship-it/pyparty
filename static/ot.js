// Port of ot.py. Ops: {t:"i", p, s} insert, {t:"d", p, n} delete.
(function (root) {
  const ins = (p, s) => ({ t: "i", p, s });
  const del = (p, n) => ({ t: "d", p, n });

  function xform(a, b, bFirst) {
    if (a.t === "i" && b.t === "i") {
      if (b.p < a.p || (b.p === a.p && bFirst)) return [[ins(a.p + b.s.length, a.s)], [b]];
      return [[a], [ins(b.p + a.s.length, b.s)]];
    }
    if (a.t === "i" && b.t === "d") {
      const [b2, a2] = xform(b, a, !bFirst);
      return [a2, b2];
    }
    if (a.t === "d" && b.t === "i") {
      const p = a.p, n = a.n, q = b.p, lb = b.s.length;
      if (q <= p) return [[del(p + lb, n)], [b]];
      if (q >= p + n) return [[a], [ins(q - n, b.s)]];
      return [[del(q + lb, p + n - q), del(p, q - p)], [ins(p, b.s)]];
    }
    const remap = (x, q, m) => (x <= q ? x : x >= q + m ? x - m : q);
    const aFrom = remap(a.p, b.p, b.n), aTo = remap(a.p + a.n, b.p, b.n);
    const bFrom = remap(b.p, a.p, a.n), bTo = remap(b.p + b.n, a.p, a.n);
    return [aTo > aFrom ? [del(aFrom, aTo - aFrom)] : [],
            bTo > bFrom ? [del(bFrom, bTo - bFrom)] : []];
  }

  function transform(A, B, bFirst) {
    if (!A.length || !B.length) return [A, B];
    if (A.length === 1 && B.length === 1) return xform(A[0], B[0], bFirst);
    if (A.length > 1) {
      const [a0, b1] = transform(A.slice(0, 1), B, bFirst);
      const [rest, b2] = transform(A.slice(1), b1, bFirst);
      return [a0.concat(rest), b2];
    }
    const [a1, b0] = transform(A, B.slice(0, 1), bFirst);
    const [a2, rest] = transform(a1, B.slice(1), bFirst);
    return [a2, b0.concat(rest)];
  }

  function apply(text, ops) {
    for (const o of ops) {
      text = o.t === "i" ? text.slice(0, o.p) + o.s + text.slice(o.p)
                         : text.slice(0, o.p) + text.slice(o.p + o.n);
    }
    return text;
  }

  root.OT = { transform, apply };
  if (typeof module !== "undefined") module.exports = root.OT;
})(typeof window !== "undefined" ? window : globalThis);
