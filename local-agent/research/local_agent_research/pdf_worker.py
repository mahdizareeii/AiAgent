"""Isolated PDF extraction from the host's already guarded, seekable descriptor."""

from __future__ import annotations

import json
import os
import sys

from .errors import ToolError

_windows_job = None


def _resource_limits() -> None:
    global _windows_job
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IOCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IOCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.argtypes, kernel.CreateJobObjectW.restype = [ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes, kernel.SetInformationJobObject.restype = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.AssignProcessToJobObject.argtypes, kernel.AssignProcessToJobObject.restype = [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL
        _windows_job = kernel.CreateJobObjectW(None, None)
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x00000002 | 0x00000100  # process CPU time and process memory
        limits.BasicLimitInformation.PerProcessUserTimeLimit = 20 * 10_000_000
        limits.ProcessMemoryLimit = 1024 * 1024 * 1024
        if not _windows_job or not kernel.SetInformationJobObject(_windows_job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(_windows_job, kernel.GetCurrentProcess()):
            raise ToolError("pdf_resource_limit", "The operating system could not apply PDF worker memory limits.")
        return
    if os.name != "posix":
        return
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (20, 21))
    # Darwin's memory rlimits are unsupported on current Apple hardware. The
    # parent checks native resident memory and kills this worker at the cap.
    if sys.platform == "darwin":
        return
    limit = resource.RLIMIT_AS
    _, inherited_hard = resource.getrlimit(limit)
    ceiling = 1024 * 1024 * 1024 if inherited_hard == resource.RLIM_INFINITY else min(1024 * 1024 * 1024, inherited_hard)
    resource.setrlimit(limit, (ceiling, ceiling))


def extract(config: dict) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(sys.stdin.buffer, strict=True)
    if reader.is_encrypted:
        raise ToolError("encrypted_pdf", "Password-protected PDFs are unsupported.")
    total_pages = len(reader.pages)
    start_page, start_char = config["start_page"], config["start_char"]
    if total_pages > 100_000:
        raise ToolError("pdf_resource_limit", "This PDF exceeds the safety limit of 100000 pages. Split it first.")
    if start_page > total_pages:
        raise ToolError("invalid_range", f"The PDF contains {total_pages} pages.")
    pages, remaining = [], config["max_chars"]
    next_position = None
    labels = reader.page_labels
    for number in range(start_page - 1, min(start_page - 1 + config["max_pages"], total_pages)):
        page = reader.pages[number]
        # Avoid eagerly expanding obviously oversized compressed streams. The
        # process resource limits also bound compressed bombs and text extraction.
        contents = page.get("/Contents")
        if contents is not None:
            contents = contents.get_object()
            streams = contents if isinstance(contents, list) else [contents]
            if sum(len(getattr(part.get_object(), "_data", b"")) for part in streams) > 32 * 1024 * 1024:
                raise ToolError("pdf_page_too_large", "This page contains more than 32 MiB of encoded content. Split or simplify it first.")
        text = (page.extract_text() or "").strip()
        offset = start_char if number == start_page - 1 else 0
        if offset > len(text):
            raise ToolError("invalid_cursor", "The page continuation lies beyond its extracted text.")
        selected = text[offset:offset + remaining]
        pages.append({"page": number + 1, "label": str(labels[number]) if number < len(labels) else str(number + 1),
                      "text": selected, "text_found": bool(text), "start_char": offset})
        remaining -= len(selected)
        if offset + len(selected) < len(text):
            next_position = {"page": number + 1, "char": offset + len(selected)}
            break
        if number + 1 < total_pages:
            next_position = {"page": number + 2, "char": 0}
        else:
            next_position = None
        if not remaining:
            break
    common = {"total_pages": total_pages, "pages": pages, "next_position": next_position,
              "eof": next_position is None, "truncated": next_position is not None}
    if not any(page["text_found"] for page in pages):
        return {"ok": False, "error": "scanned_pdf_unsupported", "message": "These pages contain no extractable text. OCR is not included.", **common}
    return {"ok": True, **common}


def main() -> None:
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        _resource_limits()
        config = json.loads(sys.argv[2])
        if not isinstance(config, dict) or not 1 <= config["start_page"] <= 100_000 or not 0 <= config["start_char"] or not 1 <= config["max_pages"] <= 10 or not 500 <= config["max_chars"] <= 16_000:
            raise ToolError("invalid_range", "Invalid PDF worker range.")
        value = extract(config)
    except ToolError as exc:
        value = exc.result()
    except MemoryError:
        value = {"ok": False, "error": "pdf_resource_limit", "message": "PDF extraction exceeded the 1 GiB worker memory safety limit. Split or simplify this PDF."}
    except Exception:
        value = {"ok": False, "error": "invalid_pdf", "message": "This PDF could not be parsed safely."}
    print(json.dumps(value, ensure_ascii=True))
