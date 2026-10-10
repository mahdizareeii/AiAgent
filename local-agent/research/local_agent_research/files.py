"""Bounded deterministic file reads from grants supplied by the desktop host."""

from __future__ import annotations

import contextlib
import base64
import functools
import hashlib
import json
import os
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import BinaryIO, Iterator

from .errors import ToolError

MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024
MAX_TEXT_CHARS = 16_000
MAX_PDF_BYTES = 2 * 1024 * 1024 * 1024
SEARCH_BYTES = 20 * 1024 * 1024
PDF_TIMEOUT_SECONDS = 30
MAX_VISITED = 10_000
SKIP_DIRS = {".git", ".svn", ".hg", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"}
SECRET_NAMES = {".env", ".aws", ".ssh", ".gnupg", ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json", "secrets.json", "id_rsa", "id_ed25519"}
SECRET_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".kdbx"}
TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".rst", ".py", ".js", ".jsx", ".ts", ".tsx", ".rs", ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".swift", ".kt", ".php", ".phtml", ".html", ".css", ".scss", ".json", ".toml", ".yaml", ".yml", ".xml", ".sql", ".sh", ".zsh", ".bash", ".csv", ".tsv", ".ini", ".cfg", ".conf", ".log", ".tex", ".vue", ".svelte"}
TEXT_NAMES = {"Dockerfile", "Makefile", "LICENSE", "NOTICE", ".gitignore", ".editorconfig"}


def result_chars(requested: int | None = None) -> int:
    try:
        configured = int(os.environ.get("LOCAL_AGENT_TOOL_RESULT_CHARS", "4000"))
        if not 500 <= configured <= MAX_TEXT_CHARS:
            raise ValueError()
    except ValueError as exc:
        raise ToolError("invalid_configuration", "LOCAL_AGENT_TOOL_RESULT_CHARS must be between 500 and 16000.") from exc
    if requested is not None and (isinstance(requested, bool) or not 500 <= requested <= MAX_TEXT_CHARS):
        raise ToolError("invalid_limit", "max_chars must be between 500 and 16000.")
    return min(configured, requested or configured)


