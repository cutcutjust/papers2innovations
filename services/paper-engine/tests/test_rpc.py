from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from p2i_engine.models import JobStatus, ProgressEvent
from p2i_engine.rpc.server import RpcServer, serve


class RecordingExecutor:
    def __init__(self) -> None:
        self.submissions: list[tuple[Any, tuple[Any, ...]]] = []

    def submit(self, function: Any, *args: Any) -> None:
        self.submissions.append((function, args))


def test_rpc_ping_returns_versioned_pong() -> None:
    source = io.StringIO('{"jsonrpc":"2.0","id":7,"method":"ping"}\n')
    output = io.StringIO()

    serve(source, output)

    response = json.loads(output.getvalue())
    assert response["id"] == 7
    assert response["result"]["pong"] is True
    assert response["result"]["version"] == "0.1.35"


def test_rpc_accepts_windows_utf8_bom() -> None:
    source = io.StringIO('\ufeff{"jsonrpc":"2.0","id":9,"method":"ping"}\n')
    output = io.StringIO()

    serve(source, output)

    response = json.loads(output.getvalue())
    assert response["id"] == 9
    assert response["result"]["pong"] is True


def test_rpc_accepts_bom_mojibake_from_windows_code_page() -> None:
    source = io.StringIO('\u9518\u7e36{"jsonrpc":"2.0","id":10,"method":"ping"}\n')
    output = io.StringIO()

    serve(source, output)

    response = json.loads(output.getvalue())
    assert response["id"] == 10
    assert response["result"]["pong"] is True


def test_rpc_reports_parse_errors() -> None:
    source = io.StringIO('{"jsonrpc":"2.0","id":8,"method":"unknown"}\n')
    output = io.StringIO()

    serve(source, output)

    response = json.loads(output.getvalue())
    assert response["id"] == 8
    assert response["error"]["code"] == -32603
    assert "Unknown method" in response["error"]["message"]


def test_rpc_output_escapes_non_ascii_for_windows_pipe_compatibility() -> None:
    output = io.StringIO()
    server = RpcServer(io.StringIO(), output)

    server.send({"collection": "多模态会议语音识别"})

    encoded = output.getvalue()
    assert encoded.isascii()
    assert json.loads(encoded)["collection"] == "多模态会议语音识别"


def test_progress_notification_uses_shared_contract_fields() -> None:
    output = io.StringIO()
    server = RpcServer(io.StringIO(), output)

    server.notify_progress(
        ProgressEvent(
            request_id=3,
            job_id="job-1",
            paper_id="paper-1",
            status=JobStatus.HASHING,
            progress=0.12,
            message="Hashing",
        )
    )

    params = json.loads(output.getvalue())["params"]
    assert params["requestId"] == 3
    assert params["jobId"] == "job-1"
    assert params["paperId"] == "paper-1"


def test_library_import_paths_enqueues_without_blocking_and_resume_finds_job(
    tmp_path: Path,
) -> None:
    server = RpcServer(io.StringIO(), io.StringIO())
    server.executor.shutdown(wait=True)
    executor = RecordingExecutor()
    server.executor = executor  # type: ignore[assignment]
    root = tmp_path / "library"
    pdf = root / "Papers" / "Manual" / "paper.pdf"
    pdf.parent.mkdir(parents=True)
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")

    imported = server.dispatch(
        {
            "id": 11,
            "method": "library.import_paths",
            "params": {"root": str(root), "paths": [str(pdf)]},
        }
    )

    assert imported["enqueued"] == 1
    assert len(imported["jobIds"]) == 1
    assert len(executor.submissions) == 1
    assert executor.submissions[0][0].__name__ == "run_queued_jobs"

    resumed = server.dispatch(
        {
            "id": 12,
            "method": "library.resume_jobs",
            "params": {"root": str(root)},
        }
    )

    assert resumed == {"resumed": 1, "jobIds": imported["jobIds"]}
    assert len(executor.submissions) == 2
