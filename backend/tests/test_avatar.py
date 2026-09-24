"""The profile picture: which BRAIN profile fields count, and what is refused.

No network: BRAIN is a stub. Run: ``uv run python tests/test_avatar.py``.
"""

import asyncio
from types import SimpleNamespace
from typing import Any

import httpx

from alpha_harness.account import AVATAR_MAX_BYTES, AuthService, avatar_url
from alpha_harness.brain.auth import SessionInfo

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def test_avatar_url() -> None:
    assert avatar_url({"avatarUrl": "https://cdn.example/a.png"}) == "https://cdn.example/a.png"
    assert avatar_url({"profileImage": {"url": "https://x/p.jpg"}}) == "https://x/p.jpg"
    assert avatar_url({"photo": "http://insecure/p.png"}) is None
    assert avatar_url({"firstName": "https://not-a-picture"}) is None
    assert avatar_url({}) is None


class _Stub:
    """BRAIN's profile and one image response, counting the fetches."""

    def __init__(self, profile: dict[str, Any], media: str = "image/png", body: Any = PNG) -> None:
        self.profile, self.media, self.body, self.fetches = profile, media, body, 0
        self.client = self

    async def get_user(self, _user_id: str) -> dict[str, Any]:
        return self.profile

    async def request(self, _method: str, _url: str, **kw: Any) -> Any:
        self.fetches += 1
        # BRAIN answers 406 to an Accept header naming an image type.
        accept = (kw.get("headers") or {}).get("Accept", "")
        assert "image" not in accept, f"asked BRAIN for {accept!r}, which it refuses"
        if isinstance(self.body, Exception):
            raise self.body
        headers = httpx.Headers({"content-type": self.media})
        return SimpleNamespace(status=200, headers=headers, body=self.body)


def _service(stub: _Stub) -> AuthService:
    service = AuthService(None, None, stub, metadata=None)  # type: ignore[arg-type]
    service._session = SessionInfo(authenticated=True, user_id="U1")
    return service


async def _avatar(stub: _Stub) -> tuple[bytes, str] | None:
    service = _service(stub)
    first = await service.get_avatar()
    again = await service.get_avatar()
    assert first == again
    assert stub.fetches <= 1, "fetched more than once per session"
    return first


def test_png_is_served_once() -> None:
    stub = _Stub({"avatar": "https://api.worldquantbrain.com/u/U1.png"})
    assert asyncio.run(_avatar(stub)) == (PNG, "image/png")


def test_refused() -> None:
    url = {"avatar": "https://x/a"}
    # An SVG opened on its own would run its scripts in the app's origin.
    assert asyncio.run(_avatar(_Stub(url, media="image/svg+xml"))) is None
    assert asyncio.run(_avatar(_Stub(url, media="text/html"))) is None
    assert asyncio.run(_avatar(_Stub(url, body=b"x" * (AVATAR_MAX_BYTES + 1)))) is None
    assert asyncio.run(_avatar(_Stub(url, body=ConnectionError("down")))) is None
    no_picture = _Stub({"firstName": "Simon"})
    assert asyncio.run(_avatar(no_picture)) is None
    assert no_picture.fetches == 0


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_") and callable(test):
            test()
            print("ok", name)
