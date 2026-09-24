"""Shared trial distributions, compaction, and forgetting the saved login.

Every check uses a throwaway data directory. Run: ``uv run python tests/test_storage.py``.
"""

import asyncio
import os
import secrets
import tempfile
from pathlib import Path

# Before any alpha_harness import reads settings: never touch the real data directory.
_DATA = Path(tempfile.mkdtemp(prefix="ah-test-")).resolve()
os.environ["AH_DATA_DIR"] = str(_DATA)
os.environ["AH_PORT"] = "8799"

from optuna.distributions import (  # noqa: E402
    CategoricalDistribution,
    distribution_to_json,
    json_to_distribution,
)
from sqlalchemy import func, select  # noqa: E402

from alpha_harness import compact  # noqa: E402
from alpha_harness.account import AuthService  # noqa: E402
from alpha_harness.brain.auth import SessionInfo  # noqa: E402
from alpha_harness.config import get_settings  # noqa: E402
from alpha_harness.db.models import (  # noqa: E402
    BrainSessionRow,
    Credential,
    DistributionBlob,
    Study,
    Trial,
)
from alpha_harness.db.sqlite import Database  # noqa: E402
from alpha_harness.labs import distributions as blobs  # noqa: E402
from alpha_harness.sealing import Sealer  # noqa: E402

FIELDS = [f"field_{i:05d}" for i in range(5000)]
BIG = distribution_to_json(CategoricalDistribution(FIELDS))
SMALL = distribution_to_json(CategoricalDistribution([5, 21, 63]))


async def _database() -> Database:
    settings = get_settings()
    assert settings.data_dir == _DATA, settings.data_dir
    settings.ensure_data_dir()
    db = Database.for_path(settings.sqlite_path)
    await db.create_all()
    return db


async def _write_trials() -> dict[int, dict[str, str]]:
    db = await _database()
    originals: dict[int, dict[str, str]] = {}
    async with db.session() as session:
        study = Study(name="t", template_source="x")
        session.add(study)
        await session.flush()
        # Written inline, the way trials were before blobs existed.
        for n in range(20):
            raw = {"field@TOP3000": BIG, "d": SMALL}
            session.add(Trial(study_id=study.id, number=n, distributions=raw))
            originals[n] = raw
        await session.commit()
    # Two batches through the new write path, sharing one blob.
    for batch in range(2):
        async with db.session() as session:
            raws = [{"field@TOP3000": BIG, "d": SMALL} for _ in range(3)]
            for index, stored in enumerate(await blobs.compact(session, raws)):
                number = 100 + batch * 10 + index
                session.add(Trial(study_id=1, number=number, distributions=stored))
                originals[number] = raws[index]
            await session.commit()
    await db.dispose()
    return originals


async def _read_back(originals: dict[int, dict[str, str]]) -> None:
    db = Database.for_path(get_settings().sqlite_path)
    async with db.session() as session:
        trials = (await session.scalars(select(Trial))).all()
        found = await blobs.bodies(session, [t.distributions for t in trials])
        count = await session.scalar(select(func.count()).select_from(DistributionBlob))
        for trial in trials:
            assert all(len(v) < blobs.INLINE_LIMIT for v in trial.distributions.values())
            restored = blobs.expand(trial.distributions, found)
            assert restored == originals[trial.number], trial.number
            for text in restored.values():
                json_to_distribution(text)
    await db.dispose()
    assert count == 1, count


def test_distributions_round_trip() -> None:
    originals = asyncio.run(_write_trials())
    assert compact.main() == 0
    assert compact.main() == 0  # a second run finds nothing to do
    asyncio.run(_read_back(originals))


class _Unreachable:
    async def logout(self) -> None:
        raise ConnectionError("BRAIN is down")


async def _forget() -> None:
    db = await _database()
    service = AuthService(
        db,
        Sealer(secrets.token_bytes(32)),
        endpoints=None,  # type: ignore[arg-type]  # forget() only signs out through the authenticator
        metadata=None,  # type: ignore[arg-type]
        authenticator=_Unreachable(),  # type: ignore[arg-type]
    )
    await service.store_credential("someone@example.com", "hunter2")
    async with db.session() as session:
        credential = (await session.scalars(select(Credential))).one()
        session.add(BrainSessionRow(credential_id=credential.id, cookies_sealed=b"x"))
    # BRAIN being unreachable must not keep the password on disk.
    await service.forget()
    async with db.session() as session:
        assert await session.scalar(select(func.count()).select_from(Credential)) == 0
        assert await session.scalar(select(func.count()).select_from(BrainSessionRow)) == 0
    assert not service.session.authenticated
    await db.dispose()


def test_forget_removes_the_login() -> None:
    asyncio.run(_forget())


class _CheckedBrain:
    """A sign-in BRAIN pauses for an identity check, then accepts."""

    def __init__(self) -> None:
        self.client = self
        self.verifies = 0

    async def login(self, _email: str, _password: str) -> SessionInfo:
        return SessionInfo(authenticated=False, inquiry="inq_1", verification_url="https://x")

    async def verify(self, _inquiry: str) -> SessionInfo:
        self.verifies += 1
        if self.verifies > 1:
            # A spent inquiry: BRAIN no longer calls it verified.
            return SessionInfo(authenticated=False, inquiry="inq_1", verification_url="https://x")
        return SessionInfo(authenticated=True, user_id="U1")

    def export_cookies(self) -> list[dict[str, str]]:
        return [{"name": "t", "value": "session"}]

    async def get_user(self, _user_id: str) -> dict[str, str]:
        return {}


async def _checked_sign_in() -> None:
    db = await _database()
    brain = _CheckedBrain()
    service = AuthService(
        db,
        Sealer(secrets.token_bytes(32)),
        endpoints=brain,  # type: ignore[arg-type]
        metadata=None,  # type: ignore[arg-type]  # operator warm-up fails and is logged
        authenticator=brain,  # type: ignore[arg-type]
    )
    paused = await service.login("checked@example.com", "pw")
    assert not paused.authenticated
    async with db.session() as session:
        # Not accepted yet, so nothing is stored.
        assert await session.scalar(select(func.count()).select_from(Credential)) == 0
    assert (await service.verify("inq_1")).authenticated
    # Accepted: the login and its cookies survive a restart.
    assert await service.get_credential() == ("checked@example.com", "pw")
    async with db.session() as session:
        assert await session.scalar(select(func.count()).select_from(BrainSessionRow)) == 1
    # A check that was queued behind the one that signed in must not sign out again.
    assert (await service.verify("inq_1")).authenticated
    assert service.session.authenticated
    assert brain.verifies == 1, "asked BRAIN about a spent inquiry"
    await service.forget()
    await db.dispose()


def test_login_after_identity_check_is_kept() -> None:
    asyncio.run(_checked_sign_in())


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test()
            print("ok", name)
