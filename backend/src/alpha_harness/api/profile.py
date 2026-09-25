"""Profile: everything BRAIN tells us about the account, and what this harness did with it.

Each part is read on its own and in parallel; one BRAIN refuses is said in ``problems`` and
the rest still show. BRAIN is read at most every ten minutes unless ``refresh``.
"""

from __future__ import annotations

import asyncio
import time
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Query
from sqlalchemy import func, select

from ..brain.errors import BrainError
from ..db.models import QueueStatus, SimulationRecord, Study, SubmitQueueEntry
from ..schemas import Out
from .deps import State

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/profile", tags=["profile"])

TTL_SECONDS = 600.0
_cache: dict[str, tuple[float, Any]] = {}

#: What each part is read from, relative to ``/users/self``.
PARTS = {
    "consultant": "consultant",
    "simulations": "activities/simulations",
    "submissions": "activities/submissions",
    "basePayment": "activities/base-payment",
    "otherPayment": "activities/other-payment",
    "diversity": "activities/diversity",
    "referrals": "activities/referrals",
    "pyramids": "activities/pyramid-multipliers",
    "competitions": "competitions",
    "messages": "messages?limit=8",
    "alphas": "alphas/summary",
}


class Window(Out):
    start: str | None
    end: str | None
    value: float | None


class Activity(Out):
    """One of BRAIN's activity series: headline windows and the dated rows."""

    title: str
    yesterday: Window | None
    current: Window | None
    previous: Window | None
    ytd: Window | None
    total: Window | None
    #: ``[date, value]`` oldest first.
    records: list[tuple[str, float]]


class Payment(Out):
    date: str
    amount: float
    kind: str


class DiversityRow(Out):
    region: str | None
    delay: int | None
    category: str | None
    alphas: int
    check: str | None
    limit: float | None


class Pyramid(Out):
    category: str
    region: str
    delay: int
    multiplier: float


class Competition(Out):
    id: str
    name: str
    status: str | None
    start: str | None
    end: str | None
    rank: int | None
    alphas: int | None
    scoring: str | None


class Referral(Out):
    id: str
    country: str | None
    active: bool
    sign_in: str | None
    eligible_alphas: str | None


class Message(Out):
    id: str
    type: str | None
    title: str
    date: str | None


class Harness(Out):
    """What this harness itself did for the account."""

    simulations_sent: int
    tasks: int
    submissions: int


class ProfileView(Out):
    user: dict[str, Any]
    features: list[str]
    session_expires_in_seconds: int | None
    consultant: dict[str, Any]
    simulations: Activity | None
    submissions: Activity | None
    base_payment: Activity | None
    other_payments: list[Payment]
    currency: str
    diversity: list[DiversityRow]
    pyramids: list[Pyramid]
    competitions: list[Competition]
    referrals: list[Referral]
    messages: list[Message]
    alphas: dict[str, int]
    harness: Harness
    problems: list[str]


def _window(raw: Any) -> Window | None:
    if not isinstance(raw, dict):
        return None
    value = raw.get("value")
    return Window(
        start=raw.get("start"),
        end=raw.get("end"),
        value=float(value) if isinstance(value, int | float) else None,
    )


def _activity(body: dict[str, Any]) -> Activity | None:
    if not body:
        return None
    records = (body.get("records") or {}).get("records") or []
    schema = (body.get("records") or {}).get("schema") or {}
    return Activity(
        title=str(schema.get("title") or ""),
        yesterday=_window(body.get("yesterday")),
        current=_window(body.get("current")),
        previous=_window(body.get("previous")),
        ytd=_window(body.get("ytd")),
        total=_window(body.get("total")),
        records=[
            (str(r[0]), float(r[1]))
            for r in records
            if isinstance(r, list) and len(r) >= 2 and isinstance(r[1], int | float)
        ],
    )


async def _read(state: Any, name: str, path: str, refresh: bool) -> dict[str, Any]:
    hit = _cache.get(name)
    if hit and not refresh and time.monotonic() - hit[0] < TTL_SECONDS:
        return hit[1]
    body = await state.endpoints.account_resource(path)
    _cache[name] = (time.monotonic(), body)
    return body


