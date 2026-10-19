import os
import hashlib
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, DecodedStreamObject, NameObject

from local_agent_research.errors import ToolError
from local_agent_research.files import Grants


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "hello.py").write_text("first line\nprint('hello')\nlast line\n")
    return root, Grants((root,))


def test_file_read_range_is_bounded_with_locations_separate(project):
    root, grants = project
    result = grants.read_file("hello.py", 2, 1)
    assert result["text"] == "print('hello')\n"
    assert result["start_line"] == 2 and result["end_line"] == 3
    assert result["start_byte"] == len(b"first line\n")
    assert result["end_byte"] == len(b"first line\nprint('hello')\n")
    assert result["total_lines"] == 3
    assert result["truncated"]


@pytest.mark.parametrize("extension", ["mjs", "cjs", "mts", "cts"])
def test_javascript_and_typescript_module_sources_read_exactly_and_are_discoverable(project, extension):
    root, grants = project
    text = "\ufeff// 1: literal prefix\r\nexport const message = 'سلام 🌍';\r\n"
    payload = text.encode("utf-8")
    source = root / f"module.{extension}"
    source.write_bytes(payload)
    inspection = grants.inspect_file(source.name)
    result = grants.read_file(source.name, expected_sha256=inspection["sha256"])
    assert inspection["kind"] == "text"
    assert inspection["sha256"] == hashlib.sha256(payload).hexdigest()
    assert result["text"] == text and result["text"].encode("utf-8") == payload
    assert result["eof"] and result["start_byte"] == 0 and result["end_byte"] == len(payload)
    assert str(source) in grants.list_files(str(root))["files"]
    matches = grants.search_files(str(root), "export const message")["matches"]
    assert len(matches) == 1 and matches[0]["line"] == 2


@pytest.mark.parametrize("extension", ["mjs", "cjs", "mts", "cts"])
def test_module_extensions_do_not_bypass_sensitive_file_guards(project, extension):
    root, grants = project
    source = root / f".env.settings.{extension}"
    source.write_text("export const privateValue = 'not-readable';\n", encoding="utf-8")
    with pytest.raises(ToolError) as error:
        grants.read_file(source.name)
    assert error.value.code == "sensitive_file_denied"
    assert str(source) not in grants.list_files(str(root))["files"]


@pytest.mark.parametrize("extension", ["php", "phtml"])
def test_wordpress_php_sources_can_be_read_listed_and_searched(project, extension):
    root, grants = project
    source = root / f"functions.{extension}"
    source.write_text("<?php\nfunction local_agent_theme_setup() {}\n")
    assert "local_agent_theme_setup" in grants.read_file(source.name)["text"]
    assert str(source) in grants.list_files(str(root))["files"]
    matches = grants.search_files(str(root), "local_agent_theme_setup")["matches"]
    assert len(matches) == 1
    assert matches[0]["line"] == 2


@pytest.mark.parametrize("requested", ["../outside.txt", "/etc/passwd", "hello.py/../../outside.txt"])
def test_no_path_escape(project, requested):
    _, grants = project
    with pytest.raises(ToolError):
        grants.read_file(requested)


def test_symlink_escape_denied(project, tmp_path):
    root, grants = project
    outside = tmp_path / "outside.txt"
    outside.write_text("private")
    try:
        (root / "link.txt").symlink_to(outside)
    except OSError:
        pytest.skip("This Windows runner does not grant symlink creation")
    with pytest.raises(ToolError, match="Symbolic links"):
        grants.read_file("link.txt")


def test_directory_symlink_is_not_walked(project, tmp_path):
    root, grants = project
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("private")
    try:
        (root / "other").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("This Windows runner does not grant symlink creation")
    assert grants.list_files(str(root))["files"] == [str(root / "hello.py")]


