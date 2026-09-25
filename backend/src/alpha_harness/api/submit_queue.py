"""Submit Queue: Alphas approved for submission, sent within the daily caps or one by one.

Adding an Alpha is the approval for the automatic path, which never passes the day's caps. The
submit route is the per-Alpha approval past them, and needs ``confirm: true``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..brain.filters import PLATFORM_TZ
from ..db.models import SubmitQueueEntry
from ..llm.budget import seconds_until_reset
from ..schemas import Out
from .deps import State, refuse

router = APIRouter(prefix="/api/submit-queue", tags=["submit-queue"])


class KindDay(Out):
    kind: str
    cap: int
    submitted: int
    #: BRAIN said this kind's submissions are used up today.
    full: bool


class QueueEntry(Out):
    alpha_id: str
    kind: str
    position: int
    status: str
    mode: str | None
    message: str | None
    added_at: datetime
    attempted_at: datetime | None
    submitted_at: datetime | None
    sharpe: float | None
    fitness: float | None


class QueueView(Out):
    paused: bool
    days: list[KindDay]
    resets_in_seconds: int
    last_tick: datetime | None
    entries: list[QueueEntry]


class Ids(BaseModel):
    alpha_ids: list[str] = Field(min_length=1, max_length=500)


class Added(Out):
    alpha_id: str
    added: bool
    message: str


class Pause(BaseModel):
    paused: bool


class Caps(BaseModel):
    regular: int = Field(ge=0, le=20)
    super: int = Field(ge=0, le=20)


class Approve(BaseModel):
    #: Must be sent as ``true``: a submission cannot be taken back.
    confirm: Literal[True]


class SubmitOutcome(Out):
    alpha_id: str
    submitted: bool
    message: str


@router.get("")
async def view(state: State) -> QueueView:
    queue = state.submit_queue
    counts = await queue.submitted_today()
    async with state.db.session() as session:
        rows = (
            await session.scalars(
                select(SubmitQueueEntry).order_by(
                    SubmitQueueEntry.position, SubmitQueueEntry.added_at
                )
            )
        ).all()
    stored = await state.alphas.by_ids([r.alpha_id for r in rows])
    return QueueView(
        paused=await queue.paused(),
        days=[
            KindDay(kind=kind, cap=cap, submitted=counts.get(kind, 0), full=queue.full_today(kind))
            for kind, cap in (await queue.caps()).items()
        ],
        resets_in_seconds=round(seconds_until_reset(tz=PLATFORM_TZ)),
        last_tick=queue.last_tick,
        entries=[
            QueueEntry(
                alpha_id=r.alpha_id,
                kind=r.kind,
                position=r.position,
                status=r.status,
                mode=r.mode,
                message=r.message,
                added_at=r.added_at,
                attempted_at=r.attempted_at,
                submitted_at=r.submitted_at,
                sharpe=(stored.get(r.alpha_id) or {}).get("sharpe"),
                fitness=(stored.get(r.alpha_id) or {}).get("fitness"),
            )
            for r in rows
        ],
    )


@router.post("/add")
async def add(body: Ids, state: State) -> list[Added]:
    """Approve Alphas for the automatic path, queued at the back in the order given."""
    return [Added.model_validate(r) for r in await state.submit_queue.add(body.alpha_ids)]


@router.post("/reorder", status_code=204)
async def reorder(body: Ids, state: State) -> None:
    await state.submit_queue.reorder(body.alpha_ids)


@router.delete("/{alpha_id}", status_code=204)
async def remove(alpha_id: str, state: State) -> None:
    if not await state.submit_queue.remove(alpha_id):
        raise refuse(409, "not_removable", f"{alpha_id} is not waiting in the queue.")


@router.post("/pause", status_code=204)
async def pause(body: Pause, state: State) -> None:
    await state.submit_queue.set_paused(body.paused)


@router.put("/caps", status_code=204)
async def set_caps(body: Caps, state: State) -> None:
    """How many of each kind the queue may submit on its own per day. Zero stops that kind."""
    await state.submit_queue.set_caps({"REGULAR": body.regular, "SUPER": body.super})


@router.post("/{alpha_id}/submit")
async def submit_now(alpha_id: str, body: Approve, state: State) -> SubmitOutcome:  # noqa: ARG001 - the approval is the body
    """Submit one Alpha now, past the daily caps. Irreversible."""
    out = await state.submit_queue.submit_now(alpha_id.strip())
    return SubmitOutcome(
        alpha_id=out["alphaId"], submitted=out["submitted"], message=out["message"]
    )
