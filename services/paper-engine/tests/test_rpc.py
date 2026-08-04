from __future__ import annotations

import io
import json

from p2i_engine.models import JobStatus, ProgressEvent
from p2i_engine.rpc.server import RpcServer, serve


def test_rpc_ping_returns_versioned_pong() -> None:
    source = io.StringIO('{"jsonrpc":"2.0","id":7,"method":"ping"}\n')
    output = io.StringIO()

    serve(source, output)

    response = json.loads(output.getvalue())
    assert response["id"] == 7
    assert response["result"]["pong"] is True
    assert response["result"]["version"] == "0.1.31"


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
