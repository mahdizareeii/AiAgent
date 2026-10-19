"""Optional private read witnesses. Never replace or retry a native file read.

The nonce is not delivery or acceptance evidence by itself. The desktop host
independently binds its pre-read revision, actual model delivery, and reporting.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from contextvars import ContextVar
import hashlib
import json
import logging
import re
from typing import Any

import httpx

_URL = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/[a-f0-9]{64}")
_HEX = re.compile(r"[a-f0-9]{64}")
_REQUEST_BYTES = 64 * 1024
_RESPONSE_BYTES = 8 * 1024
_PHASE_SECONDS = 2.0
_PRIVATE_REQUEST = ContextVar("local_agent_private_readback_request", default=False)
_DEFAULTS = {"start_line": 1, "max_lines": 200, "cursor": None,
             "expected_sha256": None, "max_chars": None}
_NATIVE_FIELDS = {"ok", "path", "size", "sha256", "total_lines", "start_line",
                  "start_column", "end_line", "end_column", "start_byte", "end_byte",
                  "encoding", "text", "eof", "next_cursor", "truncated"}


class _HidePrivateChannel(logging.Filter):
    """Suppress only this task's HTTP diagnostics, including the secret URL."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not _PRIVATE_REQUEST.get()


# Library request logging includes the URL at INFO. A context-local filter
# preserves unrelated web diagnostics without changing global log levels.
for _logger in ("httpx", "httpcore.connection", "httpcore.connection_pool",
                "httpcore.http11", "httpcore.http2", "httpcore.proxy"):
    logging.getLogger(_logger).addFilter(_HidePrivateChannel())


def normalize_read_arguments(arguments: Mapping[str, Any]) -> dict[str, Any] | None:
    """Closed actual MCP arguments with explicit defaults; no path rewriting."""
    if not isinstance(arguments, Mapping) or set(arguments) - {"path", *_DEFAULTS}:
        return None
    value = {"path": arguments.get("path"), **_DEFAULTS, **arguments}
    if not isinstance(value["path"], str) or not value["path"] or "\0" in value["path"]:
        return None
    if any(type(value[key]) is not int for key in ("start_line", "max_lines")):
        return None
    if any(value[key] is not None and not isinstance(value[key], str)
           for key in ("cursor", "expected_sha256")):
        return None
    if value["max_chars"] is not None and type(value["max_chars"]) is not int:
        return None
    return value


def _valid_endpoint(endpoint: str | None) -> bool:
    if not isinstance(endpoint, str):
        return False
    match = _URL.fullmatch(endpoint)
    return match is not None and int(match[1]) <= 65535


def _check_cancelled() -> None:
    task = asyncio.current_task()
    if task is not None and task.cancelling():
        raise asyncio.CancelledError


def _strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate receipt response field")
        value[key] = item
    return value


def _nonfinite(_: str):
    raise ValueError("nonfinite receipt response")


async def _post(endpoint: str, body: dict[str, Any], field: str) -> str | None:
    """One bounded numeric-loopback exchange, with no retries or diagnostics."""
    if not _valid_endpoint(endpoint):
        return None
    try:
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(encoded) > _REQUEST_BYTES:
            return None

        async def exchange() -> str | None:
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False,
                                        timeout=httpx.Timeout(_PHASE_SECONDS)) as client:
                async with client.stream("POST", endpoint, content=encoded,
                                         headers={"Content-Type": "application/json", "Accept-Encoding": "identity"}) as response:
                    if response.status_code != 200:
                        return None
                    if response.headers.get("content-encoding", "identity").lower() != "identity":
                        return None
                    if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                        return None
                    length = response.headers.get("content-length")
                    if length is not None and (not length.isascii() or not length.isdecimal() or int(length) > _RESPONSE_BYTES):
                        return None
                    data = bytearray()
                    async for part in response.aiter_raw(chunk_size=_RESPONSE_BYTES + 1):
                        if len(data) + len(part) > _RESPONSE_BYTES:
                            return None
                        data.extend(part)
                    decoded = json.loads(data.decode("utf-8"), object_pairs_hook=_strict_object,
                                         parse_constant=_nonfinite)
                    if not isinstance(decoded, dict) or set(decoded) != {"ok", "schemaVersion", field}:
                        return None
                    value = decoded[field]
                    if decoded["ok"] is not True or type(decoded["schemaVersion"]) is not int or decoded["schemaVersion"] != 1:
                        return None
                    return value if isinstance(value, str) and _HEX.fullmatch(value) else None

        _check_cancelled()
        private = _PRIVATE_REQUEST.set(True)
        try:
            value = await asyncio.wait_for(exchange(), _PHASE_SECONDS)
            _check_cancelled()
            return value
        finally:
            _PRIVATE_REQUEST.reset(private)
    except Exception:
        # Deliberately do not log exceptions: HTTP errors may contain the URL.
        # CancelledError is a BaseException and must preserve task cancellation.
        return None


def _complete_native_result(result: Any) -> bool:
    if not isinstance(result, dict) or set(result) != _NATIVE_FIELDS:
        return False
    if result["ok"] is not True or result["encoding"] != "utf-8" or result["eof"] is not True:
        return False
    if result["truncated"] is not False or result["next_cursor"] is not None:
        return False
    if not isinstance(result["path"], str) or not result["path"].startswith("/"):
        return False
    if not isinstance(result["text"], str) or not isinstance(result["sha256"], str) or not _HEX.fullmatch(result["sha256"]):
        return False
    if type(result["size"]) is not int or not 0 <= result["size"] <= 2048:
        return False
    if any(type(result[key]) is not int for key in ("start_byte", "end_byte", "total_lines",
                                                   "start_line", "start_column", "end_line", "end_column")):
        return False
    if result["start_byte"] != 0 or result["end_byte"] != result["size"] or result["total_lines"] < 0:
        return False
    if result["start_line"] != 1 or result["start_column"] != 1 or result["end_line"] < 1 or result["end_column"] < 1:
        return False
    try:
        payload = result["text"].encode("utf-8")
        return len(payload) == result["size"] and hashlib.sha256(payload).hexdigest() == result["sha256"]
    except UnicodeError:
        return False


async def read_file_with_receipt(read_once: Callable[[], Awaitable[dict[str, Any]]],
                                 arguments: Mapping[str, Any], *, endpoint: str | None,
                                 result_budget: Callable[[], int]) -> dict[str, Any]:
    """Wrap exactly one real read; failed optional attestation changes no result."""
    normalized = normalize_read_arguments(arguments) if _valid_endpoint(endpoint) else None
    if normalized is None:
        return await read_once()
    token = await _post(endpoint, {"schemaVersion": 1, "phase": "begin", "arguments": normalized}, "token")
    _check_cancelled()
    result = await read_once()
    _check_cancelled()
    if token is None or not _complete_native_result(result):
        return result
    try:
        budget = result_budget()
        candidate = {**result, "readback_receipt": {"schemaVersion": 1, "nonce": "0" * 64}}
        if type(budget) is not int or not 500 <= budget <= 16000:
            return result
        if len(json.dumps(candidate, ensure_ascii=False, indent=2, allow_nan=False)) > budget:
            return result
    except Exception:
        return result
    nonce = await _post(endpoint, {"schemaVersion": 1, "phase": "finish", "token": token, "result": result}, "nonce")
    _check_cancelled()
    return {**result, "readback_receipt": {"schemaVersion": 1, "nonce": nonce}} if nonce is not None else result
