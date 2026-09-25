"""The Submit Queue: Alphas the consultant approved, submitted on their behalf within daily caps.

The rules, which are the whole point of this module:

* On its own the queue submits at most ``auto_submit_regular_per_day`` regular Alphas and
  ``auto_submit_super_per_day`` SuperAlphas per BRAIN day (midnight US Eastern), in the order
  the consultant set. Every submission this application made that day counts, automatic or not.
* Past a cap nothing more goes automatically. An Alpha is then submitted only by
  :meth:`SubmitQueue.submit_now`, which the API reaches for one Alpha per confirmed request.
* Each Alpha is checked again right before it is sent. One that fails a check is set aside,
  never sent; one whose checks are still pending waits and is tried again later.
* A paused queue submits nothing on its own.

Submitting itself is :func:`~alpha_harness.brain.submit.submit_alpha`, the only call that does.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from datetime import datetime
from typing import TYPE_CHECKING, Any

import structlog
from sqlalchemy import func, select

from .brain.errors import BrainError
from .brain.filters import platform_midnight
from .brain.submit import submit_alpha
from .db.models import MetadataCache, QueueStatus, Submission, SubmitQueueEntry, utcnow
from .vault.yields import verdict

if TYPE_CHECKING:
    from .state import AppState

log = structlog.get_logger(__name__)

REGULAR, SUPER = "REGULAR", "SUPER"
KINDS = (REGULAR, SUPER)

#: How often the queue looks for something to send.
TICK_SECONDS = 60.0
#: How long an Alpha whose checks are still pending waits before it is tried again.
PENDING_RETRY_SECONDS = 30 * 60.0
#: BRAIN fails these when the day's submissions of that kind are used up.
DAILY_LIMIT_CHECKS = frozenset({"REGULAR_SUBMISSION", "SUPER_SUBMISSION"})

PAUSE_KEY = "submit_queue"
CAPS_KEY = "submit_queue_caps"
#: The most a cap can be set to on screen; BRAIN's own daily limits are far below it anyway.
MAX_CAP = 20


def _when(body: dict[str, Any]) -> datetime | None:
    """When BRAIN says the Alpha was submitted, so one found submitted counts on its own day."""
    raw = body.get("dateSubmitted")
    try:
        moment = datetime.fromisoformat(str(raw)) if raw else None
    except ValueError:
        return None
    return moment if moment is not None and moment.tzinfo is not None else None


class SubmitQueue:
    def __init__(self, state: AppState) -> None:
        self.state = state
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        #: One submission at a time, automatic or approved.
        self._lock = asyncio.Lock()
        #: Alpha id -> monotonic time before which it is not tried again (checks pending).
        self._not_before: dict[str, float] = {}
        #: Kind -> the platform day BRAIN said its submissions were used up.
        self._full_on: dict[str, str] = {}
        self.last_tick: datetime | None = None

    # -- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        if self._task is not None:
            return
        # A submission cut off by a restart may or may not have gone through; the next attempt
        # reads the Alpha's status first, so putting it back in line cannot submit it twice.
        async with self.state.db.session() as session:
            for row in (
                await session.scalars(
                    select(SubmitQueueEntry).where(
                        SubmitQueueEntry.status == QueueStatus.SUBMITTING
                    )
                )
            ).all():
                row.status = QueueStatus.QUEUED
        self._task = asyncio.create_task(self._run(), name="submit-queue")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def wake(self) -> None:
        self._wake.set()

    async def _run(self) -> None:
        while True:
            try:
                await self.tick()
            # The loop must outlive any one failure; it is logged and retried next tick.
            except Exception:
                log.exception("submit_queue.tick_failed")
            self._wake.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), TICK_SECONDS)

    # -- settings and counts ---------------------------------------------

    async def caps(self) -> dict[str, int]:
        """Today's automatic caps: as set on screen, else the ``.env`` defaults."""
        s = self.state.settings
        caps = {REGULAR: s.auto_submit_regular_per_day, SUPER: s.auto_submit_super_per_day}
        async with self.state.db.session() as session:
            row = await session.get(MetadataCache, CAPS_KEY)
        for kind in KINDS:
            value = (row.value if row else {}).get(kind)
            if isinstance(value, int) and 0 <= value <= MAX_CAP:
                caps[kind] = value
        return caps

    async def set_caps(self, caps: dict[str, int]) -> dict[str, int]:
        merged = {**await self.caps(), **{k: v for k, v in caps.items() if k in KINDS}}
        async with self.state.db.session() as session:
            row = await session.get(MetadataCache, CAPS_KEY)
            if row is None:
                session.add(MetadataCache(key=CAPS_KEY, value=merged))
            else:
                row.value, row.fetched_at = merged, utcnow()
        log.info("submit_queue.caps", **merged)
        self.wake()
        return merged

    async def paused(self) -> bool:
        async with self.state.db.session() as session:
            row = await session.get(MetadataCache, PAUSE_KEY)
            return bool(row and row.value.get("paused"))

    async def set_paused(self, paused: bool) -> None:
        async with self.state.db.session() as session:
            row = await session.get(MetadataCache, PAUSE_KEY)
            if row is None:
                session.add(MetadataCache(key=PAUSE_KEY, value={"paused": paused}))
            else:
                row.value, row.fetched_at = {"paused": paused}, utcnow()
        if not paused:
            self.wake()

    async def submitted_today(self) -> dict[str, int]:
        """Submissions this application made since midnight US Eastern, by kind."""
        async with self.state.db.session() as session:
            rows = (
                await session.execute(
                    select(SubmitQueueEntry.kind, func.count())
                    .where(
                        SubmitQueueEntry.status == QueueStatus.SUBMITTED,
                        SubmitQueueEntry.submitted_at >= platform_midnight(),
                    )
                    .group_by(SubmitQueueEntry.kind)
                )
            ).all()
        counts: dict[str, int] = dict.fromkeys(KINDS, 0)
        counts.update({str(kind): int(n) for kind, n in rows})
        return counts

    def _today(self) -> str:
        return platform_midnight().date().isoformat()

    def full_today(self, kind: str) -> bool:
        """BRAIN said this kind's submissions are used up for today."""
        return self._full_on.get(kind) == self._today()

    # -- the automatic path ------------------------------------------------

    async def tick(self) -> None:
        self.last_tick = utcnow()
        if await self.paused() or not self.state.auth.session.authenticated:
            return
        counts = await self.submitted_today()
        for kind, cap in (await self.caps()).items():
            if counts.get(kind, 0) >= cap or self.full_today(kind):
                continue
            entry = await self._next(kind)
            if entry is not None:
                async with self._lock:
                    await self._process(entry, mode="auto")

    async def _next(self, kind: str) -> str | None:
        now = time.monotonic()
        async with self.state.db.session() as session:
            ids = (
                await session.scalars(
                    select(SubmitQueueEntry.alpha_id)
                    .where(
                        SubmitQueueEntry.kind == kind,
                        SubmitQueueEntry.status == QueueStatus.QUEUED,
                    )
                    .order_by(SubmitQueueEntry.position, SubmitQueueEntry.added_at)
                )
            ).all()
        return next((a for a in ids if self._not_before.get(a, 0.0) <= now), None)

    # -- the approved path -------------------------------------------------

    async def submit_now(self, alpha_id: str) -> dict[str, Any]:
        """Submit one Alpha the consultant approved just now, whatever today's counts are."""
        added = (await self.add([alpha_id], front=True))[0]
        if not added["added"]:
            return {"alphaId": alpha_id, "submitted": False, "message": added["message"]}
        async with self._lock:
            return await self._process(alpha_id, mode="approved")

    # -- queueing --------------------------------------------------------

    async def kind_of(self, alpha_id: str) -> tuple[str, str | None]:
        """``(kind, status)`` from BRAIN's own copy of the Alpha."""
        body = await self.state.endpoints.alpha_body(alpha_id)
        kind = SUPER if str(body.get("type")) == SUPER else REGULAR
        return kind, body.get("status")

    async def add(self, alpha_ids: list[str], *, front: bool = False) -> list[dict[str, Any]]:
        """Queue Alphas at the back (or the front), refusing ones already submitted.

        One already queued keeps its place unless ``front``; one set aside is queued again.
        """
        out: list[dict[str, Any]] = []
        for alpha_id in dict.fromkeys(a.strip() for a in alpha_ids if a.strip()):
            try:
                kind, status = await self.kind_of(alpha_id)
            except BrainError as exc:
                out.append({"alphaId": alpha_id, "added": False, "message": exc.message})
                continue
            async with self.state.db.session() as session:
                row = await session.get(SubmitQueueEntry, alpha_id)
                if (row and row.status == QueueStatus.SUBMITTED) or (
                    status and status != "UNSUBMITTED"
                ):
                    out.append(
                        {"alphaId": alpha_id, "added": False, "message": "Already submitted."}
                    )
                    continue
                edge = await session.scalar(
                    select(
                        func.min(SubmitQueueEntry.position)
                        if front
                        else func.max(SubmitQueueEntry.position)
                    )
                )
                position = (edge or 0) - 1 if front else (edge or 0) + 1
                if row is None:
                    session.add(SubmitQueueEntry(alpha_id=alpha_id, kind=kind, position=position))
                else:
                    row.kind = kind
                    if front or row.status != QueueStatus.QUEUED:
                        row.position = position
                    row.status, row.message = QueueStatus.QUEUED, None
            self._not_before.pop(alpha_id, None)
            out.append({"alphaId": alpha_id, "added": True, "message": f"Queued as {kind}."})
        self.wake()
        return out

    async def remove(self, alpha_id: str) -> bool:
        async with self.state.db.session() as session:
            row = await session.get(SubmitQueueEntry, alpha_id)
            if row is None or row.status in (QueueStatus.SUBMITTED, QueueStatus.SUBMITTING):
                return False
            await session.delete(row)
        return True

    async def reorder(self, alpha_ids: list[str]) -> None:
        """Put these Alphas first, in this order; the rest keep their order behind them."""
        async with self.state.db.session() as session:
            rows = (
                await session.scalars(
                    select(SubmitQueueEntry)
                    .where(SubmitQueueEntry.status != QueueStatus.SUBMITTED)
                    .order_by(SubmitQueueEntry.position, SubmitQueueEntry.added_at)
                )
            ).all()
            by_id = {r.alpha_id: r for r in rows}
            first = [by_id[a] for a in alpha_ids if a in by_id]
            rest = [r for r in rows if r.alpha_id not in set(alpha_ids)]
            for position, row in enumerate([*first, *rest]):
                row.position = position

    # -- one submission ----------------------------------------------------

    async def _set(self, alpha_id: str, **values: Any) -> None:
        async with self.state.db.session() as session:
            row = await session.get(SubmitQueueEntry, alpha_id)
            if row is not None:
                for key, value in values.items():
                    setattr(row, key, value)

    async def _process(self, alpha_id: str, *, mode: str) -> dict[str, Any]:
        """Check one Alpha, then submit it if every check passes. Caller holds the lock."""
        endpoints = self.state.endpoints
        await self._set(
            alpha_id, status=QueueStatus.SUBMITTING, attempted_at=utcnow(), message=None
        )
        try:
            body = await endpoints.alpha_body(alpha_id)
            # Submitted already, elsewhere or by a send a restart cut off: record it, never resend.
            if body.get("status") and body.get("status") != "UNSUBMITTED":
                return await self._submitted(
                    alpha_id, "found", "Already submitted on BRAIN.", _when(body)
                )

            checked = await endpoints.check_alpha(alpha_id)
            checks = ((checked.get("is") or {}).get("checks")) or []
            if checks:
                await self.state.alphas.save_checks(alpha_id, checks)
            failed = [str(c.get("name")) for c in checks if c.get("result") == "FAIL"]
            if failed and set(failed) <= DAILY_LIMIT_CHECKS:
                return await self._day_full(alpha_id, body)
            if failed:
                return await self._refused(alpha_id, f"Fails {', '.join(failed)}.", failed)
            if not checks or verdict(checks) != "submittable":
                self._not_before[alpha_id] = time.monotonic() + PENDING_RETRY_SECONDS
                await self._set(
                    alpha_id,
                    status=QueueStatus.QUEUED,
                    message="Checks still pending; tried again in 30 minutes.",
                )
                return {"alphaId": alpha_id, "submitted": False, "message": "Checks still pending."}

            if str(body.get("type")) == SUPER:
                await self._describe(alpha_id, body)

            outcome = await submit_alpha(self.state.client, alpha_id)
        except BrainError as exc:
            await self._set(alpha_id, status=QueueStatus.QUEUED, message=exc.message)
            return {"alphaId": alpha_id, "submitted": False, "message": exc.message}

        if outcome.submitted:
            return await self._submitted(alpha_id, mode, "Submitted.")
        if outcome.failed and set(outcome.failed) <= DAILY_LIMIT_CHECKS:
            return await self._day_full(alpha_id, body)
        return await self._refused(alpha_id, outcome.message, outcome.failed)

    async def _submitted(
        self, alpha_id: str, mode: str, message: str, at: datetime | None = None
    ) -> dict[str, Any]:
        await self._set(
            alpha_id,
            status=QueueStatus.SUBMITTED,
            submitted_at=at or utcnow(),
            mode=mode,
            message=message,
        )
        async with self.state.db.session() as session:
            await session.merge(Submission(alpha_id=alpha_id, submitted_at=at or utcnow()))
        log.info("submit_queue.submitted", alpha_id=alpha_id, mode=mode)
        return {"alphaId": alpha_id, "submitted": True, "message": message}

    async def _refused(self, alpha_id: str, message: str, failed: list[str]) -> dict[str, Any]:
        await self._set(alpha_id, status=QueueStatus.REFUSED, message=message)
        log.info("submit_queue.refused", alpha_id=alpha_id, failed=failed)
        return {"alphaId": alpha_id, "submitted": False, "message": message, "failed": failed}

    async def _day_full(self, alpha_id: str, body: dict[str, Any]) -> dict[str, Any]:
        kind = SUPER if str(body.get("type")) == SUPER else REGULAR
        self._full_on[kind] = self._today()
        message = f"BRAIN's {kind.lower()} submissions are used up today; it waits for tomorrow."
        await self._set(alpha_id, status=QueueStatus.QUEUED, message=message)
        return {"alphaId": alpha_id, "submitted": False, "message": message}

    async def _describe(self, alpha_id: str, body: dict[str, Any]) -> None:
        """Fill a SuperAlpha's selection and combo descriptions when it has none."""
        from .labs.super_alpha import descriptions  # the lab builds on the queue, not back

        selection = body.get("selection") or {}
        combo = body.get("combo") or {}
        if selection.get("description") and combo.get("description"):
            return
        settings = body.get("settings") or {}
        await self.state.endpoints.update_alpha(
            alpha_id,
            descriptions(
                str(selection.get("code") or ""),
                str(combo.get("code") or ""),
                limit=int(settings.get("selectionLimit") or 10),
                handling=str(settings.get("selectionHandling") or "POSITIVE"),
            ),
        )
