"""AI help on one Alpha: draft its properties, and remodel it to pass the checks it failed.

Both use a model the consultant picks from those their keys can reach. Nothing here writes
to BRAIN by itself: a drafted description comes back for review and saving, and a remodel
only queues simulations, which the consultant then checks. Submitting stays their act.
"""

from __future__ import annotations

import json
import re
from typing import Any

import structlog
from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..brain.errors import BrainError
from ..brain.schemas import SimulationRequest, SimulationSettings
from ..db.models import BrainCache, SimStatus, SimulationRecord
from ..labs.fastexpr import (
    GROUPING,
    REQUIRED_KEYWORDS,
    ParseError,
    operator_table,
    parse,
    render,
    validate,
    walk,
)
from ..labs.power_pool import operators_text
from ..llm.keys import LLMError
from ..schemas import Out
from ..vault.yields import checks_of
from .alphas import _info  # pyright: ignore[reportPrivateUsage]
from .deps import State, refuse

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/alphas", tags=["alphas"])

#: BRAIN's categories, as the Properties panel offers them.
CATEGORIES = (
    "PRICE_REVERSION",
    "PRICE_MOMENTUM",
    "VOLUME",
    "FUNDAMENTAL",
    "ANALYST",
    "PRICE_VOLUME",
    "RELATION",
    "SENTIMENT",
)
#: The Power Pool description template's sections, in its order.
HEADINGS = ("Idea", "Rationale for data used", "Rationale for operators used")
#: Neutralizations every region offers; a variant may not reach for a regional one.
NEUTRALIZATIONS = ("NONE", "MARKET", "SECTOR", "INDUSTRY", "SUBINDUSTRY")
MAX_VARIANTS = 6


class AssistRequest(BaseModel):
    model: str | None = Field(default=None, description="A model id; empty for the default")


class Described(Out):
    name: str
    category: str
    tags: list[str]
    description: str
    model: str


class RemodelRequest(AssistRequest):
    count: int = Field(default=4, ge=1, le=MAX_VARIANTS)


class Variant(Out):
    expression: str
    decay: int | None
    neutralization: str | None
    truncation: float | None
    why: str
    record_id: int | None
    #: ``QUEUED`` when sent to the engine, ``SKIPPED`` when BRAIN already has it.
    status: str
    alpha_id: str | None


class Rejection(Out):
    expression: str
    reason: str


class Remodelled(Out):
    task: str
    model: str
    failed: list[str]
    queued: list[Variant]
    rejected: list[Rejection]


class RemodelRow(Out):
    record_id: int
    expression: str | None
    decay: int | None
    neutralization: str | None
    why: str | None
    status: str
    message: str | None
    alpha_id: str | None
    sharpe: float | None
    fitness: float | None
    turnover: float | None
    #: Checks as the vault last stored them; empty until the Alpha is read or checked.
    passed: list[str]
    failed: list[str]
    pending: list[str]
    created_at: str | None


def _task(alpha_id: str) -> str:
    return f"remodel:{alpha_id}"


def _notes_key(alpha_id: str) -> str:
    return f"remodel-notes:{alpha_id}"


async def _alpha(state: Any, alpha_id: str) -> Any:
    try:
        body = await state.endpoints.alpha_body(alpha_id)
    except BrainError as exc:
        raise refuse(502, "brain_unavailable", f"BRAIN did not return {alpha_id}: {exc}") from exc
    info = _info(alpha_id, body)
    # The vault holds the latest /check answer; BRAIN's body keeps the checks it simulated with.
    stored = (await state.alphas.by_ids([alpha_id])).get(alpha_id) or {}
    if resolved := checks_of(stored.get("checks")):
        info.checks = resolved
    if not info.code:
        raise refuse(422, "no_expression", f"{alpha_id} has no Fast Expression to work from.")
    return info


async def _field_lines(state: Any, fields: list[str], region: str | None) -> list[str]:
    if not fields:
        return []
    placeholders = ", ".join("?" for _ in fields)
    rows = await state.catalog.query(
        "SELECT field_id, any_value(description) AS description, "  # noqa: S608
        "any_value(field_type) AS field_type, any_value(category_name) AS category "
        f"FROM data_field WHERE field_id IN ({placeholders})"
        + (" AND region = ?" if region else "")
        + " GROUP BY field_id",
        [*fields, *([region] if region else [])],
    )
    known = {str(r["field_id"]): r for r in rows}
    return [
        f"- {f} ({known[f].get('field_type') or '?'}, {known[f].get('category') or '?'}): "
        f"{str(known[f].get('description') or '').strip()[:240]}"
        if f in known
        else f"- {f}: (not in the downloaded catalog)"
        for f in fields
    ]


