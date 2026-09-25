"""Osmosis: spreading each scope's 100,000 points over the account's strongest submitted Alphas.

BRAIN's rules, as its own announcements state them (Osmosis launch, 2026-02-05; the eligibility
reminders; "You are ready to allocate Osmosis points", 2026-04-21):

* A *scope* is a region by delay. At least **3** scopes must be allocated.
* In each allocated scope, points go to at least **10** Alphas and add up to **exactly
  100,000**. One Alpha takes a whole number from 1 to 100,000.
* Allocations lock every **Sunday 23:59 US Eastern** and count, if eligible, towards the Daily
  Osmosis Rank from seven days later. They feed base payments and Combined Osmosis Performance.

:func:`plan` is pure: it decides every Alpha's points from their bodies. :class:`Osmosis`
reads BRAIN, applies only what changes, reads BRAIN back to confirm, and runs itself once a
week before the lock when automatic allocation is on.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

import structlog

from .brain.errors import BrainError
from .brain.filters import PLATFORM_TZ
from .db.models import MetadataCache, utcnow

if TYPE_CHECKING:
    from .state import AppState

log = structlog.get_logger(__name__)

POINTS_PER_SCOPE = 100_000
MIN_ALPHAS = 10
MIN_SCOPES = 3
SETTINGS_KEY = "osmosis"
#: How often the automatic run looks at the clock.
TICK_SECONDS = 15 * 60.0
#: The automatic run allocates once a week, from Saturday on, well before Sunday's lock.
AUTO_WEEKDAYS = (5, 6)  # Saturday, Sunday
LOCK_HOUR = 23

Weighting = Literal["fitness", "sharpe", "equal"]


@dataclass(slots=True)
class Settings:
    auto: bool = True
    #: Alphas to allocate per scope, at least :data:`MIN_ALPHAS`.
    per_scope: int = 20
    weighting: Weighting = "fitness"
    #: Whether SuperAlphas take points. Off by default: the rules speak of Alphas, and a
    #: scope holding both is not something BRAIN documents.
    include_super: bool = False
    last_applied: str | None = None
    last_result: str | None = None

    def dump(self) -> dict[str, Any]:
        return {
            "auto": self.auto,
            "perScope": self.per_scope,
            "weighting": self.weighting,
            "includeSuper": self.include_super,
            "lastApplied": self.last_applied,
            "lastResult": self.last_result,
        }

    @classmethod
    def load(cls, raw: dict[str, Any] | None) -> Settings:
        raw = raw or {}
        weighting = raw.get("weighting")
        return cls(
            auto=bool(raw.get("auto", True)),
            per_scope=max(MIN_ALPHAS, min(100, int(raw.get("perScope") or 20))),
            weighting=weighting if weighting in ("fitness", "sharpe", "equal") else "fitness",
            include_super=bool(raw.get("includeSuper", False)),
            last_applied=raw.get("lastApplied"),
            last_result=raw.get("lastResult"),
        )


@dataclass(slots=True)
class Candidate:
    alpha_id: str
    type: str
    region: str
    delay: int
    sharpe: float | None
    fitness: float | None
    turnover: float | None
    submitted: str | None
    current: int | None

    @property
    def scope(self) -> str:
        return f"{self.region} D{self.delay}"


@dataclass(slots=True)
class ScopePlan:
    scope: str
    eligible: int
    #: Alpha id -> points, summing to exactly :data:`POINTS_PER_SCOPE`. Empty when the scope
    #: has fewer than :data:`MIN_ALPHAS` eligible Alphas.
    points: dict[str, int] = field(default_factory=dict)
    current_total: int = 0
    current_alphas: int = 0

    @property
    def allocated(self) -> bool:
        return bool(self.points)


@dataclass(slots=True)
class Plan:
    scopes: list[ScopePlan]
    #: Alpha id -> the points it should carry; ``None`` clears it.
    target: dict[str, int | None]
    #: Only the Alphas whose points change.
    changes: dict[str, int | None]
    eligible: bool
    problems: list[str]


def candidate(body: dict[str, Any]) -> Candidate | None:
    settings = body.get("settings") or {}
    region, delay = settings.get("region"), settings.get("delay")
    if not region or delay is None or not body.get("id"):
        return None
    stats = body.get("is") or {}

    def num(v: Any) -> float | None:
        return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else None

    points = body.get("osmosisPoints")
    return Candidate(
        alpha_id=str(body["id"]),
        type=str(body.get("type") or "REGULAR"),
        region=str(region),
        delay=int(delay),
        sharpe=num(stats.get("sharpe")),
        fitness=num(stats.get("fitness")),
        turnover=num(stats.get("turnover")),
        submitted=body.get("dateSubmitted"),
        current=int(points) if isinstance(points, int | float) else None,
    )


def _score(c: Candidate, weighting: Weighting) -> float:
    if weighting == "equal":
        return 1.0
    value = c.fitness if weighting == "fitness" else c.sharpe
    return max(0.0, value or 0.0)


def split(scores: list[float], total: int = POINTS_PER_SCOPE) -> list[int]:
    """Whole points in proportion to ``scores``, each at least 1, summing exactly to ``total``.

    Largest-remainder rounding, so the sum is exact and no Alpha is off by more than a point.
    All-zero scores split evenly.
    """
    n = len(scores)
    if n == 0:
        return []
    weights = scores if sum(scores) > 0 else [1.0] * n
    # Every Alpha is guaranteed its one point; the rest is shared by weight.
    spare = total - n
    raw = [spare * w / sum(weights) for w in weights]
    floors = [math.floor(r) for r in raw]
    left = spare - sum(floors)
    by_remainder = sorted(range(n), key=lambda i: raw[i] - floors[i], reverse=True)
    for i in by_remainder[:left]:
        floors[i] += 1
    return [f + 1 for f in floors]


def plan(bodies: list[dict[str, Any]], settings: Settings) -> Plan:
    """Every submitted Alpha's points: the strongest in each scope share 100,000, the rest none."""
    cands = [c for c in (candidate(b) for b in bodies) if c is not None]
    by_scope: dict[str, list[Candidate]] = {}
    for c in cands:
        by_scope.setdefault(c.scope, []).append(c)

    scopes: list[ScopePlan] = []
    target: dict[str, int | None] = {c.alpha_id: None for c in cands}
    for scope, members in sorted(by_scope.items(), key=lambda kv: -len(kv[1])):
        eligible = [c for c in members if settings.include_super or c.type != "SUPER"]
        current = [c for c in members if c.current]
        sp = ScopePlan(
            scope=scope,
            eligible=len(eligible),
            current_total=sum(c.current or 0 for c in current),
            current_alphas=len(current),
        )
        if len(eligible) >= MIN_ALPHAS:
            chosen = sorted(
                eligible,
                key=lambda c: (_score(c, settings.weighting), c.sharpe or 0.0),
                reverse=True,
            )[: max(MIN_ALPHAS, settings.per_scope)]
            for c, pts in zip(
                chosen, split([_score(c, settings.weighting) for c in chosen]), strict=True
            ):
                sp.points[c.alpha_id] = pts
                target[c.alpha_id] = pts
        scopes.append(sp)

    allocated = [s for s in scopes if s.allocated]
    problems: list[str] = []
    if len(allocated) < MIN_SCOPES:
        short = [f"{s.scope} ({s.eligible})" for s in scopes if not s.allocated and s.eligible]
        problems.append(
            f"Only {len(allocated)} scope(s) have {MIN_ALPHAS} or more eligible Alphas; Osmosis "
            f"needs {MIN_SCOPES}." + (f" Closest: {', '.join(short)}." if short else "")
        )
    current = {c.alpha_id: c.current for c in cands}
    changes = {a: p for a, p in target.items() if (current.get(a) or None) != p}
    return Plan(
        scopes=scopes,
        target=target,
        changes=changes,
        eligible=not problems,
        problems=problems,
    )


