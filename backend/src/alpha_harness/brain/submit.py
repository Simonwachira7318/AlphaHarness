"""Submitting an Alpha on BRAIN — the one irreversible call this application makes.

Kept out of :class:`~alpha_harness.brain.endpoints.BrainEndpoints` on purpose: that class has
no ``submit`` so that no lab, task or tool can reach it by mistake. The only caller is the
Super Lab's submit route, which a person presses one Alpha at a time and must confirm.

The protocol: ``POST /alphas/{id}/submit`` starts the job and answers with ``Retry-After``;
``GET`` on the same path is polled until the header is gone. A final ``200`` is a submission,
anything else is a refusal whose body lists the checks that failed.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import structlog

from .client import MIN_POLL_DELAY

if TYPE_CHECKING:
    from .client import BrainClient, BrainResponse

log = structlog.get_logger(__name__)

#: BRAIN re-runs self and production correlation before accepting; that can take minutes.
SUBMIT_TIMEOUT = 15 * 60.0


@dataclass(slots=True)
class SubmitOutcome:
    submitted: bool
    status: int
    message: str
    #: The checks BRAIN failed the Alpha on, when it said which.
    failed: list[str] = field(default_factory=list)


def _failed_checks(body: Any) -> list[str]:
    checks = ((body or {}).get("is") or {}).get("checks") if isinstance(body, dict) else None
    return [str(c.get("name")) for c in checks or [] if c.get("result") == "FAIL"]


def _message(body: Any) -> str:
    if isinstance(body, dict):
        for key in ("detail", "message"):
            if isinstance(body.get(key), str):
                return body[key]
    return body if isinstance(body, str) and body.strip() else ""


async def submit_alpha(client: BrainClient, alpha_id: str) -> SubmitOutcome:
    """Submit one Alpha and wait for BRAIN's verdict."""
    path = f"/alphas/{alpha_id}/submit"
    log.info("brain.submit.start", alpha_id=alpha_id)
    response: BrainResponse = await client.request("POST", path, raise_for_status=False)
    deadline = time.monotonic() + SUBMIT_TIMEOUT
    while response.pending:
        if time.monotonic() > deadline:
            return SubmitOutcome(
                False,
                response.status,
                "BRAIN was still checking after 15 minutes. It may yet finish on the platform; "
                "look at the Alpha there before submitting it again.",
            )
        await asyncio.sleep(max(response.retry_after or 0.0, MIN_POLL_DELAY))
        response = await client.request("GET", path, raise_for_status=False)

    if response.status == 200:
        log.info("brain.submit.accepted", alpha_id=alpha_id)
        return SubmitOutcome(True, 200, "Submitted.")

    failed = _failed_checks(response.body)
    reason = _message(response.body)
    if failed:
        reason = f"BRAIN refused it on {', '.join(failed)}."
    log.warning("brain.submit.refused", alpha_id=alpha_id, status=response.status, failed=failed)
    return SubmitOutcome(
        False,
        response.status,
        reason or f"BRAIN refused the submission ({response.status}).",
        failed,
    )
