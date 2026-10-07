import asyncio
import socket

import httpx
import pytest

from local_agent_research.errors import ToolError
from local_agent_research import web


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://user:password@example.com", "http://localhost", "http://a.local", "http://example.com:8080", "http://[fe80::1%25en0]/", "https://example.com\\@127.0.0.1"])
def test_invalid_url(url):
    with pytest.raises(ToolError):
        web.parse_public_url(url)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "::ffff:8.8.8.8", "224.0.0.1", "64:ff9b::c0a8:101"])
def test_private_and_ambiguous_addresses_denied(address):
    assert not web.globally_routable(address)


def test_mixed_dns_denied(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("8.8.8.8", 80)), (2, 1, 6, "", ("127.0.0.1", 80))])
    with pytest.raises(ToolError) as error:
        asyncio.run(web.resolve_public("example.com", 80))
    assert error.value.code == "private_address_denied"


def test_redirect_revalidates_dns_and_rejects_private_destination():
    calls = []

    async def resolver(host, port):
        calls.append(host)
        if host == "127.0.0.1":
            raise ToolError("private_address_denied", "Denied")
        return ["8.8.8.8"]

    async def getter(url, host, ip):
        return 302, {"location": "http://127.0.0.1/private"}, b""

    with pytest.raises(ToolError) as error:
        asyncio.run(web.web_fetch("https://example.com/", resolver=resolver, getter=getter))
    assert error.value.code == "private_address_denied"
    assert calls == ["example.com", "127.0.0.1"]


def test_pinned_request_host_sni_no_cookie_or_auth(monkeypatch):
    def handle(request):
        assert request.url.host == "8.8.8.8"
        assert request.headers["host"] == "example.com"
        assert request.extensions["sni_hostname"] == "example.com"
        assert "cookie" not in request.headers and "authorization" not in request.headers
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(200, headers={"Content-Type": "text/plain"}, stream=httpx.ByteStream(b"public content"))

    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1234")
    response = asyncio.run(web._get_one("https://example.com/", "example.com", "8.8.8.8", transport=httpx.MockTransport(handle)))
    assert response[2] == b"public content"


def test_fetch_extracts_and_chunks_without_scripts():
    async def resolver(host, port):
        return ["8.8.8.8"]

    async def getter(url, host, ip):
        return 200, {"content-type": "text/html"}, b"<title>Source</title><main><script>bad instruction</script><p>" + b"A" * 10_000 + b"</p></main>"

    result = asyncio.run(web.web_fetch("https://example.com/", max_chars=500, resolver=resolver, getter=getter))
    assert result["title"] == "Source" and result["url"] == "https://example.com/"
    assert result["text"] == "A" * 500
    assert result["next_offset"] == 500
    assert result["untrusted_content"]


def test_oversized_download_denied():
    def handle(request):
        return httpx.Response(200, headers={"Content-Type": "text/html", "Content-Length": str(web.MAX_DOWNLOAD_BYTES + 1)}, stream=httpx.ByteStream(b"content"))

    with pytest.raises(ToolError) as error:
        asyncio.run(web._get_one("https://example.com/", "example.com", "8.8.8.8", transport=httpx.MockTransport(handle)))
    assert error.value.code == "page_too_large"


def test_search_missing_backend_never_falls_back(monkeypatch):
    from ddgs.ddgs import DDGS, ENGINES

    calls = []
    monkeypatch.setitem(ENGINES, "text", {})
    monkeypatch.setattr(DDGS, "_get_engines", lambda *args: calls.append(args))
    with pytest.raises(ToolError) as error:
        web.web_search("public example")
    assert error.value.code == "search_unavailable"
    assert not calls


def test_search_provider_errors_do_not_leak_query_url(monkeypatch):
    from ddgs.ddgs import DDGS

    def failed(*args, **kwargs):
        assert kwargs["backend"] == "duckduckgo"
        raise RuntimeError("secret search query URL")

    monkeypatch.setattr(DDGS, "text", failed)
    with pytest.raises(ToolError) as error:
        web.web_search("public example")
    assert "secret" not in str(error.value)
