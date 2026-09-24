"""``python -m alpha_harness.dev``: the backend with auto-reload, on the port ``.env`` names.

The UI comes from Vite (``pnpm dev``), which proxies to the same ``AH_PORT``.
"""

from __future__ import annotations

import uvicorn

from .config import get_settings
from .ports import ensure_free

HOST = "127.0.0.1"


def main() -> None:
    port = get_settings().port
    ensure_free(HOST, port)
    uvicorn.run("alpha_harness.main:app", host=HOST, port=port, reload=True)


if __name__ == "__main__":
    main()
