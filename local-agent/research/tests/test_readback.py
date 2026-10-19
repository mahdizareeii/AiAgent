"""Readback witness tests; no model or public network is required."""

import asyncio
import copy
import hashlib
import json
import logging

import httpx
import pytest

from local_agent_research import readback

URL = "http://127.0.0.1:43129/" + "a" * 64
TOKEN = "b" * 64
NONCE = "c" * 64


def native_result(text="Local agents finish tasks.\n", path="/workspace/note.txt"):
    raw = text.encode("utf-8")
    return {"ok": True, "path": path, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "total_lines": text.count("\n") + int(bool(text) and not text.endswith("\n")),
            "start_line": 1, "start_column": 1, "end_line": text.count("\n") + 1,
            "end_column": 1 if text.endswith("\n") else len(text.rsplit("\n", 1)[-1]) + 1,
            "start_byte": 0, "end_byte": len(raw), "encoding": "utf-8", "text": text,
            "eof": True, "next_cursor": None, "truncated": False}


class Chunks(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data
        self.closed = False

    async def __aiter__(self):
        for chunk in self.data:
            yield chunk

    async def aclose(self):
        self.closed = True


def response(request, data=None, *, status=200, raw=None, headers=None):
    encoded = json.dumps(data).encode() if raw is None else raw
    return httpx.Response(status, headers={"content-type": "application/json", **(headers or {})},
                          stream=Chunks([encoded]), request=request)


def use_transport(monkeypatch, handler):
    original = httpx.AsyncClient
    clients = []

    def client(**kwargs):
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        assert isinstance(kwargs["timeout"], httpx.Timeout)
        clients.append(kwargs)
        return original(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(readback.httpx, "AsyncClient", client)
    return clients


def run_read(native, *, endpoint=URL, arguments=None, budget=4000, events=None):
    calls = []

    async def once():
        calls.append("native-read")
        if events is not None:
            events.append("native-read")
        return native

    result = asyncio.run(readback.read_file_with_receipt(
        once, {"path": "note.txt"} if arguments is None else arguments,
        endpoint=endpoint, result_budget=lambda: budget))
    assert calls == ["native-read"]
    return result


def test_begin_precedes_exactly_one_native_read_and_finish_contains_original_result(monkeypatch):
    events, requests = [], []
    native = native_result()

    def handler(request):
        assert request.method == "POST" and str(request.url) == URL
        assert request.headers["accept-encoding"] == "identity"
        body = json.loads(request.content)
        requests.append(body)
        events.append(body["phase"])
        return response(request, {"ok": True, "schemaVersion": 1,
                                  "token" if body["phase"] == "begin" else "nonce":
                                  TOKEN if body["phase"] == "begin" else NONCE})

    use_transport(monkeypatch, handler)
    result = run_read(native, events=events)
    assert events == ["begin", "native-read", "finish"]
    assert requests == [{"schemaVersion": 1, "phase": "begin", "arguments": {
        "path": "note.txt", "start_line": 1, "max_lines": 200, "cursor": None,
        "expected_sha256": None, "max_chars": None}},
        {"schemaVersion": 1, "phase": "finish", "token": TOKEN, "result": native}]
    assert result == {**native, "readback_receipt": {"schemaVersion": 1, "nonce": NONCE}}
    assert "readback_receipt" not in native
    assert TOKEN not in json.dumps(result) and URL not in json.dumps(result)


def test_closed_normalization_preserves_actual_values_and_defaults():
    assert readback.normalize_read_arguments({"path": "note.txt"}) == {
        "path": "note.txt", "start_line": 1, "max_lines": 200, "cursor": None,
        "expected_sha256": None, "max_chars": None}
    given = {"path": "./nested/عنوان.txt", "start_line": 2, "max_lines": 7,
             "cursor": "opaque", "expected_sha256": "d" * 64, "max_chars": 500}
    assert readback.normalize_read_arguments(given) == given
    for invalid in ({"path": "note.txt", "unexpected": True}, {"path": "note.txt", "start_line": True},
                    {"path": "note.txt", "max_chars": False}, {"path": "note.txt", "cursor": 1}):
        assert readback.normalize_read_arguments(invalid) is None


@pytest.mark.parametrize("endpoint", [None, "", "https://127.0.0.1:43129/" + "a" * 64,
    "http://localhost:43129/" + "a" * 64, "http://127.0.0.2:43129/" + "a" * 64,
    "http://[::1]:43129/" + "a" * 64, "http://127.0.0.1:0/" + "a" * 64,
    "http://127.0.0.1:65536/" + "a" * 64, URL + "?x=1", URL + "#secret", URL + "/",
    "http://user@127.0.0.1:43129/" + "a" * 64, URL.replace("a" * 64, "A" * 64)])
def test_no_endpoint_or_nonexact_loopback_url_never_opens_channel(monkeypatch, endpoint):
    def forbidden(**kwargs):
        pytest.fail("An absent or invalid channel must never create an HTTP client")

    monkeypatch.setattr(readback.httpx, "AsyncClient", forbidden)
    native = native_result()
    assert run_read(native, endpoint=endpoint) is native


@pytest.mark.parametrize("failure", ["redirect", "http-error", "network", "large", "duplicate",
    "missing-token", "bad-token", "wrong-version", "boolean-version", "bad-json", "compressed"])
def test_begin_channel_failure_preserves_native_result_without_finish_or_retry(monkeypatch, failure):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content)["phase"])
        if failure == "network":
            raise httpx.ConnectError("private transport failed", request=request)
        if failure == "redirect":
            return response(request, {}, status=302, headers={"location": "https://example.invalid/"})
        if failure == "http-error":
            return response(request, {}, status=500)
        if failure == "large":
            return response(request, raw=b" " * (8192 + 1))
        if failure == "duplicate":
            return response(request, raw=b'{"ok":true,"schemaVersion":1,"schemaVersion":1,"token":"' + TOKEN.encode() + b'"}')
        if failure == "bad-json":
            return response(request, raw=b"not JSON")
        if failure == "compressed":
            return response(request, {}, headers={"content-encoding": "gzip"})
        data = {"ok": True, "schemaVersion": 1, "token": TOKEN}
        if failure == "missing-token":
            data.pop("token")
        if failure == "bad-token":
            data["token"] = "B" * 64
        if failure == "wrong-version":
            data["schemaVersion"] = 2
        if failure == "boolean-version":
            data["schemaVersion"] = True
        return response(request, data)

    use_transport(monkeypatch, handler)
    native = native_result()
    assert run_read(native) is native
    assert calls == ["begin"]


