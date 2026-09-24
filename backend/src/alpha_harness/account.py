"""The BRAIN account: its stored credential, its session, and what the platform allows it.

The account's operators and settings schema are cached here too, because both depend on
the account's permissions.

The session cookie jar is persisted deliberately: signing in costs a proof-of-work solve
and counts against a lockout budget, so a backend restart must not trigger a new one.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

import structlog
from sqlalchemy import select

from .brain.auth import Authenticator, SessionInfo
from .brain.endpoints import SIMULATION_TYPES
from .brain.errors import BrainError
from .db.models import BrainSessionRow, Credential, MetadataCache, utcnow
from .sealing import SealError

if TYPE_CHECKING:
    from .brain.endpoints import BrainEndpoints
    from .db.sqlite import Database
    from .sealing import Sealer

log = structlog.get_logger(__name__)

PASSWORD_CONTEXT = "brain-password"  # noqa: S105 - sealing label, not a secret
COOKIE_CONTEXT = "brain-cookies"


class NoCredentialError(RuntimeError):
    """No BRAIN credential has been stored and none was supplied."""


class AuthService:
    """The app's view of "are we signed in to BRAIN?"."""

    def __init__(
        self,
        db: Database,
        sealer: Sealer,
        endpoints: BrainEndpoints,
        *,
        metadata: PlatformMetadata,
        authenticator: Authenticator | None = None,
    ) -> None:
        self.db = db
        self.sealer = sealer
        self.endpoints = endpoints
        self.metadata = metadata
        self.auth = authenticator or Authenticator(endpoints)
        self._session = SessionInfo.anonymous()
        self._user_profile: dict[str, Any] | None = None
        #: The profile picture as (bytes, media type); ``False`` once looked for and not found.
        self._avatar: tuple[bytes, str] | Literal[False] | None = None
        #: The login BRAIN paused for an identity check, held in memory only until the check
        #: passes; then it is stored like any accepted login.
        self._awaiting_check: tuple[str, str] | None = None
        #: One session change at a time: a UI sign-in, a silent re-login and a status
        #: refresh would otherwise overwrite each other, leaving the loser's credential current.
        self._lock = asyncio.Lock()

    @property
    def session(self) -> SessionInfo:
        """Last known session state. Cheap; does not hit the network."""
        return self._session

    async def get_user_profile(self) -> dict[str, Any]:
        """Cached user profile from BRAIN /users/{userId}."""
        if not self._session.authenticated or not self._session.user_id:
            return {}
        if self._user_profile is not None:
            return self._user_profile
        try:
            profile = await self.endpoints.get_user(self._session.user_id)
            if profile:
                self._user_profile = profile
                first = str(profile.get("firstName") or "").strip()
                last = str(profile.get("lastName") or "").strip()
                full_name = profile.get("fullName") or (f"{first} {last}".strip() or None)
                if full_name:
                    self._session.full_name = full_name
            return profile
        # The profile is decoration; signing in must not fail over it.
        except Exception as exc:  # noqa: BLE001
            log.warning("brain.user_profile.failed", error=str(exc))
            return {}

    async def get_avatar(self) -> tuple[bytes, str] | None:
        """The profile picture BRAIN lists for this account, fetched once per session.

        Fetched here rather than by the browser, because an image BRAIN serves behind sign-in
        needs the session cookies, which never leave the backend.
        """
        if self._avatar is not None:
            return self._avatar or None
        url = avatar_url(await self.get_user_profile())
        if url is None:
            if self._user_profile is not None:
                self._avatar = False
            return None
        try:
            # The client's usual JSON Accept header, not ``image/*``: BRAIN's
            # ``/users/<id>/image`` answers 406 to any Accept naming an image type, and serves
            # the JPEG to everything else. The media type is checked below instead.
            response = await self.endpoints.client.request(
                "GET", url, raw=True, raise_for_status=False
            )
        # Decoration: a failed fetch shows the initials, and is tried again next session.
        except Exception as exc:  # noqa: BLE001
            log.warning("brain.avatar.failed", error=str(exc))
            self._avatar = False
            return None
        media = str(response.headers.get("content-type", "")).split(";")[0].strip().lower()
        body = response.body
        if (
            response.status >= 400
            or not isinstance(body, bytes)
            or media not in AVATAR_TYPES
            or len(body) > AVATAR_MAX_BYTES
        ):
            log.info("brain.avatar.unusable", status=response.status, media=media)
            self._avatar = False
            return None
        self._avatar = (body, media)
        return self._avatar

    # -- credential storage ----------------------------------------------

    async def store_credential(self, email: str, password: str) -> None:
        """Save (or replace) the BRAIN login, sealed at rest."""
        sealed = self.sealer.seal(password, context=PASSWORD_CONTEXT)
        async with self.db.session() as session:
            existing = (
                (await session.execute(select(Credential).where(Credential.email == email)))
                .scalars()
                .first()
            )
            if existing is not None:
                existing.password_sealed = sealed
            else:
                session.add(Credential(email=email, password_sealed=sealed))
        log.info("credential.stored", email=_mask(email))

    async def get_credential(self) -> tuple[str, str] | None:
        """Return the stored ``(email, password)``, unsealed."""
        async with self.db.session() as session:
            credential = await _current_credential(session)
            if credential is None:
                return None
            password = self.sealer.open(credential.password_sealed, context=PASSWORD_CONTEXT)
            return credential.email, password

    async def stored_email(self) -> str | None:
        async with self.db.session() as session:
            credential = await _current_credential(session)
            return credential.email if credential else None

    # -- session ---------------------------------------------------------

    async def restore(self) -> SessionInfo:
        """Reuse a cached cookie jar if it is still valid. Called at startup."""
        cookies = await self._load_cookies()
        restored = await self.auth.restore(cookies)
        if restored is None or not restored.authenticated:
            # Unauthenticated but restorable (identity verification pending) keeps its
            # verification link; its cookies are left where they are.
            self._session = restored or SessionInfo.anonymous()
            return self._session
        self._session = restored
        await self._save_cookies(restored)
        await self._warm_operators()
        return restored

    async def login(self, email: str | None = None, password: str | None = None) -> SessionInfo:
        """Sign in, storing the credential if it was supplied here and accepted."""
        async with self._lock:
            supplied = bool(email and password)
            if not supplied:
                credential = await self.get_credential()
                if credential is None:
                    raise NoCredentialError(
                        "No BRAIN credentials stored. Sign in with your BRAIN email and "
                        "password; they are sealed on this machine and never leave it."
                    )
                email, password = credential
            if email is None or password is None:
                raise NoCredentialError("Enter both your BRAIN email and password.")

            self._user_profile = None
            self._avatar = None
            # A pending verification is finished on its own inquiry, never by a new sign-in.
            pending = self._session.inquiry
            info = await self.auth.verify(pending) if pending else None
            if info is None:
                info = await self.auth.login(email, password)
            self._session = info
            # Paused for an identity check: the password was right, but it is not accepted
            # until the check passes, so it waits here rather than in the vault.
            self._awaiting_check = (email, password) if supplied and info.inquiry else None
            if info.authenticated:
                # Stored only once BRAIN accepts it: a mistyped password must not become the
                # credential that silent re-login keeps retrying.
                if supplied:
                    await self.store_credential(email, password)
                # Touched first: _save_cookies files the jar under the most recent sign-in,
                # so a new email's cookies would otherwise land on the previous account's row.
                await self._touch_last_login(email)
                await self._save_cookies(info)
                # Warm the profile so the first screen can greet them by name without a
                # second round trip. Failure is swallowed inside; a missing name is cosmetic.
                await self.get_user_profile()
                await self._warm_operators()
            return info

    async def verify(self, inquiry: str) -> SessionInfo:
        """Finish a sign-in BRAIN paused for an identity check, without asking again.

        :meth:`login` already resumes a pending inquiry, which is why the old advice was to
        sign in a second time. That works and asks the person to type a password they have
        just typed. This closes the same inquiry on its own, so the check finishing is all
        it takes.

        Answering before the check is done is the normal case, not a failure: the session
        comes back unauthenticated and still carrying the inquiry, and the caller asks
        again. Nothing here is stored until BRAIN accepts it.
        """
        async with self._lock:
            # A check that queued behind the one that signed in. BRAIN has spent the inquiry
            # and answers "not verified", which would sign out the session just made.
            if self._session.authenticated:
                return self._session
            info = await self.auth.verify(inquiry)
            if info is None:
                # BRAIN would not take the inquiry at all. The session keeps what it had, so
                # the screen still shows the check rather than a bare failure.
                return self._session
            self._user_profile = None
            self._avatar = None
            self._session = info
            if info.authenticated:
                # The login that started this check is accepted now. Without it stored, the
                # cookie jar had no row to be filed under and was never saved, so every
                # restart lost the session.
                if self._awaiting_check is not None:
                    email, password = self._awaiting_check
                    self._awaiting_check = None
                    await self.store_credential(email, password)
                    await self._touch_last_login(email)
                await self._save_cookies(info)
                await self.get_user_profile()
                await self._warm_operators()
            return info

    async def status(self, *, refresh: bool = False) -> SessionInfo:
        """Current state. ``refresh`` re-validates against the platform."""
        if not refresh:
            return self._session
        # Locked: a check still in flight when a sign-in lands would put the old state back.
        async with self._lock:
            fresh = await self.auth.status()
            # The profile is cached, so re-reading it returns early and would not set the
            # name again on the new object.
            if fresh.authenticated and not fresh.full_name:
                fresh.full_name = self._session.full_name
            if not fresh.authenticated and self._session.inquiry:
                # A refresh that only says "not signed in" must not drop the inquiry the
                # person is part-way through: the next sign-in would mint a replacement and
                # strand the link already open in their browser.
                fresh.inquiry = self._session.inquiry
                fresh.verification_url = self._session.verification_url
                fresh.detail = fresh.detail or self._session.detail
            self._session = fresh
            if self._session.authenticated:
                await self.get_user_profile()
            return self._session

    async def logout(self) -> None:
        async with self._lock:
            self._awaiting_check = None
            self._user_profile = None
            self._avatar = None
            await self.auth.logout()
            await self._clear_cookies()
            self._session = SessionInfo.anonymous()

    async def forget(self) -> None:
        """Sign out and delete every stored login: email, sealed password and cookie jar.

        Signing out alone keeps the credential so the next start can sign in unattended;
        this is the way to take it off the machine without wiping the data directory.
        """
        async with self._lock:
            self._awaiting_check = None
            self._user_profile = None
            self._avatar = None
            # BRAIN being unreachable must not keep the password on disk.
            try:
                await self.auth.logout()
            except Exception:
                log.warning("brain.logout_failed", exc_info=True)
            await self._clear_cookies()
            async with self.db.session() as session:
                for row in (await session.execute(select(Credential))).scalars():
                    await session.delete(row)
            self._session = SessionInfo.anonymous()
        log.info("credential.forgotten")

    async def _warm_operators(self) -> None:
        """Cache the account's own operator list once signed in.

        A failure is logged, never raised: signing in must not fail because Labs and
        validation could not read their operator list.
        """
        try:
            await self.metadata.refresh_operators()
        except Exception:
            log.warning("operators.refresh_failed", exc_info=True)

    # -- cookie persistence ----------------------------------------------

    async def _load_cookies(self) -> list[dict[str, Any]] | None:
        async with self.db.session() as session:
            credential = await _current_credential(session)
            if credential is None:
                return None
            row = (
                (
                    await session.execute(
                        select(BrainSessionRow)
                        .where(BrainSessionRow.credential_id == credential.id)
                        .order_by(BrainSessionRow.updated_at.desc())
                        .limit(1)
                    )
                )
                .scalars()
                .first()
            )
            if row is None:
                return None
            try:
                return json.loads(self.sealer.open(row.cookies_sealed, context=COOKIE_CONTEXT))
            except SealError, ValueError:
                log.warning("session.cookies_unreadable")
                return None

    async def _save_cookies(self, info: SessionInfo) -> None:
        cookies = self.endpoints.client.export_cookies()
        if not cookies:
            return
        sealed = self.sealer.seal(json.dumps(cookies), context=COOKIE_CONTEXT)
        expires = datetime.fromtimestamp(info.expires_at, tz=UTC) if info.expires_at else None

        async with self.db.session() as session:
            credential = await _current_credential(session)
            if credential is None:
                return
            row = (
                (
                    await session.execute(
                        select(BrainSessionRow).where(
                            BrainSessionRow.credential_id == credential.id
                        )
                    )
                )
                .scalars()
                .first()
            )
            if row is None:
                session.add(
                    BrainSessionRow(
                        credential_id=credential.id,
                        cookies_sealed=sealed,
                        user_id=info.user_id,
                        permissions=info.permissions,
                        expires_at=expires,
                    )
                )
            else:
                row.cookies_sealed = sealed
                row.user_id = info.user_id
                row.permissions = info.permissions
                row.expires_at = expires

    async def _clear_cookies(self) -> None:
        async with self.db.session() as session:
            for row in (await session.execute(select(BrainSessionRow))).scalars():
                await session.delete(row)

    async def _touch_last_login(self, email: str) -> None:
        async with self.db.session() as session:
            credential = (
                (await session.execute(select(Credential).where(Credential.email == email)))
                .scalars()
                .first()
            )
            if credential is not None:
                credential.last_login_at = utcnow()


