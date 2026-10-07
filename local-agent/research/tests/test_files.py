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


def test_file_read_range_is_bounded_and_numbered(project):
    root, grants = project
    result = grants.read_file("hello.py", 2, 1)
    assert result["text"] == "2: print('hello')"
    assert result["total_lines"] == 3
    assert result["truncated"]


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
    assert result["text"] == "199999: bounded fixture\n200000: bounded fixture"


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
        pieces.append(result["text"].removeprefix("1: "))
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
    assert second["start_line"] == 1 and second["start_column"] == 498
    assert second["text"] == "1: " + "x" * 103 + "\n2: last"
    assert second["eof"]


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
