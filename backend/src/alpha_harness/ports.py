"""Refusing to start on a port something already listens on.

On Windows a new listening socket can share a port another process already holds, and each
request then goes to whichever socket Windows picks: a second backend on the same port
quietly answers for the first. Looking for a listener before binding turns that into a
clear refusal.
"""

from __future__ import annotations

import socket
import sys


def listening(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((host, port)) == 0


def ensure_free(host: str, port: int) -> None:
    """Exit with a message, rather than start, when ``port`` already answers."""
    if listening(host, port):
        sys.exit(
            f"Port {port} is already in use, possibly by another Alpha Harness backend. "
            "Stop whatever holds it, or set AH_PORT in .env to a free port."
        )