@pytest.mark.parametrize("failure", ["missing", "invalid", "network", "error"])
def test_finish_failure_never_changes_result_or_repeats_read(monkeypatch, failure):
    calls = []

    def handler(request):
        phase = json.loads(request.content)["phase"]
        calls.append(phase)
        if phase == "begin":
            return response(request, {"ok": True, "schemaVersion": 1, "token": TOKEN})
        if failure == "network":
            raise httpx.ReadError("unavailable", request=request)
        if failure == "error":
            return response(request, {"ok": False, "schemaVersion": 1, "nonce": NONCE})
        return response(request, {"ok": True, "schemaVersion": 1, **({} if failure == "missing" else {"nonce": "short"})})

    use_transport(monkeypatch, handler)
    native = native_result()
    assert run_read(native) is native
    assert calls == ["begin", "finish"]


@pytest.mark.parametrize("change", ["failed", "partial-first", "partial-last", "truncated", "eof",
    "cursor", "encoding", "size", "hash", "metadata", "oversize", "existing-receipt"])
def test_only_successful_complete_original_native_result_can_finish(monkeypatch, change):
    phases = []

    def handler(request):
        phases.append(json.loads(request.content)["phase"])
        return response(request, {"ok": True, "schemaVersion": 1, "token": TOKEN})

    use_transport(monkeypatch, handler)
    value = native_result()
    if change == "failed":
        value = {"ok": False, "error": "path_denied", "message": "Access was denied."}
    elif change == "partial-first":
        value["end_byte"] -= 1
    elif change == "partial-last":
        value["start_byte"] = 1
    elif change == "truncated":
        value["truncated"] = True
    elif change == "eof":
        value["eof"] = False
    elif change == "cursor":
        value["next_cursor"] = "next"
    elif change == "encoding":
        value["encoding"] = "utf-16"
    elif change == "size":
        value["size"] = True
    elif change == "hash":
        value["sha256"] = "d" * 64
    elif change == "metadata":
        value.pop("total_lines")
    elif change == "oversize":
        value = native_result("x" * 2049)
    elif change == "existing-receipt":
        value["readback_receipt"] = {"schemaVersion": 1, "nonce": NONCE}
    before = copy.deepcopy(value)
    assert run_read(value) is value and value == before
    assert phases == ["begin"]