def _stats_line(info: Any) -> str:
    s = info.in_sample
    if s is None:
        return "No in-sample statistics."
    parts = {
        "Sharpe": s.sharpe,
        "Fitness": s.fitness,
        "Turnover": s.turnover,
        "Returns": s.returns,
        "Drawdown": s.drawdown,
        "Margin": s.margin,
    }
    return ", ".join(f"{k} {v}" for k, v in parts.items() if v is not None)


def _json(text: str) -> Any:
    for candidate in (text, *re.findall(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError, TypeError:
            continue
    raise refuse(502, "unreadable_answer", "The model did not answer with the JSON asked for.")


async def _generate(state: Any, **kwargs: Any) -> Any:
    try:
        return await state.llm.generate(**kwargs)
    except LLMError as exc:
        raise refuse(503, "llm_failed", str(exc)) from exc


# --- describe -----------------------------------------------------------------

DESCRIBE_SYSTEM = f"""You fill in the properties of one WorldQuant BRAIN alpha.

Answer with JSON only: {{"name": ..., "category": ..., "tags": [...], "description": ...}}.
- name: at most 40 characters, plain words saying what the signal is.
- category: exactly one of {", ".join(CATEGORIES)}.
- tags: two to five short lowercase tags.
- description: three sections, each starting on its own line with its heading and a colon:
  {HEADINGS[0]}, {HEADINGS[1]}, {HEADINGS[2]}. At least 100 characters in total. Explain the
  economic idea, why each data field carries it, and what each operator does to it.
Say only what the expression and the field descriptions support. No hype, no claims about
future performance, no markdown."""


@router.post("/{alpha_id}/ai/describe")
async def describe(alpha_id: str, body: AssistRequest, state: State) -> Described:
    """Draft the Alpha's name, category, tags and description. Saves nothing."""
    info = await _alpha(state, alpha_id)
    region = info.settings.get("region")
    user = "\n".join(
        [
            f"Expression: {info.code}",
            f"Settings: {json.dumps(info.settings, sort_keys=True)}",
            f"In-sample: {_stats_line(info)}",
            "Data fields:",
            *await _field_lines(state, info.data_fields or [], region),
            f"Operators: {', '.join(info.operators or []) or 'none'}",
        ]
    )
    answer = await _generate(
        state, system=DESCRIBE_SYSTEM, user=user, model_id=body.model, temperature=0.4
    )
    data = _json(answer.text)
    if not isinstance(data, dict):
        raise refuse(502, "unreadable_answer", "The model did not answer with an object.")
    category = str(data.get("category") or "").upper()
    return Described(
        name=str(data.get("name") or "")[:60],
        category=category if category in CATEGORIES else "NONE",
        tags=[str(t).strip().lower() for t in data.get("tags") or [] if str(t).strip()][:5],
        description=str(data.get("description") or "").strip(),
        model=answer.model,
    )


# --- remodel ------------------------------------------------------------------

REMODEL_SYSTEM = """You improve one WorldQuant BRAIN alpha so that it passes the submission
checks it failed, keeping its idea.

Answer with JSON only: {"variants": [{"expression": ..., "decay": ..., "neutralization": ...,
"truncation": ..., "why": ...}]}.
- expression: a complete Fast Expression using only the operators listed and the data fields
  of the original (grouping fields such as sector or industry are allowed).
- decay (integer 0 to 60), neutralization (NONE, MARKET, SECTOR, INDUSTRY or SUBINDUSTRY) and
  truncation (0.01 to 0.10): the settings to simulate it with. Use null to keep the original.
- why: one sentence naming the failed check it targets and how.
Make the variants genuinely different from each other and from the original. Typical fixes:
low Sharpe or fitness, a cleaner or smoother signal (rank, zscore, ts_mean, decay); high
turnover, more smoothing (ts_decay_linear, ts_mean, higher decay); concentrated weight, rank
or truncation; low sub-universe Sharpe, group neutralization; self-correlation, a different
operator path. Always pass keyword arguments that the operator list says are required."""


def _schema(count: int) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "variants": {
                "type": "array",
                "minItems": count,
                "maxItems": count,
                "items": {
                    "type": "object",
                    "properties": {
                        "expression": {"type": "string"},
                        "decay": {"type": "integer", "nullable": True},
                        "neutralization": {"type": "string", "nullable": True},
                        "truncation": {"type": "number", "nullable": True},
                        "why": {"type": "string"},
                    },
                    "required": ["expression", "why"],
                },
            }
        },
        "required": ["variants"],
    }