@pytest.mark.skipif(os.open not in os.supports_dir_fd, reason="POSIX descriptor traversal")
def test_symlink_replacement_between_validation_and_open_denied(project, tmp_path, monkeypatch):
    root, grants = project
    folder = root / "nested"
    folder.mkdir()
    (folder / "document.txt").write_text("granted content")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "document.txt").write_text("private content")
    original = grants.locate

    def replace_after_validation(requested):
        located = original(requested)
        folder.rename(root / "saved")
        folder.symlink_to(outside, target_is_directory=True)
        return located

    monkeypatch.setattr(grants, "locate", replace_after_validation)
    with pytest.raises(ToolError):
        grants.read_file("nested/document.txt")


@pytest.mark.parametrize("name", [".env", ".env.production", "credentials.json", "private.key"])
def test_credentials_denied_even_when_selected(project, name):
    root, _ = project
    sensitive = root / name
    sensitive.write_text("secret")
    grants = Grants(files=(sensitive,))
    with pytest.raises(ToolError) as error:
        grants.read_file(str(sensitive))
    assert error.value.code == "sensitive_file_denied"


def test_explicit_file_grant_is_not_directory_grant(project):
    root, _ = project
    grants = Grants(files=(root / "hello.py",))
    assert grants.read_file(str(root / "hello.py"))["ok"]
    with pytest.raises(ToolError):
        grants.list_files(str(root))


def test_credential_directory_cannot_be_granted(tmp_path):
    root = tmp_path / ".aws"
    root.mkdir()
    (root / "config.ini").write_text("private configuration")
    with pytest.raises(ToolError) as error:
        Grants((root,)).read_file("config.ini")
    assert error.value.code == "sensitive_file_denied"


def test_secret_and_dependency_paths_omitted(project):
    root, grants = project
    (root / ".env").write_text("print('hello')")
    dependency = root / "node_modules"
    dependency.mkdir()
    (dependency / "vendor.js").write_text("hello")
    result = grants.search_files(str(root), "hello")
    assert len(result["matches"]) == 1
    assert result["matches"][0]["line"] == 2


def test_no_grant_and_bad_environment_fail_closed(monkeypatch):
    with pytest.raises(ToolError):
        Grants().read_file("hello.py")
    monkeypatch.setenv("LOCAL_AGENT_GRANTED_ROOTS", '["relative"]')
    with pytest.raises(ToolError) as error:
        Grants.from_env()
    assert error.value.code == "invalid_grants"


def write_pdf(path: Path, text: bool):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    if text:
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 50 700 Td (Local document example) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(path)


def test_pdf_text_has_page_label(project):
    root, grants = project
    write_pdf(root / "document.pdf", True)
    result = grants.read_pdf("document.pdf")
    assert result["ok"]
    assert result["pages"][0] == {"page": 1, "label": "1", "text": "Local document example", "text_found": True, "start_char": 0}


def test_scan_pdf_reports_unsupported(project):
    root, grants = project
    write_pdf(root / "scan.pdf", False)
    result = grants.read_pdf("scan.pdf")
    assert not result["ok"]
    assert result["error"] == "scanned_pdf_unsupported"


def test_pdf_page_range(project):
    root, grants = project
    write_pdf(root / "document.pdf", True)
    with pytest.raises(ToolError) as error:
        grants.read_pdf("document.pdf", 2)
    assert error.value.code == "invalid_range"


def test_large_text_streams_beyond_previous_two_mb_limit(project):
    root, grants = project
    path = root / "large.txt"
    payload = b"bounded fixture\n" * 200_000
    path.write_bytes(payload)
    inspected = grants.inspect_file("large.txt")
    assert inspected["size"] > 2 * 1024 * 1024
    assert inspected["sha256"] == hashlib.sha256(payload).hexdigest()
    result = grants.read_file("large.txt", 199_999, 2, expected_sha256=inspected["sha256"])
    assert result["eof"] and result["total_lines"] == 200_000
    assert result["text"] == "bounded fixture\nbounded fixture\n"


