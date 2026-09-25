"""Super Lab: selections, their counts, a SuperAlpha task, then checks and submission.

Writing and counting selections simulate nothing. Adding the task queues one SuperAlpha per
selection and combo in Tasks, like any lab. Checking re-runs BRAIN's submission checks; only
the submit route submits, one Alpha per confirmed request.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..brain.errors import BrainError
from ..brain.schemas import SimulationSettings
from ..catalog.queries import Tuple4
from ..db.models import Study, Submission, SubmitQueueEntry, Trial, utcnow
from ..labs import super_alpha
from ..labs.launch import (
    OPERATORS_UNREAD,
    AddedTask,
    account_operators,
    add_study,
    choices,
    legal_choices,
)
from ..labs.params import SUPER_SAMPLER, SuperParams
from ..schemas import Out
from ..vault.yields import checks_of, verdict
from .deps import State, refuse

router = APIRouter(prefix="/api/super-lab", tags=["super-lab"])

MAX_SELECTIONS = 500
MAX_CORES = 8


class Market(BaseModel):
    region: str
    delay: int = Field(ge=0, le=1)
    universe: str


class SuperOptions(Out):
    operators: list[str]
    universes: list[str]
    neutralizations: list[str]
    datasets: int
    categories: int
    combos: list[str]
    handlings: list[str]
    modes: list[str]
    wrapper: str
    problems: list[str]


class GenerateRequest(Market):
    per_mode: int = Field(default=6, ge=1, le=100)
    modes: list[Literal["arithmetic", "if_else", "filter", "compound"]] = Field(
        default_factory=lambda: list(super_alpha.MODES)
    )
    wrapper: str = super_alpha.DEFAULT_WRAPPER
    seed: int | None = None


class Selection(Out):
    expression: str
    kind: str


class Generated(Out):
    selections: list[Selection]
    problems: list[str]


class CountRequest(BaseModel):
    region: str
    delay: int = Field(ge=0, le=1)
    selections: list[str] = Field(min_length=1, max_length=MAX_SELECTIONS)
    selection_limit: int = Field(default=10, ge=1, le=1000)
    selection_handling: str = "POSITIVE"


class Counted(Out):
    selection: str
    count: int | None
    message: str


class TaskRequest(Market):
    selections: list[str] = Field(min_length=1, max_length=MAX_SELECTIONS)
    combos: list[str] = Field(min_length=1, max_length=len(super_alpha.COMBOS) + 10)
    neutralization: str
    decay: int = Field(default=10, ge=0, le=512)
    truncation: float = Field(default=0.08, ge=0, le=1)
    test_period: str = "P2Y"
    selection_limit: int = Field(default=10, ge=1, le=1000)
    selection_handling: str = "POSITIVE"
    max_trade: Literal["ON", "OFF"] = "OFF"
    nan_handling: Literal["ON", "OFF"] = "OFF"
    cores: int = Field(default=3, ge=1, le=MAX_CORES)


class SuperResult(Out):
    alpha_id: str | None
    task_id: int
    task: str
    selection: str | None
    combo: str | None
    state: str
    message: str | None
    sharpe: float | None
    fitness: float | None
    turnover: float | None
    failed: list[str]
    verdict: str | None
    submitted: bool
    #: Where it stands in the Submit Queue, if it is there.
    queue: str | None


class CheckRequest(BaseModel):
    alpha_ids: list[str] = Field(min_length=1, max_length=100)
    #: Name, colour and tag the ones that pass, as the notebook does.
    mark_passed: bool = True


class Checked(Out):
    alpha_id: str
    passed: bool
    failed: list[str]
    message: str


class SubmitRequest(BaseModel):
    alpha_id: str = Field(min_length=1, max_length=64)
    #: Must be sent as ``true``: a submission cannot be taken back.
    confirm: Literal[True]


class Submitted(Out):
    alpha_id: str
    submitted: bool
    status: int
    message: str
    failed: list[str]


# -- the market ---------------------------------------------------------------------


async def _scope(state: Any, market: Market) -> tuple[super_alpha.SelectionScope, list[str]]:
    """Everything the generator draws from for one market, and what could not be read."""
    problems: list[str] = []
    operators = await account_operators(state, refresh=False)
    if not operators:
        problems.append(OPERATORS_UNREAD)
    selection_ops = frozenset(
        str(o.get("name")) for o in operators if "SELECTION" in (o.get("scope") or [])
    )
    if operators and not selection_ops:
        problems.append(
            "Your account has no SELECTION operators, so SuperAlphas are not open to it."
        )

    schema = await state.metadata.cached_settings_schema()
    legal = legal_choices(schema, market.region, market.delay)
    universes = [str(u) for u in choices(legal, "universe")]
    neutralizations = [str(n) for n in choices(legal, "neutralization")]

    rows = await state.queries.datasets(
        Tuple4(region=market.region, delay=market.delay, universe=market.universe)
    )
    datasets = [str(r["dataset_id"]) for r in rows]
    categories = sorted({str(r["category_id"]) for r in rows if r.get("category_id")})
    if not datasets:
        # Not downloaded here: ask BRAIN, as the notebook did.
        try:
            found = await state.endpoints.list_data_sets_all(
                instrumentType="EQUITY",
                region=market.region,
                delay=market.delay,
                universe=market.universe,
            )
            datasets = [d.id for d in found]
            categories = sorted({d.category.id for d in found if d.category})
        except BrainError as exc:
            problems.append(f"The datasets for this market could not be read: {exc.message}")

    scope = super_alpha.SelectionScope(
        operators=selection_ops,
        universes=universes,
        neutralizations=neutralizations,
        datasets=datasets,
        categories=categories,
    )
    return scope, problems


@router.get("/options")
async def options(state: State, region: str, delay: int, universe: str) -> SuperOptions:
    scope, problems = await _scope(state, Market(region=region, delay=delay, universe=universe))
    return SuperOptions(
        operators=sorted(scope.operators),
        universes=scope.universes,
        neutralizations=scope.neutralizations,
        datasets=len(scope.datasets),
        categories=len(scope.categories),
        combos=list(super_alpha.COMBOS),
        handlings=list(super_alpha.SELECTION_HANDLINGS),
        modes=list(super_alpha.MODES),
        wrapper=super_alpha.DEFAULT_WRAPPER,
        problems=problems,
    )


@router.post("/generate")
async def generate(body: GenerateRequest, state: State) -> Generated:
    """Write selection expressions. Free: nothing is sent to BRAIN but reads."""
    scope, problems = await _scope(state, body)
    if not scope.operators:
        return Generated(selections=[], problems=problems)
    rows = super_alpha.generate(
        scope, per_mode=body.per_mode, modes=body.modes, wrapper=body.wrapper, seed=body.seed
    )
    return Generated(selections=[Selection.model_validate(r) for r in rows], problems=problems)


@router.post("/count")
async def count(body: CountRequest, state: State) -> list[Counted]:
    """How many of your Alphas each selection picks. Free: simulates nothing."""
    rows = await super_alpha.count_selections(
        state.endpoints,
        body.selections,
        region=body.region,
        delay=body.delay,
        selection_limit=body.selection_limit,
        selection_handling=body.selection_handling,
    )
    return [Counted.model_validate(r) for r in rows]


@router.post("/tasks", status_code=201)
async def add_task(body: TaskRequest, state: State) -> AddedTask:
    """Queue one SuperAlpha per selection and combo as a task in Tasks."""
    if body.cores > state.engine.slots:
        raise refuse(
            422,
            "too_many_cores",
            f"The engine has {state.engine.slots} slots, so a task cannot hold {body.cores}.",
        )
    selections = list(dict.fromkeys(s.strip() for s in body.selections if s.strip()))
    combos = list(dict.fromkeys(c.strip() for c in body.combos if c.strip()))
    if not selections or not combos:
        raise refuse(422, "no_simulations", "Choose at least one selection and one combo.")

    settings = SimulationSettings(
        region=body.region,
        universe=body.universe,
        delay=body.delay,
        decay=body.decay,
        neutralization=body.neutralization,
        truncation=body.truncation,
        test_period=body.test_period,
        nan_handling=body.nan_handling,
        max_trade=body.max_trade,
        selection_handling=body.selection_handling,
        selection_limit=body.selection_limit,
    )
    requests = super_alpha.requests_for(selections, combos, settings)
    row = await add_study(
        state,
        now=utcnow(),
        lab="Super Lab",
        prefix="super-lab",
        sampler=SUPER_SAMPLER,
        params=SuperParams(
            region=body.region,
            delay=body.delay,
            universe=body.universe,
            neutralization=body.neutralization,
            decay=body.decay,
            selection_limit=body.selection_limit,
            selection_handling=body.selection_handling,
            selections=len(selections),
            combos=len(combos),
            cores=body.cores,
        ),
        objective="sharpe",
        simulations=len(requests),
        # SuperAlphas are sent one at a time, so a spare per core keeps each slot fed.
        batch_size=body.cores * 2,
        template_source=combos[0],
        template_name=f"Super Lab · {body.region} {body.universe}",
        seeds=super_alpha.seed_trials(requests),
    )
    return AddedTask(id=row.id, name=row.name)


# -- results, checks and submission ----------------------------------------------------


@router.get("/results")
async def results(state: State, task_id: int | None = None) -> list[SuperResult]:
    """Every SuperAlpha the lab's tasks have simulated, newest task first."""
    async with state.db.session() as session:
        query = (
            select(Trial, Study.id, Study.task)
            .join(Study, Trial.study_id == Study.id)
            .where(Study.sampler == SUPER_SAMPLER)
            .order_by(Study.id.desc(), Trial.number)
        )
        if task_id is not None:
            query = query.where(Study.id == task_id)
        rows = (await session.execute(query)).all()
        ids = [t.alpha_id for t, _, _ in rows if t.alpha_id]
        submitted = (
            set(
                (
                    await session.scalars(
                        select(Submission.alpha_id).where(Submission.alpha_id.in_(ids))
                    )
                ).all()
            )
            if ids
            else set()
        )
        queued: dict[str, str] = (
            {
                str(a): str(st)
                for a, st in (
                    await session.execute(
                        select(SubmitQueueEntry.alpha_id, SubmitQueueEntry.status).where(
                            SubmitQueueEntry.alpha_id.in_(ids)
                        )
                    )
                ).tuples()
            }
            if ids
            else {}
        )
    stored = await state.alphas.by_ids(ids)

    out: list[SuperResult] = []
    for trial, study_id, task in rows:
        alpha = stored.get(trial.alpha_id or "") or {}
        checks = checks_of(alpha.get("checks"))
        values = trial.values or []
        out.append(
            SuperResult(
                alpha_id=trial.alpha_id,
                task_id=study_id,
                task=task,
                selection=trial.expression,
                combo=(trial.params or {}).get("combo"),
                state=str(trial.state),
                message=trial.message,
                sharpe=alpha.get("sharpe") if alpha else (values[0] if values else None),
                fitness=alpha.get("fitness"),
                turnover=alpha.get("turnover"),
                failed=[str(c.get("name")) for c in checks if c.get("result") == "FAIL"],
                verdict=verdict(checks) if checks else None,
                submitted=(trial.alpha_id in submitted) or bool(alpha.get("date_submitted")),
                queue=queued.get(trial.alpha_id or ""),
            )
        )
    return out


