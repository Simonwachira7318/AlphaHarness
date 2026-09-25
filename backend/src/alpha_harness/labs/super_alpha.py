"""Super Lab: SuperAlphas built from random selection expressions, ported from ``SUPER.ipynb``.

A SuperAlpha is a ``selection`` (which of your own Alphas to hold) and a ``combo`` (how to
weight them). The notebook's workflow, step for step:

1. Write selection expressions from the account's ``SELECTION``-scope operators and the
   selection fields BRAIN documents (:class:`SelectionGenerator`, the notebook's
   ``MasterSelectionSystem``), each wrapped in ``oWn * (…)``.
2. Ask ``/simulations/super-selection`` how many Alphas each one picks — free — and keep those
   that pick enough.
3. Simulate one SuperAlpha per kept selection and chosen combo (a task in Tasks).
4. Re-run the submission checks; the ones that pass are named, coloured and tagged.
5. Submit, one at a time, by hand.

The notebook's login, licence server and encrypted helper library are not carried over: the
harness's own session signs every request, and everything else is plain code in this file.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar

from ..brain.errors import BrainError
from ..brain.schemas import SimulationRequest, SimulationSettings, SimulationType
from ..db.models import Trial, TrialState
from ..tools.settings_sampler import PENDING_SEND

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

#: The notebook's own wrapper: ``oWn`` limits a selection to your own Alphas, and ``#`` starts
#: a comment BRAIN ignores.
DEFAULT_WRAPPER = "oWn * ({expr})#GoodStuff"

#: The combo expressions from the notebook, the first of them its default.
COMBOS: tuple[str, ...] = (
    'combo_a(alpha,nlength=64,mode="algo2")',
    "stats=generate_stats(alpha);innerCorr=self_corr(stats.hold_pnl,700);"
    "ic=if_else(innerCorr==1.0,nan,innerCorr);maxCorr=reduce_max(ic);1-maxCorr",
    "generate_stats(alpha);ts_ir(stats.returns,120)/reduce_powersum(self_corr(stats.returns,120),2)",
    "generate_stats(alpha);1-rank(reduce_powersum(self_corr(stats.returns,250),3))",
    "generate_stats(alpha);scale_down(1-reduce_norm(self_corr(stats.drawdown,240)))",
    "generate_stats(alpha);1/ts_std_dev(stats.returns,120)",
    "generate_stats(alpha);1-reduce_max(if_else(self_corr(stats.returns,500)==1,nan,"
    "self_corr(stats.returns,500)))",
    "generate_stats(alpha);1+ts_min_max_cps(ts_co_skewness(stats.returns,stats.drawdown,20),250)",
    "generate_stats(alpha);reverse(ts_max_diff(ts_kurtosis(stats.drawdown,240),120))",
)

SELECTION_HANDLINGS = ("POSITIVE", "NON_ZERO", "NON_NAN")

#: The kinds of expression the generator writes, in the notebook's order.
MODES = ("arithmetic", "if_else", "filter", "compound")

#: Properties the notebook sets on an Alpha that passes every check.
PASSED_COLOR = "GREEN"
PASSED_TAGS = ("super",)

COMPARATORS = {
    "equal": "==",
    "not_equal": "!=",
    "less": "<",
    "greater": ">",
    "less_equal": "<=",
    "greater_equal": ">=",
}

#: Selections BRAIN is asked about at once; each answer is cheap but rate-limited.
COUNT_CONCURRENCY = 3


@dataclass(slots=True)
class SelectionScope:
    """What the generator draws from, as the notebook gathered it for one market."""

    operators: frozenset[str]
    universes: list[str]
    neutralizations: list[str]
    datasets: list[str]
    categories: list[str]
    tags: list[str] = field(default_factory=lambda: ["ace_tag", "api", "good", "_Toothless"])


class SelectionGenerator:
    """The notebook's ``MasterSelectionSystem``, unchanged in what it writes.

    Takes its own ``random.Random`` so a preview can be reproduced from a seed.
    """

    FIELDS: ClassVar[dict[str, list[str]]] = {
        "VOLUME": ["long_count", "short_count"],
        "SCALE": ["decay", "dataset_count", "operator_count", "datafield_count"],
        "FLOAT": ["turnover", "truncation", "self_correlation", "prod_correlation"],
    }

    def __init__(self, scope: SelectionScope, rng: random.Random | None = None) -> None:
        self.rng = rng or random.Random()
        self.allowed = scope.operators
        self.settings: dict[str, list[str]] = {
            "category": ["NONE", "PRICE_REVERSION", "PRICE_MOMENTUM", "FUNDAMENTAL", "ANALYST"],
            "universe": scope.universes or ["TOP3000"],
            "neutralization": scope.neutralizations or ["NONE"],
            "color": ["RED", "YELLOW", "GREEN", "BLUE", "PURPLE"],
        }
        self.data_lists = {
            name: values
            for name, values in (
                ("datacategories", scope.categories),
                ("datasets", scope.datasets),
                ("tags", scope.tags),
            )
            if values
        }
        self.unary = [
            op
            for op in ("log", "abs", "sqrt", "sign", "inverse", "s_log_1p", "reverse")
            if op in self.allowed
        ]
        self.binary = [
            op
            for op in (
                "add",
                "divide",
                "max",
                "min",
                "multiply",
                "subtract",
                "power",
                "signed_power",
            )
            if op in self.allowed
        ]
        self.comparators = [v for k, v in COMPARATORS.items() if k in self.allowed] or [
            "==",
            ">",
            "<",
        ]

    # -- pieces --------------------------------------------------------------

    def _operand(self, group: str) -> str:
        """A field, or a field wrapped in a unary operator."""
        if group == "SCALE" and self.rng.random() < 0.3:
            scale_ops = [o for o in ("log", "sqrt", "s_log_1p") if o in self.unary]
            if scale_ops:
                return f"{self.rng.choice(scale_ops)}({self.rng.choice(self.FIELDS['VOLUME'])})"
        name = self.rng.choice(self.FIELDS[group])
        if self.unary and self.rng.random() < 0.3:
            return f"{self.rng.choice(self.unary)}({name})"
        return name

    def _single_filter(self) -> str:
        """One condition, such as ``decay < 5`` or ``in(datasets, "pv1")``."""
        choice = self.rng.choice(["NUMERIC", "LIST", "SETTING"])
        if choice == "LIST" and ("in" not in self.allowed or not self.data_lists):
            choice = "NUMERIC"
        if choice == "NUMERIC":
            group = self.rng.choice(list(self.FIELDS))
            name = self.rng.choice(self.FIELDS[group])
            op = self.rng.choice(self.comparators)
            value: object = {
                "VOLUME": self.rng.randrange(100, 2001, 100),
                "SCALE": self.rng.randint(1, 10),
                "FLOAT": round(self.rng.uniform(0.3, 0.8), 2),
            }[group]
            return f"{name} {op} {value}"
        if choice == "LIST":
            prop = self.rng.choice(list(self.data_lists))
            value = self.rng.choice(self.data_lists[prop])
            if "not" in self.allowed and self.rng.random() < 0.3:
                return f'not(in({prop}, "{value}"))'
            return f'in({prop}, "{value}")'
        prop = self.rng.choice(list(self.settings))
        return f'{prop} == "{self.rng.choice(self.settings[prop])}"'

    # -- the four kinds --------------------------------------------------------

    def arithmetic(self) -> str:
        """``add(log(long_count), short_count)``."""
        group = self.rng.choice(list(self.FIELDS))
        if not self.binary:
            return self._operand(group)
        op = self.rng.choice(self.binary)
        if op in ("power", "signed_power"):
            return f"{op}({self._operand(group)}, {self.rng.choice([2, 0.5])})"
        return f"{op}({self._operand(group)}, {self._operand(group)})"

    def if_else(self) -> str:
        group = self.rng.choice(list(self.FIELDS))
        return f"if_else({self._single_filter()}, {self._operand(group)}, {self._operand(group)})"

    def filter(self) -> str:
        return self._single_filter()

    def compound(self) -> str:
        """Two conditions joined by ``&&``, as the notebook's semicolon batch writes them."""
        first = self._single_filter()
        second = self._single_filter()
        for _ in range(20):
            if second != first:
                break
            second = self._single_filter()
        return f"{first}&&{second}"

    def batch(self, mode: str, count: int) -> list[str]:
        """Up to ``count`` distinct expressions of one kind."""
        make: Callable[[], str] = getattr(self, mode)
        found: dict[str, None] = {}
        # Bounded: a tiny operator set cannot always yield ``count`` distinct expressions.
        for _ in range(count * 50):
            if len(found) >= count:
                break
            found[make()] = None
        return list(found)