def test_attestation_does_not_increase_whole_result_budget(monkeypatch):
    phases = []

    def handler(request):
        phases.append(json.loads(request.content)["phase"])
        return response(request, {"ok": True, "schemaVersion": 1, "token": TOKEN})

    use_transport(monkeypatch, handler)
    native = native_result("x" * 1000)
    assert run_read(native, budget=500) is native
    assert phases == ["begin"]


def test_phase_total_timeout_is_bounded_and_preserves_one_native_read(monkeypatch):
    phases = []

    async def handler(request):
        phases.append(json.loads(request.content)["phase"])
        await asyncio.sleep(0.1)
        return response(request, {"ok": True, "schemaVersion": 1, "token": TOKEN})

    use_transport(monkeypatch, handler)
    monkeypatch.setattr(readback, "_PHASE_SECONDS", 0.01)
    native = native_result()
    assert run_read(native) is native
    assert phases == ["begin"]


def test_cancelled_native_read_never_finalizes_or_retries(monkeypatch):
    phases, reads = [], []

    def handler(request):
        phases.append(json.loads(request.content)["phase"])
        return response(request, {"ok": True, "schemaVersion": 1, "token": TOKEN})

    async def cancelled_read():
        reads.append("read")
        raise asyncio.CancelledError

    use_transport(monkeypatch, handler)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(readback.read_file_with_receipt(cancelled_read, {"path": "note.txt"},
                    endpoint=URL, result_budget=lambda: 4000))
    assert reads == ["read"] and phases == ["begin"]


def test_cancelled_begin_never_starts_native_read(monkeypatch):
    reads = []

    async def handler(request):
        raise asyncio.CancelledError

    async def read():
        reads.append("read")
        return native_result()

    use_transport(monkeypatch, handler)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(readback.read_file_with_receipt(read, {"path": "note.txt"}, endpoint=URL,
                                                   result_budget=lambda: 4000))
    assert reads == []


def test_pending_task_cancellation_after_native_return_cannot_start_finish(monkeypatch):
    phases = []

    def handler(request):
        phases.append(json.loads(request.content)["phase"])
        return response(request, {"ok": True, "schemaVersion": 1, "token": TOKEN})

    async def read():
        asyncio.current_task().cancel()
        return native_result()

    use_transport(monkeypatch, handler)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(readback.read_file_with_receipt(read, {"path": "note.txt"}, endpoint=URL,
                                                   result_budget=lambda: 4000))
    assert phases == ["begin"]


def test_native_exception_is_preserved_without_finish(monkeypatch):
    phases = []

    def handler(request):
        phases.append(json.loads(request.content)["phase"])
        return response(request, {"ok": True, "schemaVersion": 1, "token": TOKEN})

    async def read():
        raise RuntimeError("original native failure")

    use_transport(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="original native failure"):
        asyncio.run(readback.read_file_with_receipt(read, {"path": "note.txt"}, endpoint=URL,
                                                   result_budget=lambda: 4000))
    assert phases == ["begin"]


def test_actual_granted_read_preserves_bom_unicode_crlf_and_final_lf(monkeypatch, tmp_path):
    from local_agent_research.files import Grants

    text = "\ufeffعنوان: سلام 🌍\r\nStatus: verified.\r\n"
    (tmp_path / "unicode.txt").write_bytes(text.encode("utf-8"))
    monkeypatch.setenv("LOCAL_AGENT_GRANTED_ROOTS", json.dumps([str(tmp_path.resolve())]))
    monkeypatch.setenv("LOCAL_AGENT_GRANTED_FILES", "[]")
    monkeypatch.setenv("LOCAL_AGENT_TOOL_RESULT_CHARS", "4000")
    grants = Grants.from_env()
    requests, reads = [], []

    def handler(request):
        body = json.loads(request.content); requests.append(body)
        return response(request, {"ok": True, "schemaVersion": 1,
                                  "token" if body["phase"] == "begin" else "nonce":
                                  TOKEN if body["phase"] == "begin" else NONCE})

    async def read():
        reads.append("read")
        return await asyncio.to_thread(grants.read_file, "unicode.txt")

    use_transport(monkeypatch, handler)
    result = asyncio.run(readback.read_file_with_receipt(read, {"path": "unicode.txt"},
                        endpoint=URL, result_budget=lambda: 4000))
    assert reads == ["read"]
    assert result["text"] == requests[1]["result"]["text"] == text
    assert result["size"] == len(text.encode("utf-8"))
    assert result["sha256"] == hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert result["readback_receipt"] == {"schemaVersion": 1, "nonce": NONCE}


