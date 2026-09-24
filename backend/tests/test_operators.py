"""Generated expressions never call an operator without the keywords BRAIN insists on.

``truncate(x)`` and ``ts_delta_limit(x, 5)`` were rejected by BRAIN, and each rejection
cancelled the rest of its batch of ten. Run: ``uv run python tests/test_operators.py``.
"""

from alpha_harness.labs import ga, power_pool, search, template
from alpha_harness.labs.fastexpr import REQUIRED_KEYWORDS, operator_table, with_required

# As BRAIN publishes them.
OPERATORS = [
    {"name": "rank", "category": "Cross Sectional", "definition": "rank(x, rate=2)"},
    {"name": "winsorize", "category": "Cross Sectional", "definition": "winsorize(x, std=4)"},
    {
        "name": "truncate",
        "category": "Cross Sectional",
        "definition": "truncate(x,maxPercent=0.01)",
    },
    {"name": "ts_rank", "category": "Time Series", "definition": "ts_rank(x, d, constant = 0)"},
    {"name": "ts_mean", "category": "Time Series", "definition": "ts_mean(x, d)"},
    {
        "name": "ts_delta_limit",
        "category": "Time Series",
        "definition": "ts_delta_limit(x, y, limit_volume=0.1)",
    },
    {"name": "group_rank", "category": "Group", "definition": "group_rank(x, group)"},
]
REFUSED = set(REQUIRED_KEYWORDS)


def test_table_still_knows_them() -> None:
    # Validation reads the table: a hand-written truncate(x, maxPercent=0.05) stays valid.
    assert set(operator_table(OPERATORS)) >= REFUSED


def test_search_never_picks_them() -> None:
    cat = search.catalogue(OPERATORS)
    picked = set(cat.cs) | set(cat.ts) | set(cat.group)
    assert not picked & REFUSED, picked & REFUSED
    assert {"rank", "winsorize", "ts_rank", "ts_mean", "group_rank"} <= picked


def test_evolution_never_swaps_them_in() -> None:
    market = ga.build_market(OPERATORS, [], ["MARKET"])
    swappable = {info.name for infos in market.swappable.values() for info in infos}
    assert not swappable & REFUSED, swappable & REFUSED


def test_template_writes_the_keyword() -> None:
    doc = {"version": template.VERSION, "root": template._op("truncate", template._data("close"))}
    assert template.render(doc, {}) == "truncate(close, maxPercent=0.01)"


def test_template_keeps_a_chosen_value() -> None:
    root = template._op("truncate", template._data("close"), maxPercent=0.05)
    doc = {"version": template.VERSION, "root": root}
    assert template.render(doc, {}) == "truncate(close, maxPercent=0.05)"


def test_with_required() -> None:
    assert with_required("truncate", {}) == {"maxPercent": 0.01}
    # BRAIN's error spells it "maxpercent": a value given in any case counts.
    assert with_required("truncate", {"maxpercent": 0.2}) == {"maxpercent": 0.2}
    assert with_required("rank", {}) == {}


def test_llm_is_told() -> None:
    text = power_pool.operators_text(OPERATORS)
    assert "always pass maxPercent" in text
    assert "always pass limit_volume" in text


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test()
            print("ok", name)