def generate(
    scope: SelectionScope,
    *,
    per_mode: int,
    modes: Sequence[str] = MODES,
    wrapper: str = DEFAULT_WRAPPER,
    seed: int | None = None,
) -> list[dict[str, str]]:
    """Selection expressions, ``per_mode`` of each kind, wrapped and without repeats."""
    generator = SelectionGenerator(scope, random.Random(seed))
    out: dict[str, str] = {}
    for mode in modes:
        for raw in generator.batch(mode, per_mode):
            out.setdefault(wrap(raw, wrapper), mode)
    return [{"expression": expr, "kind": kind} for expr, kind in out.items()]


def wrap(expression: str, wrapper: str) -> str:
    return wrapper.replace("{expr}", expression) if "{expr}" in wrapper else expression


# -- asking BRAIN ---------------------------------------------------------------------


def selection_params(
    selection: str, *, region: str, delay: int, selection_limit: int, selection_handling: str
) -> dict[str, Any]:
    """The query ``/simulations/super-selection`` takes, as the notebook builds it."""
    return {
        "settings.instrumentType": "EQUITY",
        "settings.region": region,
        "settings.delay": delay,
        "selection": selection,
        "limit": 10,
        "selectionLimit": selection_limit,
        "selectionHandling": selection_handling,
    }


