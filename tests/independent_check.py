"""
Independent least-squares check for the JavaScript engine.

Solves the normal equations with exact rational arithmetic (no numpy needed)
for a small fixed design, including a locked-weight (offset) case, and writes
the expected coefficients, R-squared and standard errors to
tests/expected.json. The Node tests compare the engine against this file.

Run:  python3 tests/independent_check.py
"""
import json
import math
import os
from fractions import Fraction as F

# Fixed synthetic sample: area (m2), wall (Masonry/Mud/Zinc), fence (0/1), value
ROWS = [
    (80, "Masonry", 1, 1500000),
    (120, "Masonry", 0, 1900000),
    (60, "Mud", 0, 700000),
    (200, "Masonry", 1, 3300000),
    (95, "Zinc", 0, 900000),
    (150, "Mud", 1, 1600000),
    (45, "Zinc", 0, 500000),
    (300, "Masonry", 1, 4800000),
    (110, "Mud", 0, 1100000),
    (70, "Zinc", 1, 850000),
    (180, "Masonry", 0, 2600000),
    (130, "Zinc", 1, 1400000),
]

# Column order must match Engine.buildColumns with feature order [wall, fence]
# and base category Masonry (most frequent). Base column is dropped here.
def design(form):
    X, y = [], []
    for area, wall, fence, value in ROWS:
        a = F(area)
        if form == "loglog":
            a = F(math.log(area))
        X.append([F(1), a, F(1 if wall == "Mud" else 0), F(1 if wall == "Zinc" else 0), F(fence)])
        y.append(F(value) if form == "linear" else F(math.log(value)))
    return X, y


def solve(A, b):
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = next(r for r in range(c, n) if M[r][c] != 0)
        M[c], M[piv] = M[piv], M[c]
        for r in range(n):
            if r != c and M[r][c] != 0:
                f = M[r][c] / M[c][c]
                M[r] = [M[r][k] - f * M[c][k] for k in range(n + 1)]
    return [M[i][n] / M[i][i] for i in range(n)]


def invert(A):
    n = len(A)
    cols = []
    for j in range(n):
        e = [F(1 if i == j else 0) for i in range(n)]
        cols.append(solve(A, e))
    return [[cols[j][i] for j in range(n)] for i in range(n)]


def ols(X, y, free_idx, offset=None):
    n = len(X)
    offset = offset or [F(0)] * n
    ys = [y[i] - offset[i] for i in range(n)]
    Xf = [[row[j] for j in free_idx] for row in X]
    p = len(free_idx)
    XtX = [[sum(Xf[i][a] * Xf[i][b] for i in range(n)) for b in range(p)] for a in range(p)]
    Xty = [sum(Xf[i][a] * ys[i] for i in range(n)) for a in range(p)]
    beta = solve(XtX, Xty)
    fitted = [sum(Xf[i][a] * beta[a] for a in range(p)) + offset[i] for i in range(n)]
    resid = [y[i] - fitted[i] for i in range(n)]
    sse = sum(r * r for r in resid)
    ybar = sum(y) / n
    sst = sum((v - ybar) ** 2 for v in y)
    df = n - p
    sigma2 = sse / df
    inv = invert(XtX)
    se = [math.sqrt(float(sigma2 * inv[a][a])) for a in range(p)]
    return {
        "beta": [float(b) for b in beta],
        "se": se,
        "r2": float(1 - sse / sst),
        "adjR2": float(1 - (1 - (1 - sse / sst)) * F(n - 1) / F(df)),
        "df": df,
    }


out = {"rows": [list(r) for r in ROWS], "cases": {}}
for form in ("linear", "loglinear", "loglog"):
    X, y = design(form)
    out["cases"][form] = ols(X, y, [0, 1, 2, 3, 4])

# Locked case: loglinear with the fence weight locked at +15% (coef ln(1.15))
X, y = design("loglinear")
lock = F(math.log(1.15))
offset = [lock * row[4] for row in X]
out["cases"]["loglinear_lock_fence"] = ols(X, y, [0, 1, 2, 3], offset)
out["cases"]["loglinear_lock_fence"]["lockedCoef"] = float(lock)

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "expected.json"), "w") as fh:
    json.dump(out, fh, indent=2)
print("wrote", os.path.join(here, "expected.json"))
