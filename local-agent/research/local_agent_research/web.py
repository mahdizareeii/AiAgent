"""Public-web reads with pinned DNS, no browser state, and bounded results."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup

from .errors import ToolError

MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024
MAX_PAGE_CHARS = 60_000
MAX_CHUNK_CHARS = 8_000
MAX_REDIRECTS = 5
HEADERS = {"User-Agent": "LocalAgentResearch/0.1 (+read-only public research)", "Accept": "text/html,text/plain;q=0.9", "Accept-Encoding": "identity"}


def parse_public_url(url: str) -> tuple[str, str, int]:
    if len(url) > 4096 or any(ord(char) < 32 for char in url) or "\\" in url:
        raise ToolError("invalid_url", "Supply a normal HTTP(S) URL of at most 4096 characters.")
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        if parsed.scheme not in {"http", "https"} or not host or parsed.username is not None or parsed.password is not None:
            raise ValueError()
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if port != (443 if parsed.scheme == "https" else 80):
            raise ValueError()
        host = host.rstrip(".").encode("idna").decode("ascii").lower()
        if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".home", ".lan")) or "%" in host:
            raise ValueError()
        authority = f"[{host}]" if ":" in host else host
        normalized = urlunsplit((parsed.scheme, authority, parsed.path or "/", parsed.query, ""))
        return normalized, host, port
    except (ValueError, UnicodeError) as exc:
        raise ToolError("invalid_url", "Only public HTTP(S) URLs on their standard ports, without credentials, are allowed.") from exc


def globally_routable(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
        # Reject IPv4-mapped v6 and translation/tunnel prefixes, whose routing differs by OS.
        return ip.is_global and not ip.is_multicast and not ip.is_unspecified and not (isinstance(ip, ipaddress.IPv6Address) and (ip.ipv4_mapped or ip.sixtofour or ip.teredo)) and ip not in ipaddress.ip_network("64:ff9b::/96")
    except ValueError:
        return False


async def resolve_public(host: str, port: int) -> list[str]:
    try:
        addresses = await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM), timeout=5)
    except (OSError, TimeoutError) as exc:
        raise ToolError("dns_failed", "The public host could not be resolved.") from exc
    ips = list(dict.fromkeys(record[4][0] for record in addresses))
    if not ips or any(not globally_routable(ip) for ip in ips):
        raise ToolError("private_address_denied", "Local, private, reserved, and mixed public/private addresses cannot be fetched.")
    return ips


async def _get_one(url: str, host: str, ip: str, *, transport: httpx.AsyncBaseTransport | None = None) -> tuple[int, dict, bytes]:
    # Connect to the already-validated numeric address, retaining TLS identity and Host.
    # Never give httpx a hostname to re-resolve after policy validation (DNS rebinding).
    pinned = httpx.URL(url).copy_with(host=ip)
    headers = {**HEADERS, "Host": f"[{host}]" if ":" in host else host}
    async with httpx.AsyncClient(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(10, connect=5), transport=transport) as client:
        request = client.build_request("GET", pinned, headers=headers)
        request.extensions["sni_hostname"] = host
        response = await client.send(request, stream=True)
        try:
            response_headers = dict(response.headers)
            if response.status_code in {301, 302, 303, 307, 308}:
                return response.status_code, response_headers, b""
            if response.status_code >= 400:
                raise ToolError("http_error", f"The public page returned HTTP {response.status_code}.")
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type not in {"text/html", "application/xhtml+xml", "text/plain"}:
                raise ToolError("unsupported_content", "web_fetch supports HTML and plain text pages. Download a PDF yourself and select it for read_pdf.")
            if response.headers.get("content-encoding", "identity").lower() != "identity":
                raise ToolError("unsupported_encoding", "This server ignored the uncompressed transfer request.")
            try:
                advertised_size = int(response.headers.get("content-length", "0"))
            except ValueError:
                advertised_size = 0
            if advertised_size > MAX_DOWNLOAD_BYTES:
                raise ToolError("page_too_large", "This page exceeds the 2 MB download limit.")
            data = bytearray()
            async for chunk in response.aiter_raw():
                data.extend(chunk)
                if len(data) > MAX_DOWNLOAD_BYTES:
                    raise ToolError("page_too_large", "This page exceeds the 2 MB download limit.")
            return response.status_code, response_headers, bytes(data)
        finally:
            await response.aclose()


def extract_text(body: bytes, content_type: str) -> tuple[str, str]:
    if "html" in content_type:
        soup = BeautifulSoup(body, "html.parser")
        title = soup.title.get_text(" ", strip=True)[:300] if soup.title else ""
        for element in soup(["script", "style", "noscript", "iframe", "svg", "nav", "footer", "form"]):
            element.decompose()
        content = soup.find("main") or soup.find("article") or soup.body or soup
        text = content.get_text("\n", strip=True)
    else:
        title = ""
        text = body.decode("utf-8", errors="replace")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return title, "\n".join(lines)


async def web_fetch(url: str, offset: int = 0, max_chars: int = MAX_CHUNK_CHARS, *, resolver=resolve_public, getter=_get_one) -> dict:
    if not 0 <= offset <= MAX_PAGE_CHARS or not 500 <= max_chars <= MAX_CHUNK_CHARS:
        raise ToolError("invalid_range", "Use offset between 0 and 60000 and max_chars between 500 and 8000.")
    current, _, _ = parse_public_url(url)
    for hop in range(MAX_REDIRECTS + 1):
        current, host, port = parse_public_url(current)
        addresses = await resolver(host, port)
        # Every redirect resolves and validates again, then uses a fresh cookie-free client.
        status, headers, body = await getter(current, host, addresses[0])
        if status in {301, 302, 303, 307, 308}:
            if hop == MAX_REDIRECTS:
                raise ToolError("too_many_redirects", "The page exceeded five redirects.")
            location = headers.get("location")
            if not location:
                raise ToolError("invalid_redirect", "The page returned a redirect without a destination.")
            current = urljoin(current, location)
            continue
        title, text = extract_text(body, headers.get("content-type", "text/plain"))
        capped = text[:MAX_PAGE_CHARS]
        excerpt = capped[offset:offset + max_chars]
        next_offset = offset + len(excerpt)
        return {"ok": True, "url": current, "title": title, "text": excerpt, "offset": offset, "next_offset": next_offset if next_offset < len(capped) else None, "text_length": len(capped), "truncated": len(text) > MAX_PAGE_CHARS or next_offset < len(capped), "untrusted_content": True}
    raise ToolError("too_many_redirects", "The page exceeded five redirects.")


def web_search(query: str, max_results: int = 5) -> dict:
    from ddgs.ddgs import DDGS, ENGINES

    class DuckDuckGoOnly(DDGS):
        def _get_engines(self, category: str, backend: str):
            # DDGS 9.16.0 falls back to "auto" when the explicit engine is missing.
            # Guard before its implementation and inspect the result afterwards.
            if category != "text" or backend != "duckduckgo" or "duckduckgo" not in ENGINES.get(category, {}):
                raise ToolError("search_unavailable", "The DuckDuckGo backend is unavailable.")
            engines = super()._get_engines(category, backend)
            if not engines or any(engine.name != "duckduckgo" for engine in engines):
                raise ToolError("search_unavailable", "The DuckDuckGo backend is unavailable.")
            return engines

    if not query.strip() or len(query) > 500 or not 1 <= max_results <= 10:
        raise ToolError("invalid_query", "Use a query of 1-500 characters and max_results between 1 and 10.")
    try:
        # An explicit backend forbids fallback to other search providers.
        searcher = DuckDuckGoOnly(timeout=10, verify=True)
        searcher._proxy = None  # Do not inherit DDGS_PROXY from the desktop environment.
        result = searcher.text(query, max_results=max_results, backend="duckduckgo")
    except Exception as exc:
        # Do not return provider exception strings: they can contain query URLs or internals.
        raise ToolError("search_unavailable", "DuckDuckGo search is unavailable or rate limited. Retry later or provide public page URLs.") from exc
    items = []
    for item in result[:max_results]:
        try:
            normalized, _, _ = parse_public_url(str(item.get("href", "")))
        except ToolError:
            continue
        items.append({"title": str(item.get("title", ""))[:300], "url": normalized, "snippet": str(item.get("body", ""))[:1_000]})
    return {"ok": True, "query": query, "backend": "duckduckgo", "results": items, "untrusted_content": True}
