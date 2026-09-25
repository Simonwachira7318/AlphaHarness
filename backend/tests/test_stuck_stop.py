"""A stopped task whose last simulations stopped moving is forced to finish; a moving one waits.

Nothing is sent anywhere; every check uses a throwaway data directory.
Run: ``uv run python tests/test_stuck_stop.py``.
"""

import asyncio
import os
import tempfile
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

_DATA = Path(tempfile.mkdtemp(prefix="ah-test-")).resolve()
os.environ["AH_DATA_DIR"] = str(_DATA)
os.environ["AH_PORT"] = "8797"

from alpha_harness.config import get_settings  # noqa: E402
from alpha_harness.db.models import (  # noqa: E402
    SimStatus,
    SimulationRecord,
    Study,
    StudyStatus,
    utcnow,
)
from alpha_harness.db.sqlite import Database  # noqa: E402
from alpha_harness.labs import scheduler  # noqa: E402


async def _case(*, stopping: bool, moved_ago: timedelta) -> bool:
    settings = get_settings()
    settings.ensure_data_dir()
    db = Database.for_path(settings.sqlite_path)
    await db.create_all()
    task = f"settings-sampler-{moved_ago.total_seconds():.0f}-{stopping}"
    async with db.session() as session:
        study = Study(
            name=task,
            template_source="x",
            sampler="settings-sampler",
            sampler_params={"region": "USA", "delay": 0, "stopping": stopping},
            task=task,
            status=StudyStatus.RUNNING,
        )
        session.add(study)
        await session.flush()
        session.add(
            SimulationRecord(
                request_hash=f"h-{task}",
                payload={},
                task=task,
                status=SimStatus.RUNNING,
                platform_id=f"p-{task}",
                region="GBR",
                delay=0,
                universe="TOP700",
                progress=0.1,
                submitted_at=utcnow() - timedelta(hours=3),
                last_polled_at=utcnow() - moved_ago,
            )
        )
        study_id = study.id

    forced: list[Any] = []

    async def fake_stop(_optimizer: Any, row: Study, *, force: bool = False) -> None:
        forced.append((row.id, force))

    real = scheduler.stop_task
    scheduler.stop_task = fake_stop  # type: ignore[assignment]
    try:
        result = await scheduler.force_if_stuck(SimpleNamespace(db=db), study_id)  # type: ignore[arg-type]
    finally:
        scheduler.stop_task = real  # type: ignore[assignment]
        await db.dispose()
    assert result == bool(forced), (result, forced)
    if forced:
        assert forced == [(study_id, True)], forced
    return result


def test_stuck_stopping_task_is_forced() -> None:
    assert asyncio.run(_case(stopping=True, moved_ago=timedelta(hours=2)))


def test_moving_stopping_task_waits() -> None:
    assert not asyncio.run(_case(stopping=True, moved_ago=timedelta(minutes=5)))


def test_running_task_is_never_forced() -> None:
    assert not asyncio.run(_case(stopping=False, moved_ago=timedelta(hours=2)))


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test()
            print("ok", name)
