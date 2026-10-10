import asyncio
import json
import os
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters, stdio_client


def parameters(mode, roots=(), utilities=None):
    frozen = os.environ.get("LOCAL_AGENT_SIDECAR_EXECUTABLE")
    return StdioServerParameters(command=frozen or sys.executable, args=[] if frozen else [str(Path(__file__).resolve().parents[1] / "sidecar.py")], env={**os.environ, "LOCAL_AGENT_MODE": mode, "LOCAL_AGENT_GRANTED_ROOTS": json.dumps([str(path.resolve()) for path in roots]), "LOCAL_AGENT_GRANTED_FILES": "[]", "LOCAL_AGENT_UTILITIES": json.dumps(utilities or {}), "LOCAL_AGENT_TOOL_RESULT_CHARS": "4000"})


def test_stdio_initialize_list_tools_and_denied_read():
    async def run():
        server = parameters("research")
        async with stdio_client(server) as (read, write):
            async with ClientSession(read, write) as client:
                initialized = await client.initialize()
                assert initialized.server_info.name == "Local Agent Research"
                listed = await client.list_tools()
                assert {tool.name for tool in listed.tools} == {"inspect_file", "read_file", "read_pdf"}
                result = await client.call_tool("read_file", {"path": "/etc/passwd"})
                assert result.structured_content["error"] == "path_denied"

    asyncio.run(run())


def test_coding_protocol_reads_granted_file_and_pdf(tmp_path):
    from pypdf import PdfWriter

    (tmp_path / "selected.txt").write_text("local fixture\n")
    pdf = PdfWriter()
    pdf.add_blank_page(width=612, height=792)
    pdf.write(tmp_path / "selected.pdf")

    async def run():
        async with stdio_client(parameters("coding", (tmp_path,))) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                listed = await client.list_tools()
                assert {tool.name for tool in listed.tools} == {"inspect_file", "read_file", "read_pdf", "list_files", "search_files"}
                result = await client.call_tool("read_file", {"path": "selected.txt"})
                assert result.structured_content["text"] == "1: local fixture"
                pdf_result = await client.call_tool("read_pdf", {"path": "selected.pdf"})
                assert pdf_result.structured_content["error"] == "scanned_pdf_unsupported"

    asyncio.run(run())


def test_assistant_exposes_no_network_or_command_tools():
    async def run():
        server = parameters("assistant")
        async with stdio_client(server) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                listed = await client.list_tools()
                assert {tool.name for tool in listed.tools} == {"inspect_file", "read_file", "read_pdf"}

    asyncio.run(run())


def test_utility_controls_exclude_disabled_tools_and_explicitly_enable_web():
    async def run():
        controls = {"fileReading": False, "projectSearch": False, "webResearch": True}
        async with stdio_client(parameters("research", utilities=controls)) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                assert {tool.name for tool in (await client.list_tools()).tools} == {"web_search", "web_fetch"}
    asyncio.run(run())


def test_coding_web_requires_opt_in_and_describes_evidence_uncertainty():
    async def run():
        async with stdio_client(parameters("coding", utilities={"webResearch": True})) as (read, write):
            async with ClientSession(read, write) as client:
                initialized = await client.initialize()
                tools = {tool.name: tool for tool in (await client.list_tools()).tools}
                assert {"web_search", "web_fetch"} <= set(tools)
                assert "searched_at" in tools["web_search"].description
                assert "not verified" in tools["web_search"].description
                assert "text_sha256" in tools["web_fetch"].description and "unverified" in tools["web_fetch"].description
                assert "not publication dates" in initialized.instructions
    asyncio.run(run())


def test_assistant_cannot_enable_web_even_with_explicit_configuration():
    async def run():
        async with stdio_client(parameters("assistant", utilities={"webResearch": True})) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                assert not {"web_search", "web_fetch"} & {tool.name for tool in (await client.list_tools()).tools}
    asyncio.run(run())


def test_protocol_long_line_cursor_and_hash(tmp_path):
    text = "a😀b" * 1000
    (tmp_path / "long.txt").write_text(text, encoding="utf-8")

    async def run():
        async with stdio_client(parameters("assistant", (tmp_path,))) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                inspection = (await client.call_tool("inspect_file", {"path": "long.txt"})).structured_content
                first = (await client.call_tool("read_file", {"path": "long.txt", "max_chars": 500, "expected_sha256": inspection["sha256"]})).structured_content
                assert not first["eof"] and first["next_cursor"]
                second = (await client.call_tool("read_file", {"path": "long.txt", "max_chars": 500, "cursor": first["next_cursor"], "expected_sha256": inspection["sha256"]})).structured_content
                assert second["start_column"] == len(first["text"]) - 3 + 1
                assert second["text"][3:] == text[497:994]
    asyncio.run(run())
