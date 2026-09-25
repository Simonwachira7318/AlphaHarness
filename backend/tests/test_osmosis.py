"""Osmosis planning against BRAIN's rules: 100,000 exactly, at least 10 Alphas, 3 scopes.

Pure planning and the weekly timing only; nothing is sent anywhere.
Run: ``uv run python tests/test_osmosis.py``.
"""

import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

os.environ["AH_DATA_DIR"] = str(Path(tempfile.mkdtemp(prefix="ah-test-")).resolve())

from alpha_harness import osmosis
from alpha_harness.brain.filters import PLATFORM_TZ


def _alpha(
    i: int, region: str, *, kind: str = "REGULAR", fitness: float = 1.0, points: int | None = None
) -> dict[str, Any]:
    return {
        "id": f"{region}{kind[0]}{i:03d}",
        "type": kind,
        "settings": {"region": region, "delay": 1},
        "is": {"sharpe": fitness * 1.5, "fitness": fitness, "turnover": 0.2},
        "osmosisPoints": points,
    }


def _book() -> list[dict[str, Any]]:
    # The account's own shape: USA with Supers and Regulars, GLB, EUR with exactly ten, IND short.
    book = [_alpha(i, "USA", fitness=0.5 + i / 10) for i in range(36)]
    book += [_alpha(i, "USA", kind="SUPER", fitness=3.0, points=100_000) for i in range(7)]
    book += [_alpha(i, "GLB", fitness=1 + (i % 7) / 3) for i in range(86)]
    book += [_alpha(i, "EUR", fitness=0.9) for i in range(10)]
    book += [_alpha(i, "IND", fitness=2.0) for i in range(3)]
    return book


def test_split_is_exact() -> None:
    for scores in ([1.0] * 10, [5, 1, 1, 1, 1, 1, 1, 1, 1, 0.01], [0.0] * 12, list(range(1, 38))):
        pts = osmosis.split([float(s) for s in scores])
        assert sum(pts) == osmosis.POINTS_PER_SCOPE, (scores, sum(pts))
        assert all(p >= 1 for p in pts), pts


def test_plan_meets_the_rules() -> None:
    plan = osmosis.plan(_book(), osmosis.Settings(per_scope=20))
    assert plan.eligible, plan.problems
    allocated = {s.scope: s for s in plan.scopes if s.allocated}
    assert set(allocated) == {"USA D1", "GLB D1", "EUR D1"}, set(allocated)
    for s in allocated.values():
        assert sum(s.points.values()) == osmosis.POINTS_PER_SCOPE
        assert len(s.points) >= osmosis.MIN_ALPHAS
    assert len(allocated["EUR D1"].points) == 10
    assert len(allocated["USA D1"].points) == 20
    # SuperAlphas are left out by default, so the 700,000 they hold now is cleared.
    supers = [a["id"] for a in _book() if a["type"] == "SUPER"]
    assert all(plan.target[a] is None for a in supers)
    assert all(plan.changes[a] is None for a in supers)
    # IND has too few Alphas and gets nothing.
    assert not any(k.startswith("IND") and v for k, v in plan.target.items())
    # The strongest go first: USA's top fitness is in, its weakest is out.
    assert plan.target["USAR035"] and plan.target["USAR000"] is None


def test_current_allocation_is_judged_like_brain() -> None:
    ok, problems = osmosis.current_eligible(_book())
    assert not ok and any("700,000" in p for p in problems), problems
    plan = osmosis.plan(_book(), osmosis.Settings())
    after = [{**a, "osmosisPoints": plan.target[a["id"]]} for a in _book()]
    assert osmosis.current_eligible(after) == (True, [])


def test_too_few_scopes_is_refused() -> None:
    book = [_alpha(i, "USA") for i in range(30)] + [_alpha(i, "GLB") for i in range(9)]
    plan = osmosis.plan(book, osmosis.Settings())
    assert not plan.eligible and "3" in plan.problems[0], plan.problems


def test_weekly_timing() -> None:
    o = osmosis.Osmosis(state=None)  # type: ignore[arg-type]
    s = osmosis.Settings(auto=True)
    at = lambda *a: datetime(*a, tzinfo=PLATFORM_TZ)  # noqa: E731
    assert not o.due(s, at(2026, 9, 25, 12))  # Friday
    assert o.due(s, at(2026, 9, 26, 9))  # Saturday
    assert o.due(s, at(2026, 9, 27, 22))  # Sunday before the lock
    assert not o.due(s, at(2026, 9, 27, 23, 30))  # at the lock
    s.last_applied = at(2026, 9, 26, 9).isoformat()
    assert not o.due(s, at(2026, 9, 27, 10)), "once a week"
    assert o.due(s, at(2026, 10, 3, 9)), "and again the next Saturday"
    assert not o.due(osmosis.Settings(auto=False), at(2026, 9, 26, 9))


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test()
            print("ok", name)
