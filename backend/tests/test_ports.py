"""The backend refuses a port something already listens on.

Run: ``uv run python tests/test_ports.py``.
"""

import socket

from alpha_harness.ports import ensure_free, listening


def test_refuses_a_taken_port() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        port = holder.getsockname()[1]
        assert listening("127.0.0.1", port)
        try:
            ensure_free("127.0.0.1", port)
        except SystemExit as exc:
            assert f"Port {port}" in str(exc.code)
        else:
            raise AssertionError("started on a taken port")
    assert not listening("127.0.0.1", port)
    ensure_free("127.0.0.1", port)


if __name__ == "__main__":
    test_refuses_a_taken_port()
    print("ok test_refuses_a_taken_port")
