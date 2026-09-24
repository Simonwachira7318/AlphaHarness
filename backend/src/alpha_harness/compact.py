"""``python -m alpha_harness.compact``: shrink ``harness.db``. Run with the backend stopped.

Moves every large trial distribution written inline into ``distribution_blob`` (see
``labs.distributions``), drops blobs no trial refers to any more (their study was deleted),
then ``VACUUM``s so the file itself gets smaller. Safe to run again: a compacted row is
left as it is.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys

import httpx

from .config import get_settings
from .db.sqlite import Database
from .labs.distributions import INLINE_LIMIT, REF, digest

BATCH = 100


def _running(port: int) -> bool:
    try:
        httpx.get(f"http://127.0.0.1:{port}/api/health", timeout=2)
    except httpx.HTTPError:
        return False
    return True


def _compact_trials(conn: sqlite3.Connection) -> int:
    changed = 0
    last = 0
    while True:
        rows = conn.execute(
            "SELECT id, distributions FROM trial WHERE id > ? ORDER BY id LIMIT ?", (last, BATCH)
        ).fetchall()
        if not rows:
            return changed
        for trial_id, text in rows:
            last = trial_id
            raw = json.loads(text) if text else {}
            if not isinstance(raw, dict):
                continue
            out: dict[str, object] = {}
            for name, body in raw.items():
                if isinstance(body, str) and len(body) >= INLINE_LIMIT:
                    key = digest(body)
                    conn.execute(
                        "INSERT OR IGNORE INTO distribution_blob (digest, body) VALUES (?, ?)",
                        (key, body),
                    )
                    out[name] = REF + key
                else:
                    out[name] = body
            if out != raw:
                conn.execute(
                    "UPDATE trial SET distributions = ? WHERE id = ?", (json.dumps(out), trial_id)
                )
                changed += 1
        conn.commit()


def _drop_orphans(conn: sqlite3.Connection) -> int:
    used: set[str] = set()
    for (text,) in conn.execute(
        "SELECT distributions FROM trial WHERE distributions LIKE ?", (f"%{REF}%",)
    ):
        raw = json.loads(text)
        used.update(
            v.removeprefix(REF) for v in raw.values() if isinstance(v, str) and v.startswith(REF)
        )
    orphans = [
        key for (key,) in conn.execute("SELECT digest FROM distribution_blob") if key not in used
    ]
    conn.executemany("DELETE FROM distribution_blob WHERE digest = ?", [(k,) for k in orphans])
    conn.commit()
    return len(orphans)


def main() -> int:
    settings = get_settings()
    path = settings.sqlite_path
    if not path.exists():
        print(f"Nothing to compact: {path} does not exist.")  # noqa: T201
        return 0
    if _running(settings.port):
        print(  # noqa: T201
            f"The backend is answering on port {settings.port}. Stop it first: compacting "
            "rewrites the database, and VACUUM needs it to itself."
        )
        return 1

    # Creates distribution_blob on a database from before it existed.
    database = Database.for_path(path)

    async def _migrate() -> None:
        await database.create_all()
        await database.dispose()

    asyncio.run(_migrate())

    before = path.stat().st_size
    conn = sqlite3.connect(path)
    try:
        changed = _compact_trials(conn)
        orphans = _drop_orphans(conn)
        print(f"Compacted {changed} trials, dropped {orphans} unused blobs. Vacuuming...")  # noqa: T201
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()
    after = path.stat().st_size
    print(f"harness.db: {before / 1e6:,.0f} MB -> {after / 1e6:,.0f} MB")  # noqa: T201
    return 0


if __name__ == "__main__":
    sys.exit(main())