def current_eligible(bodies: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    """Whether the allocation BRAIN holds now meets the rules, and why not."""
    by_scope: dict[str, list[int]] = {}
    for c in (candidate(b) for b in bodies):
        if c is not None and c.current:
            by_scope.setdefault(c.scope, []).append(c.current)
    problems = [
        f"{scope}: {len(pts)} Alphas, {sum(pts):,} points"
        for scope, pts in by_scope.items()
        if len(pts) < MIN_ALPHAS or sum(pts) != POINTS_PER_SCOPE
    ]
    good = len(by_scope) - len(problems)
    if good < MIN_SCOPES:
        problems.insert(0, f"{good} valid scope(s) of the {MIN_SCOPES} needed")
    return not problems, problems


class Osmosis:
    def __init__(self, state: AppState) -> None:
        self.state = state
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    # -- settings --------------------------------------------------------

    async def settings(self) -> Settings:
        async with self.state.db.session() as session:
            row = await session.get(MetadataCache, SETTINGS_KEY)
            return Settings.load(row.value if row else None)

    async def save(self, settings: Settings) -> None:
        async with self.state.db.session() as session:
            row = await session.get(MetadataCache, SETTINGS_KEY)
            if row is None:
                session.add(MetadataCache(key=SETTINGS_KEY, value=settings.dump()))
            else:
                row.value, row.fetched_at = settings.dump(), utcnow()

    # -- reading and applying ----------------------------------------------

    async def preview(self) -> tuple[Plan, list[dict[str, Any]], Settings]:
        settings = await self.settings()
        bodies = await self.state.endpoints.submitted_alphas()
        return plan(bodies, settings), bodies, settings

    async def apply(self) -> dict[str, Any]:
        """Set every Alpha's points to the plan, then read BRAIN back to confirm."""
        async with self._lock:
            found, _, settings = await self.preview()
            if not found.eligible:
                message = "Not applied: " + " ".join(found.problems)
                settings.last_result = message
                await self.save(settings)
                return {"applied": 0, "failed": [], "eligible": False, "message": message}

            # Clear first, then set: a scope never holds more than 100,000 in between.
            order = sorted(found.changes.items(), key=lambda kv: kv[1] is not None)
            failed: list[str] = []
            gate = asyncio.Semaphore(4)

            async def put(alpha_id: str, points: int | None) -> None:
                async with gate:
                    try:
                        await self.state.endpoints.update_alpha(alpha_id, {"osmosisPoints": points})
                    except BrainError as exc:
                        failed.append(f"{alpha_id}: {exc.message}")

            clears = [(a, p) for a, p in order if p is None]
            sets = [(a, p) for a, p in order if p is not None]
            await asyncio.gather(*(put(a, p) for a, p in clears))
            await asyncio.gather(*(put(a, p) for a, p in sets))

            after = await self.state.endpoints.submitted_alphas()
            ok, problems = current_eligible(after)
            now = datetime.now(PLATFORM_TZ)
            message = (
                f"Allocated {len(sets)} Alphas across "
                f"{sum(1 for s in found.scopes if s.allocated)} scopes; BRAIN confirms it."
                if ok and not failed
                else "Applied with problems: " + "; ".join([*failed, *problems])
            )
            settings.last_applied = now.isoformat()
            settings.last_result = message
            await self.save(settings)
            log.info("osmosis.applied", changed=len(found.changes), failed=len(failed), ok=ok)
            return {
                "applied": len(found.changes) - len(failed),
                "failed": failed,
                "eligible": ok,
                "message": message,
            }

    # -- the weekly run -----------------------------------------------------

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="osmosis")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def due(self, settings: Settings, now: datetime | None = None) -> bool:
        """Saturday or Sunday before the lock, and not yet applied since this week's Saturday."""
        now = (now or datetime.now(PLATFORM_TZ)).astimezone(PLATFORM_TZ)
        if not settings.auto or now.weekday() not in AUTO_WEEKDAYS:
            return False
        if now.weekday() == 6 and now.hour >= LOCK_HOUR:
            return False
        saturday = now.date().toordinal() - (now.weekday() - 5)
        if settings.last_applied:
            last = datetime.fromisoformat(settings.last_applied).astimezone(PLATFORM_TZ)
            if last.date().toordinal() >= saturday:
                return False
        return True

    async def _run(self) -> None:
        while True:
            try:
                settings = await self.settings()
                if self.state.auth.session.authenticated and self.due(settings):
                    log.info("osmosis.auto_apply")
                    await self.apply()
            # One failed week must not end the loop; it is logged and retried next tick.
            except Exception:
                log.exception("osmosis.auto_failed")
            await asyncio.sleep(TICK_SECONDS)