#: Raster images only: an SVG opened on its own runs its scripts in this app's origin.
AVATAR_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})
AVATAR_MAX_BYTES = 1_000_000
_PICTURE_WORDS = ("avatar", "photo", "picture", "image")


def avatar_url(profile: dict[str, Any]) -> str | None:
    """The first https URL under a picture-like key of a BRAIN profile, if any.

    BRAIN publishes no schema for ``/users``, so this looks for ``avatar``, ``photo``,
    ``picture`` or ``image`` in a key name, one level of nesting deep (``{"avatar": {"url":
    ...}}``), and takes only https: the fetch carries BRAIN's cookies when the host is BRAIN's.
    """
    for key, value in profile.items():
        if not any(word in key.lower() for word in _PICTURE_WORDS):
            continue
        candidates = value.values() if isinstance(value, dict) else [value]
        for candidate in candidates:
            if isinstance(candidate, str) and candidate.startswith("https://"):
                return candidate
    return None


#: How long BRAIN's settings schema is trusted before it is read again.
SCHEMA_MAX_AGE = timedelta(hours=1)

#: The cached schema is keyed by what produced it, not just by what it is.
#:
#: It is a *merge* of the per-type trees this build knows about, so a build that merges a
#: different set must not read a row written by one that merged another. Without this, an
#: update that adds a simulation type goes unnoticed for up to :data:`SCHEMA_MAX_AGE` — the
#: new markets simply do not appear, and the release looks broken. Measured on the release
#: that added region-agnostic simulations.
SCHEMA_KEY = f"settings_schema:{'+'.join(SIMULATION_TYPES)}"


