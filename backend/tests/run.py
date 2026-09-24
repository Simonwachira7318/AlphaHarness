"""Run every ``test_*`` function in ``tests/``, each file in its own process.

Separate processes because ``test_storage`` points settings at a throwaway data directory
before importing the app, and a shared process would have imported it already.
Run: ``uv run python tests/run.py``.
"""

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent

failed = [
    path.name
    for path in sorted(HERE.glob("test_*.py"))
    # Our own interpreter on our own files.
    if subprocess.run([sys.executable, str(path)], check=False).returncode != 0  # noqa: S603
]
if failed:
    sys.exit(f"FAILED: {', '.join(failed)}")
print("all tests passed")