def _check_line(check: dict[str, Any]) -> str:
    extra = [f"{k} {check[k]}" for k in ("value", "limit") if check.get(k) is not None]
    return f"- {check.get('name')}: {check.get('result')}" + (
        f" ({', '.join(extra)})" if extra else ""
    )


def _settings_for(info: Any, variant: dict[str, Any]) -> SimulationSettings:
    known = {f.alias or name for name, f in SimulationSettings.model_fields.items()}
    base = {k: v for k, v in info.settings.items() if k in known}
    decay = variant.get("decay")
    if isinstance(decay, int) and 0 <= decay <= 512:
        base["decay"] = decay
    neutralization = variant.get("neutralization")
    if isinstance(neutralization, str) and neutralization.upper() in NEUTRALIZATIONS:
        base["neutralization"] = neutralization.upper()
    truncation = variant.get("truncation")
    if isinstance(truncation, (int, float)) and 0 < truncation <= 1:
        base["truncation"] = float(truncation)
    return SimulationSettings.model_validate(base)


def _vet(text: str, table: dict[str, Any], names: set[str]) -> str:
    """The canonical expression, or a ValueError saying why BRAIN would refuse it."""
    try:
        tree = parse(text)
    except ParseError as exc:
        raise ValueError(f"Could not be read: {exc}") from exc
    if problems := validate(tree, table, names):
        raise ValueError(problems[0])
    for _, node in walk(tree):
        if node.kind == "call" and node.value in REQUIRED_KEYWORDS:
            given = {k.lower() for k, _ in node.kwargs}
            missing = [k for k in REQUIRED_KEYWORDS[node.value] if k.lower() not in given]
            if missing:
                raise ValueError(f"{node.value} needs {', '.join(missing)}, which BRAIN requires.")
    return render(tree)


