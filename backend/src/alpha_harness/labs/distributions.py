"""A trial's Optuna distributions, with the large ones stored once in ``distribution_blob``.

``Trial.distributions`` maps a parameter name to ``distribution_to_json`` text. A value at
least :data:`INLINE_LIMIT` long is written as ``"blob:<sha256>"`` instead, and its text is
kept in one ``distribution_blob`` row however many trials share it. Rows written before
this change still hold their text inline; :func:`expand` reads both forms.
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from ..db.models import DistributionBlob

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

REF = "blob:"
#: Small distributions (a window length, a neutralization) stay inline: a lookup would cost
#: more than the bytes it saves.
INLINE_LIMIT = 1024


def digest(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


async def compact(session: Any, raws: list[dict[str, str]]) -> list[dict[str, str]]:
    """Each of ``raws`` with its large values swapped for references, storing new bodies.

    ``INSERT ... ON CONFLICT DO NOTHING``: trials in a batch share their blobs, and two
    studies over the same universe can write the same one at once.
    """
    large = {
        digest(body): body for raw in raws for body in raw.values() if len(body) >= INLINE_LIMIT
    }
    if large:
        await session.execute(
            insert(DistributionBlob)
            .values([{"digest": key, "body": body} for key, body in large.items()])
            .on_conflict_do_nothing(index_elements=["digest"])
        )
    return [
        {
            name: body if len(body) < INLINE_LIMIT else REF + digest(body)
            for name, body in raw.items()
        }
        for raw in raws
    ]


async def bodies(session: Any, raws: Iterable[Mapping[str, Any] | None]) -> dict[str, str]:
    """Every blob the given ``distributions`` columns refer to, by digest, in one query."""
    wanted = {
        value.removeprefix(REF)
        for raw in raws
        for value in (raw or {}).values()
        if isinstance(value, str) and value.startswith(REF)
    }
    if not wanted:
        return {}
    rows = await session.execute(
        select(DistributionBlob.digest, DistributionBlob.body).where(
            DistributionBlob.digest.in_(wanted)
        )
    )
    return dict(rows.tuples().all())


def expand(raw: Mapping[str, Any] | None, found: Mapping[str, str]) -> dict[str, Any]:
    """``raw`` with references replaced by their text; one that is missing is dropped.

    Dropping costs the sampler that parameter of one replayed point, which is what an
    unreadable row already costs; raising would fail the whole task.
    """
    out: dict[str, Any] = {}
    for name, value in (raw or {}).items():
        if isinstance(value, str) and value.startswith(REF):
            body = found.get(value.removeprefix(REF))
            if body is not None:
                out[name] = body
        else:
            out[name] = value
    return out