class PlatformMetadata:
    """The account's operators and BRAIN's settings schema, cached in SQLite."""

    def __init__(self, db: Database, endpoints: BrainEndpoints) -> None:
        self.db = db
        self.endpoints = endpoints

    async def refresh_metadata(self) -> dict[str, Any]:
        """Cache ``OPTIONS /simulations``: region / universe / neutralization and their
        interdependencies.

        Refreshed rather than hardcoded, because the set changes with new markets and with
        the account's permissions.
        """
        schema = await self.endpoints.settings_schema()
        await self._cache(SCHEMA_KEY, schema)
        return schema

    async def cached_settings_schema(self) -> dict[str, Any] | None:
        """The settings schema, re-read from BRAIN once the stored copy is an hour old.

        Refreshing only at sign-in left a restored session offering universes BRAIN had
        withdrawn. A failed refresh keeps the old copy, still right for almost every setting.
        A build that merges a different set of simulation types finds no copy at all, by
        :data:`SCHEMA_KEY`, and reads a fresh one.
        """
        async with self.db.session() as session:
            row = await session.get(MetadataCache, SCHEMA_KEY)
            cached, fetched = (row.value, row.fetched_at) if row else (None, None)
        if fetched is not None and fetched.tzinfo is None:
            fetched = fetched.replace(tzinfo=UTC)
        if cached is not None and fetched is not None and utcnow() - fetched < SCHEMA_MAX_AGE:
            return cached
        try:
            return await self.refresh_metadata()
        except BrainError:
            log.warning("metadata.schema_refresh_failed", exc_info=True)
            return cached

    async def refresh_operators(self) -> list[dict[str, Any]]:
        operators = await self.endpoints.list_operators()
        payload = [o.model_dump(by_alias=True) for o in operators]
        await self._cache("operators", {"items": payload})
        return payload

    async def cached_operators(self) -> list[dict[str, Any]] | None:
        cached = await self._read_cache("operators")
        return cached.get("items") if cached else None

    async def _cache(self, key: str, value: dict[str, Any]) -> None:
        async with self.db.session() as session:
            row = await session.get(MetadataCache, key)
            if row is None:
                session.add(MetadataCache(key=key, value=value))
            else:
                row.value = value
                row.fetched_at = utcnow()

    async def _read_cache(self, key: str) -> dict[str, Any] | None:
        async with self.db.session() as session:
            row = await session.get(MetadataCache, key)
            return row.value if row else None


async def _current_credential(session: Any) -> Credential | None:
    """The credential in use: the one that signed in most recently.

    Most-recent rather than oldest-first, so signing in with a different email is the
    account silent re-login and the cookie jar then use.
    """
    return (
        (
            await session.execute(
                select(Credential)
                .order_by(Credential.last_login_at.desc().nulls_last(), Credential.id.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )


def _mask(email: str) -> str:
    """Never log a full address."""
    name, _, domain = email.partition("@")
    head = name[:2] if len(name) > 2 else name[:1]
    return f"{head}***@{domain}" if domain else f"{head}***"