@router.post("/{alpha_id}/ai/remodel")
async def remodel(alpha_id: str, body: RemodelRequest, state: State) -> Remodelled:
    """Ask a model for variants that address the failed checks, vet them, and queue them."""
    info = await _alpha(state, alpha_id)
    failing = [c for c in info.checks if c.get("result") in ("FAIL", "ERROR")]
    if not failing:
        raise refuse(409, "nothing_failed", f"{alpha_id} fails no check; there is nothing to fix.")
    operators = await state.metadata.cached_operators() or []
    if not operators:
        raise refuse(503, "no_operators", "Your BRAIN operators could not be read. Sign in again.")
    table = operator_table(operators)
    region = info.settings.get("region")
    fields = info.data_fields or []
    user = "\n".join(
        [
            f"Original expression: {info.code}",
            f"Settings: {json.dumps(info.settings, sort_keys=True)}",
            f"In-sample: {_stats_line(info)}",
            "Failed checks:",
            *(_check_line(c) for c in failing),
            "Data fields of the original:",
            *await _field_lines(state, fields, region),
            f"Write {body.count} variants.",
            "Operators available (name: definition | description):",
            operators_text(operators),
        ]
    )
    answer = await _generate(
        state,
        system=REMODEL_SYSTEM,
        user=user,
        model_id=body.model,
        response_schema=_schema(body.count),
        temperature=0.9,
    )
    data = _json(answer.text)
    raw = data.get("variants") if isinstance(data, dict) else data
    candidates = [v for v in raw or [] if isinstance(v, dict) and v.get("expression")]

    names: set[str] = {*fields, *GROUPING}
    original = render(parse(info.code)) if info.code else ""
    accepted: list[tuple[dict[str, Any], str, SimulationSettings]] = []
    rejected: list[Rejection] = []
    seen: set[tuple[str, str]] = set()
    for variant in candidates[: body.count]:
        text = str(variant["expression"]).strip()
        try:
            expression = _vet(text, table, names)
            settings = _settings_for(info, variant)
        except ValueError as exc:
            rejected.append(Rejection(expression=text, reason=str(exc)))
            continue
        key = (expression, settings.model_dump_json(by_alias=True))
        same_settings = settings.model_dump(by_alias=True, exclude_none=True) == _settings_for(
            info, {}
        ).model_dump(by_alias=True, exclude_none=True)
        if key in seen or (expression == original and same_settings):
            rejected.append(
                Rejection(expression=text, reason="The same as the original or another variant.")
            )
            continue
        seen.add(key)
        accepted.append((variant, expression, settings))

    queued: list[Variant] = []
    if accepted:
        result = await state.engine.enqueue(
            [SimulationRequest(settings=s, regular=e) for _, e, s in accepted],
            task=_task(alpha_id),
            skip_duplicates=True,
        )
        outcomes = result.get("outcomes", [])
        notes: dict[str, Any] = {}
        for index, (variant, expression, settings) in enumerate(accepted):
            outcome = outcomes[index] if index < len(outcomes) else {}
            why = str(variant.get("why") or "")[:300]
            queued.append(
                Variant(
                    expression=expression,
                    decay=settings.decay,
                    neutralization=settings.neutralization,
                    truncation=settings.truncation,
                    why=why,
                    record_id=outcome.get("recordId"),
                    status=str(outcome.get("status") or SimStatus.QUEUED),
                    alpha_id=outcome.get("alphaId"),
                )
            )
            if outcome.get("recordId") is not None:
                notes[str(outcome["recordId"])] = {"why": why, "model": answer.model}
        await _remember(state, alpha_id, notes)
    log.info(
        "assist.remodel",
        alpha_id=alpha_id,
        model=answer.model,
        queued=len(queued),
        rejected=len(rejected),
    )
    return Remodelled(
        task=_task(alpha_id),
        model=answer.model,
        failed=[str(c.get("name")) for c in failing],
        queued=queued,
        rejected=rejected,
    )


async def _remember(state: Any, alpha_id: str, notes: dict[str, Any]) -> None:
    """Keep each variant's reason, which the simulation row has no place for."""
    if not notes:
        return
    async with state.db.session() as session:
        row = await session.get(BrainCache, _notes_key(alpha_id))
        if row is None:
            session.add(BrainCache(key=_notes_key(alpha_id), body=notes))
        else:
            row.body = {**(row.body or {}), **notes}


@router.get("/{alpha_id}/ai/remodels")
async def remodels(alpha_id: str, state: State) -> list[RemodelRow]:
    """Every variant remodelled from this Alpha, newest first, with its latest results."""
    async with state.db.session() as session:
        rows = list(
            await session.scalars(
                select(SimulationRecord)
                .where(
                    SimulationRecord.task == _task(alpha_id),
                    SimulationRecord.is_batch.is_(False),
                )
                .order_by(SimulationRecord.id.desc())
                .limit(40)
            )
        )
        notes_row = await session.get(BrainCache, _notes_key(alpha_id))
    notes: dict[str, Any] = (notes_row.body if notes_row else None) or {}
    stored = await state.alphas.by_ids([r.alpha_id for r in rows if r.alpha_id])

    out: list[RemodelRow] = []
    for r in rows:
        alpha = stored.get(r.alpha_id or "") or {}
        checks = checks_of(alpha.get("checks"))
        settings = (r.payload or {}).get("settings") or {}
        out.append(
            RemodelRow(
                record_id=r.id,
                expression=r.expression,
                decay=settings.get("decay"),
                neutralization=settings.get("neutralization"),
                why=(notes.get(str(r.id)) or {}).get("why"),
                status=str(r.status),
                message=r.message,
                alpha_id=r.alpha_id,
                sharpe=alpha.get("sharpe"),
                fitness=alpha.get("fitness"),
                turnover=alpha.get("turnover"),
                passed=[str(c.get("name")) for c in checks if c.get("result") == "PASS"],
                failed=[str(c.get("name")) for c in checks if c.get("result") in ("FAIL", "ERROR")],
                pending=[str(c.get("name")) for c in checks if c.get("result") == "PENDING"],
                created_at=r.created_at.isoformat() if r.created_at else None,
            )
        )
    return out