def _check_cancel(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise ToolError("cancelled", "Reading was cancelled.")


def _identity(stream: BinaryIO) -> tuple[int, ...]:
    info = os.fstat(stream.fileno())
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


@functools.lru_cache(maxsize=1)
def _darwin_process_library():
    import ctypes
    library = ctypes.CDLL("/usr/lib/libproc.dylib")
    library.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    library.proc_pid_rusage.restype = ctypes.c_int
    return library


def _worker_resident_bytes(pid: int) -> int | None:
    if sys.platform != "darwin":
        return None
    import ctypes

    # rusage_info_v2 starts with a 16-byte UUID and seven uint64 fields through
    # ri_resident_size. Allocate the complete structure generously for newer OSes.
    buffer = ctypes.create_string_buffer(1024)
    if _darwin_process_library().proc_pid_rusage(pid, 2, buffer) != 0:
        return None
    return int.from_bytes(buffer.raw[64:72], sys.byteorder)


def _encode_cursor(kind: str, sha256: str, **position) -> str:
    return base64.urlsafe_b64encode(json.dumps({"v": 1, "kind": kind, "sha256": sha256, **position}, separators=(",", ":")).encode()).decode()


def _decode_cursor(cursor: str | None, kind: str, sha256: str) -> dict | None:
    if cursor is None:
        return None
    try:
        if not isinstance(cursor, str) or len(cursor) > 1024:
            raise ValueError()
        value = json.loads(base64.b64decode(cursor, altchars=b"-_", validate=True))
        if not isinstance(value, dict) or value.get("v") != 1 or value.get("kind") != kind:
            raise ValueError()
        if value.get("sha256") != sha256:
            raise ToolError("file_changed", "The file changed since this cursor was issued. Inspect it and restart the read.")
        return value
    except ToolError:
        raise
    except (ValueError, TypeError, UnicodeDecodeError) as exc:
        raise ToolError("invalid_cursor", "Use next_cursor returned by this tool.") from exc


def denied_name(path: Path) -> bool:
    return any(p.lower() in SECRET_NAMES or p.lower().startswith(".env.") for p in path.parts) or path.suffix.lower() in SECRET_SUFFIXES


def is_text(path: Path) -> bool:
    return path.suffix.lower() in TEXT_SUFFIXES or path.name in TEXT_NAMES


def _env_paths(name: str, *, directory: bool) -> tuple[Path, ...]:
    try:
        value = json.loads(os.environ.get(name, "[]"))
        if not isinstance(value, list) or len(value) > 100 or any(not isinstance(p, str) for p in value):
            raise ValueError()
        paths = []
        for entry in value:
            raw = Path(entry)
            if not raw.is_absolute():
                raise ValueError()
            path = raw.resolve(strict=True)
            if path.is_dir() != directory:
                raise ValueError()
            paths.append(path)
        return tuple(dict.fromkeys(paths))
    except (ValueError, OSError) as exc:
        raise ToolError("invalid_grants", f"{name} must be a JSON array of existing absolute {'directories' if directory else 'files'}.") from exc


class Grants:
    def __init__(self, roots: tuple[Path, ...] = (), files: tuple[Path, ...] = ()):
        self.roots = tuple(p.resolve(strict=True) for p in roots)
        self.files = tuple(p.resolve(strict=True) for p in files)
        self._hashes: dict[tuple[int, ...], dict] = {}
        self._hash_lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "Grants":
        return cls(_env_paths("LOCAL_AGENT_GRANTED_ROOTS", directory=True), _env_paths("LOCAL_AGENT_GRANTED_FILES", directory=False))

    def locate(self, requested: str, *, directory: bool = False) -> tuple[Path, Path, tuple[str, ...]]:
        if not requested or len(requested) > 4096 or "\x00" in requested:
            raise ToolError("invalid_path", "Supply a bounded file path.")
        raw = Path(requested)
        if ".." in raw.parts:
            raise ToolError("path_denied", "Parent traversal is not permitted.")
        if not raw.is_absolute():
            if len(self.roots) != 1:
                raise ToolError("path_denied", "Use an absolute path when there is not exactly one granted project.")
            raw = self.roots[0] / raw
        # Check lexical containment before resolve. Resolving first would conceal symlinks.
        candidates = sorted(self.roots, key=lambda p: len(p.parts), reverse=True)
        for root in candidates:
            try:
                relative = raw.relative_to(root)
            except ValueError:
                continue
            if denied_name(raw):
                raise ToolError("sensitive_file_denied", "Credential and secret files cannot be read by this tool.")
            self._validate_no_symlinks(root, relative.parts)
            canonical = raw.resolve(strict=True)
            if not canonical.is_relative_to(root):
                raise ToolError("path_denied", "The requested path escapes the granted project.")
            if canonical.is_dir() != directory:
                raise ToolError("invalid_path", "Expected a directory." if directory else "Expected a regular file.")
            return canonical, root, relative.parts
        if not directory:
            for file in self.files:
                if raw == file:
                    if denied_name(file):
                        raise ToolError("sensitive_file_denied", "Credential and secret files cannot be read by this tool.")
                    self._validate_no_symlinks(file.parent, (file.name,))
                    return file, file.parent, (file.name,)
        raise ToolError("path_denied", "Select this file or project in the app before reading it.")

    @staticmethod
    def _validate_no_symlinks(root: Path, parts: tuple[str, ...]) -> None:
        current = root
        for part in parts:
            current /= part
            try:
                if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
                    raise ToolError("path_denied", "Symbolic links and junctions are not traversed.")
                current.lstat()
            except OSError as exc:
                raise ToolError("file_unavailable", "The selected path is unavailable.") from exc

    @contextlib.contextmanager
    def open(self, requested: str, limit: int) -> Iterator[tuple[Path, BinaryIO]]:
        path, root, parts = self.locate(requested)
        descriptors = []
        try:
            # POSIX openat binds traversal to directory descriptors and refuses link races.
            if os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW"):
                parent = os.open(root.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                descriptors.append(parent)
                # Include the granted root's ancestors: an absolute-path open only protects
                # its final component and could otherwise follow a raced ancestor link.
                for part in root.parts[1:]:
                    parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    descriptors.append(parent)
                for part in parts[:-1]:
                    parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                    descriptors.append(parent)
                descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            else:
                descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
                # Windows: check the resolved handle destination, not only the path spelling.
                if os.name == "nt":
                    import ctypes
                    from ctypes import wintypes
                    import msvcrt

                    destination = ctypes.windll.kernel32.GetFinalPathNameByHandleW
                    destination.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
                    destination.restype = wintypes.DWORD
                    final_path = ctypes.create_unicode_buffer(32768)
                    length = destination(msvcrt.get_osfhandle(descriptor), final_path, len(final_path), 0)
                    observed = final_path.value.removeprefix("\\\\?\\")
                    if not length or Path(observed).resolve() != path:
                        os.close(descriptor)
                        raise ToolError("path_denied", "The file changed while being opened.")
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                os.close(descriptor)
                raise ToolError("invalid_path", "Only regular files can be read.")
            if info.st_size > limit:
                os.close(descriptor)
                raise ToolError("file_too_large", f"This file exceeds the safety limit of {limit // (1024 * 1024)} MiB. Select a smaller file or split it first.")
            with os.fdopen(descriptor, "rb") as stream:
                yield path, stream
        except OSError as exc:
            raise ToolError("file_unavailable", "The selected file is unavailable or changed while being opened.") from exc
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    def _inspect_stream(self, stream: BinaryIO, cancel_event: threading.Event | None = None) -> dict:
        before = _identity(stream)
        with self._hash_lock:
            cached = self._hashes.get(before)
        if cached is not None:
            return cached
        digest, newlines, last = hashlib.sha256(), 0, b""
        stream.seek(0)
        while chunk := stream.read(256 * 1024):
            _check_cancel(cancel_event)
            digest.update(chunk)
            newlines += chunk.count(b"\n")
            last = chunk[-1:]
        if before != _identity(stream):
            raise ToolError("file_changed", "The file changed while being inspected. Retry after it stops changing.")
        value = {"sha256": digest.hexdigest(), "size": before[2], "total_lines": newlines + int(bool(last) and last != b"\n")}
        with self._hash_lock:
            if len(self._hashes) >= 128:
                self._hashes.clear()
            self._hashes[before] = value
        return value

    def inspect_file(self, path: str, cancel_event: threading.Event | None = None) -> dict:
        with self.open(path, MAX_FILE_BYTES) as (canonical, stream):
            if not is_text(canonical) and canonical.suffix.lower() != ".pdf":
                raise ToolError("unsupported_file", "Choose UTF-8 text/code or a PDF.")
            inspected = self._inspect_stream(stream, cancel_event)
            if canonical.suffix.lower() == ".pdf":
                return {"ok": True, "path": str(canonical), "sha256": inspected["sha256"], "size": inspected["size"], "kind": "pdf"}
            return {"ok": True, "path": str(canonical), **inspected, "kind": "text"}

    @staticmethod
    def _expect_hash(sha256: str, expected_sha256: str | None) -> None:
        if expected_sha256 is not None and expected_sha256 != sha256:
            raise ToolError("file_changed", "The file differs from the checkpoint. Inspect it and restart processing this file.")

    def read_file(self, path: str, start_line: int = 1, max_lines: int = 200, cursor: str | None = None,
                  expected_sha256: str | None = None, max_chars: int | None = None,
                  cancel_event: threading.Event | None = None) -> dict:
        if not 1 <= start_line <= 1_000_000_000 or not 1 <= max_lines <= 500:
            raise ToolError("invalid_range", "Use start_line >= 1 and max_lines between 1 and 500.")
        budget = result_chars(max_chars)
        with self.open(path, MAX_FILE_BYTES) as (canonical, stream):
            if not is_text(canonical):
                raise ToolError("unsupported_file", "This tool reads code, text, and Markdown. Use read_pdf for PDFs.")
            inspected = self._inspect_stream(stream, cancel_event)
            self._expect_hash(inspected["sha256"], expected_sha256)
            before = _identity(stream)
            continuation = _decode_cursor(cursor, "text", inspected["sha256"])
            column, line = 1, start_line
            if continuation is not None:
                offset, line, column = (continuation.get(key) for key in ("offset", "line", "column"))
                if any(type(value) is not int for value in (offset, line, column)) or not 0 <= offset <= inspected["size"] or line < 1 or column < 1:
                    raise ToolError("invalid_cursor", "Use next_cursor returned by read_file.")
                stream.seek(offset)
            else:
                stream.seek(0)
                if stream.read(3) != b"\xef\xbb\xbf":
                    stream.seek(0)
                skipped = 1
                while skipped < start_line and (part := stream.readline(64 * 1024)):
                    _check_cancel(cancel_event)
                    skipped += int(part.endswith(b"\n"))
            first_line, first_column = line, column
            output, used, completed = [], 0, 0
            while stream.tell() < inspected["size"] and completed < max_lines:
                _check_cancel(cancel_event)
                prefix = f"{line}: "
                available = budget - used - len(prefix) - int(bool(output))
                if available < 1:
                    break
                offset = stream.tell()
                raw = stream.readline(min(64 * 1024, available * 4 + 4))
                if b"\x00" in raw:
                    raise ToolError("unsupported_file", "Binary files cannot be read as text.")
                try:
                    decoded = raw.decode("utf-8")
                except UnicodeDecodeError as exc:
                    # A fixed byte read can stop inside a UTF-8 code point. Leave it
                    # for the continuation rather than replacing or losing it.
                    if exc.reason != "unexpected end of data" or exc.start == 0:
                        raise ToolError("unsupported_encoding", "The selected file must be UTF-8 text.") from exc
                    raw = raw[:exc.start]
                    decoded = raw.decode("utf-8")
                newline = decoded.endswith("\n")
                content = decoded[:-1].removesuffix("\r") if newline else decoded
                selected = content[:available]
                fully_consumed = len(selected) == len(content)
                consumed = len(raw) if fully_consumed else len(selected.encode("utf-8"))
                stream.seek(offset + consumed)
                output.append(prefix + selected)
                used += len(prefix) + len(selected) + int(len(output) > 1)
                if newline and fully_consumed:
                    line, column = line + 1, 1
                    completed += 1
                else:
                    column += len(selected)
                    if stream.tell() >= inspected["size"]:
                        completed += 1
                    if not fully_consumed:
                        break
            if before != _identity(stream):
                raise ToolError("file_changed", "The file changed during this read. Discard this chunk and restart processing this file.")
            eof = stream.tell() >= inspected["size"]
            next_cursor = None if eof else _encode_cursor("text", inspected["sha256"], offset=stream.tell(), line=line, column=column)
            return {"ok": True, "path": str(canonical), **inspected, "start_line": first_line,
                    "start_column": first_column, "text": "\n".join(output), "eof": eof,
                    "next_cursor": next_cursor, "truncated": not eof}

    def walk(self, requested: str, max_files: int, cancel_event: threading.Event | None = None) -> tuple[list[Path], bool]:
        root, _, _ = self.locate(requested, directory=True)
        result = []
        visited = 0
        for current, dirs, files in os.walk(root, followlinks=False):
            _check_cancel(cancel_event)
            visited += 1
            if visited > MAX_VISITED:
                return result, True
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not denied_name(Path(d)) and not (Path(current) / d).is_symlink() and not (hasattr(Path(current) / d, "is_junction") and (Path(current) / d).is_junction()))
            for name in sorted(files):
                _check_cancel(cancel_event)
                visited += 1
                if visited > MAX_VISITED:
                    return result, True
                path = Path(current) / name
                if denied_name(path.relative_to(root)) or path.is_symlink() or not (is_text(path) or path.suffix.lower() == ".pdf"):
                    continue
                # Revalidate every path because directory entries may change during traversal.
                try:
                    self.locate(str(path))
                except ToolError:
                    continue
                result.append(path)
                if len(result) >= max_files:
                    return result, True
        return result, False

    def list_files(self, path: str, max_files: int = 100, cancel_event: threading.Event | None = None) -> dict:
        if not 1 <= max_files <= 500:
            raise ToolError("invalid_limit", "max_files must be between 1 and 500.")
        files, truncated = self.walk(path, max_files, cancel_event)
        _check_cancel(cancel_event)
        names, remaining = [], result_chars()
        for file in files:
            name = str(file)
            if len(name) > remaining:
                truncated = True
                break
            names.append(name)
            remaining -= len(name)
        return {"ok": True, "files": names, "truncated": truncated}

    def search_files(self, path: str, query: str, max_results: int = 30, cancel_event: threading.Event | None = None) -> dict:
        if not query or len(query) > 300 or not 1 <= max_results <= 100:
            raise ToolError("invalid_query", "Use a literal query of 1-300 characters and max_results between 1 and 100.")
        files, truncated = self.walk(path, 500, cancel_event)
        matches = []
        examined_bytes = 0
        result_size = 0
        result_budget = result_chars()
        for file in files:
            if not is_text(file):
                continue
            try:
                with self.open(str(file), MAX_FILE_BYTES) as (_, stream):
                    number, carry = 1, ""
                    while data := stream.readline(64 * 1024):
                        _check_cancel(cancel_event)
                        examined_bytes += len(data)
                        if examined_bytes > SEARCH_BYTES:
                            return {"ok": True, "matches": matches, "truncated": True}
                        if b"\x00" in data:
                            break
                        # Decode complete fragments; a few trailing bytes are retained
                        # by rewinding so Unicode queries can straddle the byte cap.
                        try:
                            line = data.decode("utf-8-sig" if stream.tell() == len(data) else "utf-8")
                        except UnicodeDecodeError as exc:
                            if exc.reason != "unexpected end of data" or exc.start == 0:
                                break
                            stream.seek(stream.tell() - len(data) + exc.start)
                            data = data[:exc.start]
                            line = data.decode("utf-8")
                        text = carry + line
                        found = text.find(query)
                        if found >= 0:
                            excerpt = text[max(0, found - 100):found + 400].rstrip("\r\n")
                            result_size += len(str(file)) + len(excerpt)
                            if result_size > result_budget:
                                return {"ok": True, "matches": matches, "truncated": True}
                            matches.append({"path": str(file), "line": number, "text": excerpt})
                            if len(matches) >= max_results:
                                return {"ok": True, "matches": matches, "truncated": True}
                        if line.endswith("\n"):
                            number += 1
                            carry = ""
                        else:
                            carry = text[-(len(query) - 1):] if len(query) > 1 else ""
            except (ToolError, UnicodeDecodeError):
                continue
        return {"ok": True, "matches": matches, "truncated": truncated}

    def read_pdf(self, path: str, start_page: int = 1, max_pages: int = 5, cursor: str | None = None,
                 expected_sha256: str | None = None, max_chars: int | None = None,
                 cancel_event: threading.Event | None = None) -> dict:
        if not 1 <= start_page <= 100_000 or not 1 <= max_pages <= 10:
            raise ToolError("invalid_range", "Use start_page >= 1 and max_pages between 1 and 10.")
        with self.open(path, MAX_PDF_BYTES) as (canonical, stream):
            if canonical.suffix.lower() != ".pdf":
                raise ToolError("unsupported_file", "Choose a PDF file.")
            inspected = self._inspect_stream(stream, cancel_event)
            self._expect_hash(inspected["sha256"], expected_sha256)
            before = _identity(stream)
            continuation = _decode_cursor(cursor, "pdf", inspected["sha256"])
            start_char = 0
            if continuation is not None:
                start_page, start_char = (continuation.get(key) for key in ("page", "char"))
                if type(start_page) is not int or type(start_char) is not int or not 1 <= start_page <= 100_000 or start_char < 0:
                    raise ToolError("invalid_cursor", "Use next_cursor returned by read_pdf.")
            config = json.dumps({"start_page": start_page, "start_char": start_char, "max_pages": max_pages, "max_chars": result_chars(max_chars)})
            command = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, str(Path(__file__).resolve().parents[1] / "sidecar.py")]
            stream.seek(0)
            # Passing the guarded regular-file descriptor as stdin lets the worker
            # seek without reopening a pathname or copying the PDF into RAM.
            process = subprocess.Popen([*command, "--pdf-worker", config], stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + PDF_TIMEOUT_SECONDS
            try:
                while True:
                    _check_cancel(cancel_event)
                    resident = _worker_resident_bytes(process.pid)
                    if resident is not None and resident > 1024 * 1024 * 1024:
                        raise ToolError("pdf_resource_limit", "PDF extraction exceeded the 1 GiB worker memory safety limit. Split or simplify this PDF.")
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ToolError("pdf_resource_limit", "PDF extraction exceeded the 30-second safety limit. Try fewer pages or a simpler PDF.")
                    try:
                        output, _ = process.communicate(timeout=min(0.1, remaining))
                        break
                    except subprocess.TimeoutExpired:
                        continue
                if process.returncode != 0:
                    raise ToolError("pdf_resource_limit", "PDF extraction exceeded its CPU/memory safety limit or could not be completed. Try fewer pages or a simpler PDF.")
                try:
                    value = json.loads(output)
                except (ValueError, UnicodeDecodeError) as exc:
                    raise ToolError("invalid_pdf", "This PDF could not be parsed safely.") from exc
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
            if before != _identity(stream):
                raise ToolError("file_changed", "The PDF changed during this read. Discard this chunk and restart processing this file.")
            position = value.pop("next_position", None)
            if not value.get("ok") and value.get("error") != "scanned_pdf_unsupported":
                raise ToolError(value.get("error", "invalid_pdf"), value.get("message", "This PDF could not be parsed safely."))
            value.update({"path": str(canonical), "sha256": inspected["sha256"], "size": inspected["size"], "next_cursor": None if position is None else _encode_cursor("pdf", inspected["sha256"], **position)})
            return value