def test_oversized_request_is_not_sent_and_no_secret_is_logged(monkeypatch, caplog):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content)["phase"])
        logging.getLogger("httpx").warning("private request URL %s", request.url)
        return response(request, {"ok": True, "schemaVersion": 1, "token": TOKEN})

    use_transport(monkeypatch, handler)
    with caplog.at_level(logging.DEBUG):
        assert asyncio.run(readback._post(URL, {"payload": "x" * (64 * 1024)}, "token")) is None
        assert asyncio.run(readback._post(URL, {"schemaVersion": 1, "phase": "begin"}, "token")) == TOKEN
        logging.getLogger("httpx").warning("unrelated ordinary diagnostic")
    assert calls == ["begin"]
    assert URL not in caplog.text and "a" * 64 not in caplog.text
    assert "unrelated ordinary diagnostic" in caplog.text


@pytest.mark.parametrize("endpoint", [None, URL])
def test_existing_server_read_route_calls_native_once_with_unchanged_arguments(monkeypatch, endpoint):
    from local_agent_research import server

    registered, native_calls, phases = {}, [], []
    native = native_result()

    class RecordingServer:
        def __init__(self, *args, **kwargs):
            self.configuration = kwargs

        def tool(self, *, name, annotations):
            def register(function):
                registered[name] = function
                return function
            return register

    class NativeGrants:
        def read_file(self, *args, cancel_event=None):
            native_calls.append(args)
            assert cancel_event is not None and not cancel_event.is_set()
            return native

    def handler(request):
        phase = json.loads(request.content)["phase"]; phases.append(phase)
        return response(request, {"ok": True, "schemaVersion": 1,
                                  "token" if phase == "begin" else "nonce": TOKEN if phase == "begin" else NONCE})

    use_transport(monkeypatch, handler)
    monkeypatch.setattr(server, "MCPServer", RecordingServer)
    monkeypatch.setenv("LOCAL_AGENT_UTILITIES", json.dumps({"fileReading": True, "projectSearch": False}))
    monkeypatch.setenv("LOCAL_AGENT_TOOL_RESULT_CHARS", "4000")
    if endpoint is None:
        monkeypatch.delenv("LOCAL_AGENT_READBACK_URL", raising=False)
    else:
        monkeypatch.setenv("LOCAL_AGENT_READBACK_URL", endpoint)
    instance = server.create_server(grants=NativeGrants(), mode="coding")
    result = asyncio.run(registered["read_file"]("note.txt"))
    assert native_calls == [("note.txt", 1, 200, None, None, None)]
    assert set(registered) == {"inspect_file", "read_file", "read_pdf"}
    assert "exact UTF-8" in registered["read_file"].__doc__
    assert URL not in json.dumps(instance.configuration)
    if endpoint is None:
        assert result is native and phases == []
        assert json.dumps(result, ensure_ascii=False) == json.dumps(native, ensure_ascii=False)
    else:
        assert result == {**native, "readback_receipt": {"schemaVersion": 1, "nonce": NONCE}}
        assert phases == ["begin", "finish"]


def test_disabled_file_reading_exposes_no_route_or_receipt_channel(monkeypatch):
    from local_agent_research import server

    registered = {}

    class RecordingServer:
        def __init__(self, *args, **kwargs):
            self.configuration = kwargs

        def tool(self, *, name, annotations):
            def register(function):
                registered[name] = function
                return function
            return register

    def forbidden(**kwargs):
        pytest.fail("Disabled file reading must not open a receipt client")

    monkeypatch.setattr(server, "MCPServer", RecordingServer)
    monkeypatch.setattr(readback.httpx, "AsyncClient", forbidden)
    monkeypatch.setenv("LOCAL_AGENT_READBACK_URL", URL)
    monkeypatch.setenv("LOCAL_AGENT_TOOL_RESULT_CHARS", "4000")
    monkeypatch.setenv("LOCAL_AGENT_UTILITIES", json.dumps({"fileReading": False, "projectSearch": False}))
    instance = server.create_server(grants=object(), mode="coding")
    assert registered == {}
    assert URL not in json.dumps(instance.configuration)