def test_long_utf8_line_can_continue_without_loss(project, monkeypatch):
    root, grants = project
    monkeypatch.setenv("LOCAL_AGENT_TOOL_RESULT_CHARS", "500")
    original = "😀aé界" * 1400
    (root / "line.txt").write_text(original, encoding="utf-8")
    cursor, pieces, expected_column = None, [], 1
    while True:
        result = grants.read_file("line.txt", cursor=cursor)
        assert len(result["text"]) <= 500
        assert result["start_line"] == 1 and result["start_column"] == expected_column
        pieces.append(result["text"])
        expected_column += len(pieces[-1])
        cursor = result["next_cursor"]
        if result["eof"]:
            assert cursor is None
            break
    assert "".join(pieces) == original


def test_multiline_continuation_has_correct_line_and_column(project):
    root, grants = project
    (root / "line.txt").write_text("x" * 600 + "\nlast\n")
    first = grants.read_file("line.txt", max_chars=500)
    second = grants.read_file("line.txt", cursor=first["next_cursor"], max_chars=500)
    assert second["start_line"] == 1 and second["start_column"] == 501
    assert second["text"] == "x" * 100 + "\nlast\n"
    assert second["eof"]


@pytest.mark.parametrize("text", ["\ufeff1: literal\r\nسلام 🌍\r\n", "1: literal prefix\n\nlast\n", "no newline", "\r\n", "", "\ufeff"])
def test_read_file_returns_exact_utf8_bytes_not_display_labels(project, text):
    root, grants = project
    payload = text.encode("utf-8")
    (root / "exact.txt").write_bytes(payload)
    result = grants.read_file("exact.txt")
    assert result["text"] == text
    assert result["text"].encode("utf-8") == payload
    assert result["start_byte"] == 0 and result["end_byte"] == len(payload)
    assert result["sha256"] == hashlib.sha256(payload).hexdigest()
    assert result["encoding"] == "utf-8" and result["eof"]


def test_pagination_preserves_crlf_even_when_separator_crosses_budget(project):
    root, grants = project
    text = "\ufeff" + "1: " + "😀" * 494 + "x\r\n" + "سلام\r\nlast\n"
    (root / "exact.txt").write_bytes(text.encode("utf-8"))
    first = grants.read_file("exact.txt", max_chars=500)
    second = grants.read_file("exact.txt", max_chars=500, cursor=first["next_cursor"])
    assert first["text"].endswith("\r")
    assert second["text"].startswith("\n")
    assert first["text"] + second["text"] == text
    assert second["start_byte"] == first["end_byte"]
    assert second["start_line"] == 1 and second["start_column"] == 501
    assert second["end_line"] == 4 and second["end_column"] == 1
    assert second["eof"]


@pytest.mark.parametrize("budget", [500, 501, 1000])
def test_mixed_line_and_column_pagination_concatenates_exact_source(project, budget):
    root, grants = project
    text = "\ufeff1: literal\r\n" + "😀سلامé界" * 243 + "\n\n" + "last\r\n" + "final" * 200
    payload = text.encode("utf-8")
    (root / "exact.txt").write_bytes(payload)
    cursor, pieces, offset = None, [], 0
    for _ in range(100):
        result = grants.read_file("exact.txt", max_chars=budget, max_lines=2, cursor=cursor)
        assert len(result["text"]) <= budget
        assert result["start_byte"] == offset
        assert result["text"].encode("utf-8") == payload[result["start_byte"]:result["end_byte"]]
        pieces.append(result["text"])
        offset = result["end_byte"]
        cursor = result["next_cursor"]
        if result["eof"]:
            break
        assert cursor and result["text"], "Every non-EOF read must make progress."
    assert "".join(pieces) == text
    assert offset == len(payload)


def test_changed_file_rejects_cursor_and_checkpoint(project):
    root, grants = project
    (root / "line.txt").write_text("x" * 1000)
    first = grants.read_file("line.txt", max_chars=500)
    (root / "line.txt").write_text("y" * 1000)
    for arguments in ({"cursor": first["next_cursor"]}, {"expected_sha256": first["sha256"]}):
        with pytest.raises(ToolError) as error:
            grants.read_file("line.txt", **arguments)
        assert error.value.code == "file_changed"


