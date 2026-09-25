"""The Submit Queue's rules, against a fake BRAIN: caps, approvals, refusals, pausing.

Nothing is sent anywhere; every check uses a throwaway data directory.
Run: ``uv run python tests/test_submit_queue.py``.
"""

import asyncio
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

_DATA = Path(tempfile.mkdtemp(prefix="ah-test-")).resolve()
os.environ["AH_DATA_DIR"] = str(_DATA)
os.environ["AH_PORT"] = "8798"

from alpha_harness import submitting  # noqa: E402
from alpha_harness.brain.submit import SubmitOutcome  # noqa: E402
from alpha_harness.config import get_settings  # noqa: E402
from alpha_harness.db.models import QueueStatus, SubmitQueueEntry  # noqa: E402
from alpha_harness.db.sqlite import Database  # noqa: E402

PASS = [{"name": "LOW_SHARPE", "result": "PASS"}, {"name": "SELF_CORRELATION", "result": "PASS"}]


class FakeBrain:
    """Alphas by id: their type, status and checks. Records every submission."""

    def __init__(self) -> None:
        self.alphas: dict[str, dict[str, Any]] = {}
        self.sent: list[str] = []
        self.described: list[str] = []

    def add(self, alpha_id: str, kind: str = "REGULAR", checks: list[Any] | None = None) -> None:
        self.alphas[alpha_id] = {
            "id": alpha_id,
            "type": kind,
            "status": "UNSUBMITTED",
            "checks": PASS if checks is None else checks,
            "selection": {"code": "oWn * (turnover > 0.5)"},
            "combo": {"code": "combo_a(alpha)"},
            "settings": {"selectionLimit": 10},
        }

    async def alpha_body(self, alpha_id: str) -> dict[str, Any]:
        return dict(self.alphas[alpha_id])

    async def check_alpha(self, alpha_id: str) -> dict[str, Any]:
        return {"is": {"checks": self.alphas[alpha_id]["checks"]}}

    async def update_alpha(self, alpha_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        if "selection" in properties:
            self.described.append(alpha_id)
        return {}

    async def submit(self, _client: Any, alpha_id: str) -> SubmitOutcome:
        self.sent.append(alpha_id)
        self.alphas[alpha_id]["status"] = "ACTIVE"
        return SubmitOutcome(True, 200, "Submitted.")


async def _queue() -> tuple[submitting.SubmitQueue, FakeBrain, Database]:
    settings = get_settings()
    assert settings.data_dir == _DATA
    settings.ensure_data_dir()
    db = Database.for_path(settings.sqlite_path)
    await db.create_all()
    async with db.session() as session:
        for row in (await session.execute(SubmitQueueEntry.__table__.select())).all():
            await session.execute(
                SubmitQueueEntry.__table__.delete().where(SubmitQueueEntry.alpha_id == row[0])
            )
    brain = FakeBrain()
    submitting.submit_alpha = brain.submit  # type: ignore[assignment]

    async def save_checks(_alpha_id: str, _checks: list[Any]) -> None:
        return None

    state = SimpleNamespace(
        settings=settings,
        db=db,
        endpoints=brain,
        client=None,
        auth=SimpleNamespace(session=SimpleNamespace(authenticated=True)),
        alphas=SimpleNamespace(save_checks=save_checks),
    )
    queue = submitting.SubmitQueue(state)  # type: ignore[arg-type]
    await queue.set_paused(False)
    return queue, brain, db


async def _status(db: Database, alpha_id: str) -> str:
    async with db.session() as session:
        row = await session.get(SubmitQueueEntry, alpha_id)
        return row.status if row else "missing"


async def _caps() -> None:
    queue, brain, db = await _queue()
    regular = [f"R{i}" for i in range(5)]
    supers = ["S0", "S1"]
    for a in regular:
        brain.add(a)
    for a in supers:
        brain.add(a, "SUPER")
    await queue.add([*regular, *supers])
    for _ in range(10):
        await queue.tick()
    assert brain.sent == ["R0", "S0", "R1", "R2"], brain.sent
    assert await queue.submitted_today() == {"REGULAR": 3, "SUPER": 1}
    assert await _status(db, "R3") == QueueStatus.QUEUED
    assert await _status(db, "S1") == QueueStatus.QUEUED
    assert brain.described == ["S0"], "a SuperAlpha is described before it is sent"

    # Past the cap only a per-Alpha approval submits, and it counts.
    out = await queue.submit_now("R4")
    assert out["submitted"], out
    assert brain.sent[-1] == "R4"
    assert (await queue.submitted_today())["REGULAR"] == 4
    for _ in range(3):
        await queue.tick()
    assert "R3" not in brain.sent, "the automatic path never passes the cap"
    await db.dispose()


async def _refusals() -> None:
    queue, brain, db = await _queue()
    brain.add("BAD", checks=[{"name": "LOW_SHARPE", "result": "FAIL"}])
    brain.add("WAIT", checks=[{"name": "SELF_CORRELATION", "result": "PENDING"}])
    brain.add("DONE")
    brain.alphas["DONE"]["status"] = "ACTIVE"
    brain.add("GOOD")
    added = await queue.add(["BAD", "WAIT", "DONE", "GOOD"])
    assert [a["added"] for a in added] == [True, True, False, True], added
    for _ in range(4):
        await queue.tick()
    assert brain.sent == ["GOOD"], brain.sent
    assert await _status(db, "BAD") == QueueStatus.REFUSED
    assert await _status(db, "WAIT") == QueueStatus.QUEUED
    assert await _status(db, "DONE") == "missing"
    await db.dispose()


async def _daily_limit_and_pause() -> None:
    queue, brain, db = await _queue()
    brain.add("A", checks=[{"name": "REGULAR_SUBMISSION", "result": "FAIL"}])
    brain.add("B")
    await queue.add(["A", "B"])
    await queue.tick()
    assert brain.sent == [], "BRAIN's own daily limit stops the day, not the Alpha"
    assert queue.full_today("REGULAR")
    assert await _status(db, "A") == QueueStatus.QUEUED

    queue._full_on.clear()  # a new day
    brain.alphas["A"]["checks"] = PASS
    await queue.set_paused(True)
    await queue.tick()
    assert brain.sent == [], "a paused queue sends nothing"
    await queue.set_paused(False)
    await queue.tick()
    assert brain.sent == ["A"], brain.sent
    await db.dispose()


async def _caps_set_on_screen() -> None:
    queue, brain, db = await _queue()
    await queue.set_caps({"REGULAR": 1, "SUPER": 0})
    for a in ("X0", "X1"):
        brain.add(a)
    brain.add("Y0", "SUPER")
    await queue.add(["X0", "X1", "Y0"])
    for _ in range(4):
        await queue.tick()
    assert brain.sent == ["X0"], "a cap set on screen replaces the default; zero stops a kind"
    await queue.set_caps({"REGULAR": 3, "SUPER": 1})
    await db.dispose()


def test_caps_set_on_screen() -> None:
    asyncio.run(_caps_set_on_screen())


def test_caps_and_approval() -> None:
    asyncio.run(_caps())


def test_refusals_are_never_sent() -> None:
    asyncio.run(_refusals())


def test_daily_limit_and_pause() -> None:
    asyncio.run(_daily_limit_and_pause())


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test()
            print("ok", name)
