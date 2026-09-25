"""Osmosis: the allocation BRAIN holds, the one the harness would set, and applying it.

Reading and previewing change nothing. Applying edits Osmosis points on BRAIN; it is always
reversible by applying again, until the Sunday lock fixes that week's allocation.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import osmosis as rules
from ..schemas import Out
from .deps import State

router = APIRouter(prefix="/api/osmosis", tags=["osmosis"])


class AlphaPoints(Out):
    alpha_id: str
    type: str
    sharpe: float | None
    fitness: float | None
    turnover: float | None
    current: int | None
    planned: int | None


class ScopeView(Out):
    scope: str
    eligible: int
    allocated: bool
    current_total: int
    current_alphas: int
    alphas: list[AlphaPoints]


class OsmosisView(Out):
    auto: bool
    per_scope: int
    weighting: str
    include_super: bool
    last_applied: str | None
    last_result: str | None
    #: Whether the allocation BRAIN holds right now meets the rules.
    current_eligible: bool
    current_problems: list[str]
    #: Whether the planned one would.
    planned_eligible: bool
    problems: list[str]
    changes: int
    scopes: list[ScopeView]
    rules: dict[str, int]


class SettingsBody(BaseModel):
    auto: bool
    per_scope: int = Field(ge=rules.MIN_ALPHAS, le=100)
    weighting: Literal["fitness", "sharpe", "equal"]
    include_super: bool


class Approve(BaseModel):
    #: Must be ``true``: this edits Osmosis points on BRAIN.
    confirm: Literal[True]


class Applied(Out):
    applied: int
    failed: list[str]
    eligible: bool
    message: str


@router.get("")
async def view(state: State) -> OsmosisView:
    found, bodies, settings = await state.osmosis.preview()
    ok, current_problems = rules.current_eligible(bodies)
    cands = {c.alpha_id: c for c in (rules.candidate(b) for b in bodies) if c is not None}
    scopes = []
    for sp in found.scopes:
        members = [c for c in cands.values() if c.scope == sp.scope]
        # What matters first: the planned Alphas by points, then whatever holds points now.
        members.sort(
            key=lambda c: (-(sp.points.get(c.alpha_id) or 0), -(c.current or 0), c.alpha_id)
        )
        shown = [c for c in members if sp.points.get(c.alpha_id) or c.current]
        scopes.append(
            ScopeView(
                scope=sp.scope,
                eligible=sp.eligible,
                allocated=sp.allocated,
                current_total=sp.current_total,
                current_alphas=sp.current_alphas,
                alphas=[
                    AlphaPoints(
                        alpha_id=c.alpha_id,
                        type=c.type,
                        sharpe=c.sharpe,
                        fitness=c.fitness,
                        turnover=c.turnover,
                        current=c.current,
                        planned=sp.points.get(c.alpha_id),
                    )
                    for c in shown
                ],
            )
        )
    return OsmosisView(
        auto=settings.auto,
        per_scope=settings.per_scope,
        weighting=settings.weighting,
        include_super=settings.include_super,
        last_applied=settings.last_applied,
        last_result=settings.last_result,
        current_eligible=ok,
        current_problems=current_problems,
        planned_eligible=found.eligible,
        problems=found.problems,
        changes=len(found.changes),
        scopes=scopes,
        rules={
            "pointsPerScope": rules.POINTS_PER_SCOPE,
            "minAlphas": rules.MIN_ALPHAS,
            "minScopes": rules.MIN_SCOPES,
        },
    )


@router.put("/settings", status_code=204)
async def save_settings(body: SettingsBody, state: State) -> None:
    settings = await state.osmosis.settings()
    settings.auto = body.auto
    settings.per_scope = body.per_scope
    settings.weighting = body.weighting
    settings.include_super = body.include_super
    await state.osmosis.save(settings)


@router.post("/apply")
async def apply(body: Approve, state: State) -> Applied:  # noqa: ARG001 - the approval is the body
    """Set every submitted Alpha's Osmosis points to the plan, now."""
    return Applied.model_validate(await state.osmosis.apply())