async def count_selections(
    endpoints: Any,
    selections: Sequence[str],
    *,
    region: str,
    delay: int,
    selection_limit: int,
    selection_handling: str,
) -> list[dict[str, Any]]:
    """How many Alphas each selection picks. Simulates nothing and spends no quota."""
    gate = asyncio.Semaphore(COUNT_CONCURRENCY)

    async def one(selection: str) -> dict[str, Any]:
        params = selection_params(
            selection,
            region=region,
            delay=delay,
            selection_limit=selection_limit,
            selection_handling=selection_handling,
        )
        async with gate:
            try:
                body = await endpoints.super_selection(params)
            except BrainError as exc:
                return {"selection": selection, "count": None, "message": exc.message}
        count = body.get("count")
        message = body.get("message") or body.get("detail") or ""
        return {
            "selection": selection,
            "count": int(count) if isinstance(count, int | float) else None,
            "message": str(message),
        }

    return list(await asyncio.gather(*(one(s) for s in selections)))


# -- the task -------------------------------------------------------------------------


def requests_for(
    selections: Sequence[str], combos: Sequence[str], settings: SimulationSettings
) -> list[SimulationRequest]:
    """One SuperAlpha per selection and combo, selections outermost as in the notebook."""
    return [
        SimulationRequest(
            type=SimulationType.SUPER, settings=settings, selection=selection, combo=combo
        )
        for selection in selections
        for combo in combos
    ]


def seed_trials(requests: Sequence[SimulationRequest]) -> Callable[[int], list[Trial]]:
    """Parked trials, one per SuperAlpha, drained by the fixed-list scheduler path.

    The selection is the trial's expression, which is what differs between them on the task
    card; the combo rides in ``params`` for :func:`~..tools.settings_sampler.request_of`.
    """

    def build(study_id: int) -> list[Trial]:
        return [
            Trial(
                study_id=study_id,
                number=number,
                params={"type": str(SimulationType.SUPER), "combo": request.combo},
                distributions={},
                expression=request.selection,
                settings=request.settings.model_dump(by_alias=True, exclude_none=True),
                state=TrialState.PRUNED,
                message=PENDING_SEND,
            )
            for number, request in enumerate(requests)
        ]

    return build


def descriptions(selection: str, combo: str, *, limit: int, handling: str) -> dict[str, Any]:
    """The selection and combo descriptions BRAIN asks a SuperAlpha to carry before submission."""
    return {
        "selection": {
            "description": (
                "Selection expression: "
                f"{selection}\n"
                "It keeps only the account's own Alphas (oWn) that satisfy the condition above, "
                f"holding at most {limit} of them with {handling} selection handling, so the "
                "SuperAlpha combines Alphas that share the chosen property."
            )
        },
        "combo": {
            "description": (
                f"Combo expression: {combo}\n"
                "It weights each selected Alpha by the rule above, computed from each Alpha's own "
                "history, so Alphas that add the most independent return carry the most weight."
            )
        },
    }