async def _check_one(state: Any, alpha_id: str, mark_passed: bool) -> Checked:
    try:
        body = await state.endpoints.check_alpha(alpha_id)
    except BrainError as exc:
        return Checked(alpha_id=alpha_id, passed=False, failed=[], message=exc.message)
    checks = ((body.get("is") or {}).get("checks")) or []
    if not checks:
        return Checked(
            alpha_id=alpha_id, passed=False, failed=[], message="BRAIN returned no checks."
        )
    await state.alphas.save_checks(alpha_id, checks)
    failed = [str(c.get("name")) for c in checks if c.get("result") == "FAIL"]
    passed = not failed and verdict(checks) == "submittable"
    message = (
        "Passes every check."
        if passed
        else (f"Fails {', '.join(failed)}." if failed else "Some checks are still pending.")
    )
    if passed and mark_passed:
        try:
            await state.endpoints.update_alpha(
                alpha_id,
                {
                    "name": alpha_id,
                    "color": super_alpha.PASSED_COLOR,
                    "tags": list(super_alpha.PASSED_TAGS),
                },
            )
        except BrainError as exc:
            message += f" Its name, colour and tag could not be set: {exc.message}"
    return Checked(alpha_id=alpha_id, passed=passed, failed=failed, message=message)


@router.post("/check")
async def check(body: CheckRequest, state: State) -> list[Checked]:
    """Re-run BRAIN's submission checks. Changes nothing but the passing Alphas' labels."""
    return [await _check_one(state, a, body.mark_passed) for a in dict.fromkeys(body.alpha_ids)]


@router.post("/submit")
async def submit(body: SubmitRequest, state: State) -> Submitted:
    """Submit one SuperAlpha on BRAIN. Irreversible; the request must carry ``confirm: true``."""
    alpha_id = body.alpha_id.strip()
    async with state.db.session() as session:
        trial = await session.scalar(
            select(Trial)
            .join(Study, Trial.study_id == Study.id)
            .where(Study.sampler == SUPER_SAMPLER, Trial.alpha_id == alpha_id)
            .limit(1)
        )
    if trial is None:
        raise refuse(404, "not_a_super_lab_alpha", f"{alpha_id} was not made by the Super Lab.")

    # The queue checks it, fills its descriptions, submits it and counts it against the day.
    out = await state.submit_queue.submit_now(alpha_id)
    return Submitted(
        alpha_id=alpha_id,
        submitted=out["submitted"],
        status=200 if out["submitted"] else 409,
        message=out["message"],
        failed=list(out.get("failed") or []),
    )