def test_hash_and_text_cancellation_stop_work(project):
    _, grants = project
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(ToolError) as error:
        grants.inspect_file("hello.py", cancel_event=cancelled)
    assert error.value.code == "cancelled"


def test_binary_utf8_and_invalid_cursor_fail_clearly(project):
    root, grants = project
    (root / "binary.txt").write_bytes(b"binary\x00data")
    with pytest.raises(ToolError) as error:
        grants.read_file("binary.txt")
    assert error.value.code == "unsupported_file"
    with pytest.raises(ToolError) as error:
        grants.read_file("hello.py", cursor="invalid")
    assert error.value.code == "invalid_cursor"


def test_long_pdf_page_continues_without_loss(project):
    root, grants = project
    path = root / "long.pdf"
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    original = "abcdefghij" * 123
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 50 700 Td ({original}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(path)
    cursor, pieces = None, []
    while True:
        result = grants.read_pdf("long.pdf", cursor=cursor, max_chars=500)
        assert result["ok"]
        assert result["pages"][0]["start_char"] == sum(map(len, pieces))
        pieces.append(result["pages"][0]["text"])
        cursor = result["next_cursor"]
        if result["eof"]:
            break
    assert "".join(pieces) == original


def test_pdf_worker_is_killed_on_cancellation(project, monkeypatch):
    from local_agent_research import files
    root, grants = project
    write_pdf(root / "document.pdf", True)
    cancelled, started = threading.Event(), threading.Event()
    launched = []
    original_popen = subprocess.Popen

    def slow_worker(command, **kwargs):
        process = original_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        launched.append(process)
        started.set()
        return process

    monkeypatch.setattr(files.subprocess, "Popen", slow_worker)
    errors = []
    def work():
        try:
            grants.read_pdf("document.pdf", cancel_event=cancelled)
        except ToolError as exc:
            errors.append(exc.code)
    worker = threading.Thread(target=work)
    worker.start()
    assert started.wait(5)
    cancelled.set()
    worker.join(3)
    assert not worker.is_alive()
    assert errors == ["cancelled"] and launched[0].poll() is not None


def test_pdf_worker_timeout_is_bounded_and_explained(project, monkeypatch):
    from local_agent_research import files
    root, grants = project
    write_pdf(root / "document.pdf", True)
    original_popen = subprocess.Popen
    launched = []
    def slow_worker(command, **kwargs):
        process = original_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        launched.append(process)
        return process
    monkeypatch.setattr(files.subprocess, "Popen", slow_worker)
    monkeypatch.setattr(files, "PDF_TIMEOUT_SECONDS", 0.1)
    with pytest.raises(ToolError) as error:
        grants.read_pdf("document.pdf")
    assert error.value.code == "pdf_resource_limit"
    assert "safety limit" in str(error.value)
    assert launched[0].poll() is not None


def test_pdf_worker_memory_limit_kills_process(project, monkeypatch):
    from local_agent_research import files
    root, grants = project
    write_pdf(root / "document.pdf", True)
    original_popen = subprocess.Popen
    launched = []
    def slow_worker(command, **kwargs):
        process = original_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
        launched.append(process)
        return process
    monkeypatch.setattr(files.subprocess, "Popen", slow_worker)
    monkeypatch.setattr(files, "_worker_resident_bytes", lambda pid: 1024**3 + 1)
    with pytest.raises(ToolError) as error:
        grants.read_pdf("document.pdf")
    assert error.value.code == "pdf_resource_limit"
    assert "1 GiB" in str(error.value)
    assert launched[0].poll() is not None


def test_project_search_matches_across_long_fragment_boundaries(project):
    root, grants = project
    (root / "long.txt").write_text("x" * 65_533 + "needle" + "y" * 10_000 + "\nlast")
    result = grants.search_files(str(root), "needle")
    assert len(result["matches"]) == 1
    assert result["matches"][0]["line"] == 1
    assert "needle" in result["matches"][0]["text"]


def test_host_file_read_default_preserves_exact_pages_and_explicit_hard_limit(monkeypatch, project):
    root, grants = project
    monkeypatch.setenv("LOCAL_AGENT_TOOL_RESULT_CHARS", "4000")
    monkeypatch.setenv("LOCAL_AGENT_FILE_READ_DEFAULT_CHARS", "1024")
    head = "\ufeff1: " + "😀سلام" * 200
    text = head + "x" * (1023 - len(head)) + "\r\n" + "عنوان 😀\r\n" * 40 + "z" * 5200 + "\n"
    payload = text.encode("utf-8")
    (root / "exact.txt").write_bytes(payload)
    expected_sha = hashlib.sha256(payload).hexdigest()
    first = grants.read_file("exact.txt", expected_sha256=expected_sha)
    assert len(first["text"]) == 1024 and first["text"].endswith("\r")
    assert first["truncated"] and not first["eof"] and first["next_cursor"]
    second = grants.read_file("exact.txt", cursor=first["next_cursor"], expected_sha256=expected_sha, max_chars=16000)
    assert len(second["text"]) == 4000 and second["text"].startswith("\n")
    pages = [first, second]
    for _ in range(20):
        if pages[-1]["eof"]:
            break
        pages.append(grants.read_file("exact.txt", cursor=pages[-1]["next_cursor"], expected_sha256=expected_sha))
    assert pages[-1]["eof"] and pages[-1]["next_cursor"] is None
    assert b"".join(page["text"].encode("utf-8") for page in pages) == payload
    offset = 0
    for index, page in enumerate(pages):
        assert page["sha256"] == expected_sha and page["size"] == len(payload)
        assert page["start_byte"] == offset
        prefix = payload[:offset].decode("utf-8")
        assert page["start_line"] == prefix.count("\n") + 1
        assert page["start_column"] == len(prefix.rsplit("\n", 1)[-1]) + 1
        offset += len(page["text"].encode("utf-8"))
        assert page["end_byte"] == offset
        prefix = payload[:offset].decode("utf-8")
        assert page["end_line"] == prefix.count("\n") + 1
        assert page["end_column"] == len(prefix.rsplit("\n", 1)[-1]) + 1
        if index != 1:
            assert len(page["text"]) <= 1024
    assert grants.read_file("exact.txt", max_chars=500)["text"] == text[:500]
    assert (root / "exact.txt").read_bytes() == payload


def test_absent_file_read_default_keeps_legacy_reads_and_hard_receipt_budget(monkeypatch, project):
    from local_agent_research.files import result_chars
    root, grants = project
    monkeypatch.delenv("LOCAL_AGENT_FILE_READ_DEFAULT_CHARS", raising=False)
    monkeypatch.setenv("LOCAL_AGENT_TOOL_RESULT_CHARS", "4000")
    (root / "long.txt").write_text("x" * 7000, encoding="utf-8")
    assert len(grants.read_file("long.txt")["text"]) == 4000
    monkeypatch.setenv("LOCAL_AGENT_FILE_READ_DEFAULT_CHARS", "1024")
    assert len(grants.read_file("long.txt")["text"]) == 1024
    assert len(grants.read_file("long.txt", max_chars=16000)["text"]) == 4000
    assert result_chars() == 4000 and result_chars(16000) == 4000
    with pytest.raises(ToolError) as error:
        grants.read_file("long.txt", max_chars=499)
    assert error.value.code == "invalid_limit"


@pytest.mark.parametrize("configured", ["not-an-int", "499", "4001", "True", ""])
def test_invalid_host_file_read_default_fails_before_tools_are_advertised(monkeypatch, configured):
    from local_agent_research.server import create_server
    monkeypatch.setenv("LOCAL_AGENT_TOOL_RESULT_CHARS", "4000")
    monkeypatch.setenv("LOCAL_AGENT_FILE_READ_DEFAULT_CHARS", configured)
    with pytest.raises(ToolError) as error:
        create_server(grants=Grants(()), mode="coding")
    assert error.value.code == "invalid_configuration"
