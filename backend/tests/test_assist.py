"""What the AI remodel lets through to a simulation, and with which settings.

Run: ``uv run python tests/test_assist.py``.
"""

from types import SimpleNamespace

from alpha_harness.api.assist import _settings_for, _vet
from alpha_harness.labs.fastexpr import GROUPING, operator_table

OPERATORS = [
    {"name": "rank", "category": "Cross Sectional", "definition": "rank(x, rate=2)"},
    {"name": "ts_mean", "category": "Time Series", "definition": "ts_mean(x, d)"},
    {
        "name": "truncate",
        "category": "Cross Sectional",
        "definition": "truncate(x,maxPercent=0.01)",
    },
    {"name": "group_neutralize", "category": "Group", "definition": "group_neutralize(x, group)"},
]
TABLE = operator_table(OPERATORS)
NAMES = {"close", *GROUPING}


def _refused(text: str) -> str:
    try:
        _vet(text, TABLE, NAMES)
    except ValueError as exc:
        return str(exc)
    raise AssertionError(f"accepted {text!r}")


def test_accepts_a_valid_variant() -> None:
    assert _vet("group_neutralize(rank(ts_mean(close, 5)), sector)", TABLE, NAMES)


def test_refuses_what_brain_would() -> None:
    assert "not an operator" in _refused("made_up_op(close)")
    # Only the original's fields: a model may not wander to data it was not given.
    assert _refused("rank(volume)")
    assert "maxPercent" in _refused("truncate(rank(close))")
    assert "Could not be read" in _refused("rank(close")
    assert _vet("truncate(rank(close), maxPercent=0.05)", TABLE, NAMES)


def test_settings_keep_the_original_and_clamp_changes() -> None:
    info = SimpleNamespace(
        settings={
            "instrumentType": "EQUITY",
            "region": "USA",
            "universe": "TOP3000",
            "delay": 1,
            "decay": 4,
            "neutralization": "INDUSTRY",
            "truncation": 0.08,
            "startDate": "2014-01-01",  # not a simulation setting: must not be sent
        }
    )
    kept = _settings_for(info, {})
    assert (kept.region, kept.decay, kept.neutralization) == ("USA", 4, "INDUSTRY")
    assert "startDate" not in kept.model_dump(by_alias=True)
    changed = _settings_for(info, {"decay": 10, "neutralization": "sector", "truncation": 0.05})
    assert (changed.decay, changed.neutralization, changed.truncation) == (10, "SECTOR", 0.05)
    ignored = _settings_for(info, {"decay": -3, "neutralization": "COUNTRY", "truncation": 5})
    assert (ignored.decay, ignored.neutralization, ignored.truncation) == (4, "INDUSTRY", 0.08)


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test()
            print("ok", name)