@router.get("")
async def profile(state: State, refresh: Annotated[bool, Query()] = False) -> ProfileView:
    session = state.auth.session
    problems: list[str] = []
    user_task = state.auth.get_user_profile(refresh=refresh)
    names = list(PARTS)
    found = await asyncio.gather(
        user_task,
        *(_read(state, n, PARTS[n], refresh) for n in names),
        return_exceptions=True,
    )
    user = found[0] if isinstance(found[0], dict) else {}
    parts: dict[str, dict[str, Any]] = {}
    for name, body in zip(names, found[1:], strict=True):
        if isinstance(body, BaseException):
            message = body.message if isinstance(body, BrainError) else str(body)
            problems.append(f"{name}: {message}")
            log.warning("profile.part_failed", part=name, error=message)
            parts[name] = {}
        else:
            parts[name] = body

    other = parts["otherPayment"]
    payments = [
        Payment(date=str(r[0]), amount=float(r[1]), kind=str(r[2]) if len(r) > 2 else "")
        for r in ((other.get("records") or {}).get("records") or [])
        if isinstance(r, list) and len(r) >= 2 and isinstance(r[1], int | float)
    ]

    diversity = [
        DiversityRow(
            region=a.get("region"),
            delay=a.get("delay"),
            category=(a.get("dataCategory") or {}).get("name"),
            alphas=int(a.get("alphaCount") or 0),
            check=(a.get("dataDiversity") or {}).get("check"),
            limit=(a.get("dataDiversity") or {}).get("limit"),
        )
        for a in parts["diversity"].get("alphas") or []
        # Rows without a category are BRAIN's region subtotals; the table sums its own.
        if (a.get("dataCategory") or {}).get("name") and a.get("delay") is not None
    ]

    pyramids = [
        Pyramid(
            category=str((p.get("category") or {}).get("name") or ""),
            region=str(p.get("region") or ""),
            delay=int(p.get("delay") or 0),
            multiplier=float(p.get("multiplier") or 0),
        )
        for p in parts["pyramids"].get("pyramids") or []
    ]

    competitions = [
        Competition(
            id=str(c.get("id")),
            name=str(c.get("name") or c.get("id")),
            status=c.get("status"),
            start=c.get("startDate"),
            end=c.get("endDate"),
            rank=(c.get("leaderboard") or {}).get("rank"),
            alphas=(c.get("leaderboard") or {}).get("alphas"),
            scoring=c.get("scoring"),
        )
        for c in parts["competitions"].get("results") or []
    ]

    referrals = [
        Referral(
            id=str((r.get("user") or {}).get("id") or ""),
            country=(r.get("user") or {}).get("country"),
            active=bool((r.get("user") or {}).get("active")),
            sign_in=(r.get("user") or {}).get("signIn"),
            eligible_alphas=(r.get("user") or {}).get("eligibleAlphas"),
        )
        for r in parts["referrals"].get("results") or []
    ]

    messages = [
        Message(
            id=str(m.get("id")),
            type=m.get("type"),
            title=str(m.get("title") or ""),
            date=m.get("dateCreated") or m.get("dateUpdated"),
        )
        for m in parts["messages"].get("results") or []
    ]

    async with state.db.session() as db:
        sent = await db.scalar(
            select(func.count())
            .select_from(SimulationRecord)
            .where(SimulationRecord.platform_id.is_not(None))
        )
        tasks = await db.scalar(select(func.count()).select_from(Study))
        submitted = await db.scalar(
            select(func.count())
            .select_from(SubmitQueueEntry)
            .where(SubmitQueueEntry.status == QueueStatus.SUBMITTED)
        )

    return ProfileView(
        user=user,
        features=list(session.permissions or []),
        session_expires_in_seconds=session.expires_in_seconds,
        consultant=parts["consultant"],
        simulations=_activity(parts["simulations"]),
        submissions=_activity(parts["submissions"]),
        base_payment=_activity(parts["basePayment"]),
        other_payments=payments,
        currency=str(other.get("currency") or "USD"),
        diversity=diversity,
        pyramids=pyramids,
        competitions=competitions,
        referrals=referrals,
        messages=messages,
        alphas={k: int(v) for k, v in parts["alphas"].items() if isinstance(v, int)},
        harness=Harness(
            simulations_sent=int(sent or 0), tasks=int(tasks or 0), submissions=int(submitted or 0)
        ),
        problems=problems,
    )
