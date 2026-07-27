from __future__ import annotations

import json
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import Future
from typing import Any, TextIO

from .. import __version__
from ..library import Library
from ..models import ProgressEvent


class RpcServer:
    def __init__(self, input_stream: TextIO, output_stream: TextIO):
        self.input = input_stream
        self.output = output_stream
        self.output_lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="p2i-rpc")
        self.shutdown = threading.Event()
        self.libraries: dict[str, Library] = {}
        self.host_pending: dict[str, Future] = {}
        self.host_pending_lock = threading.Lock()

    def send(self, payload: dict[str, Any]) -> None:
        # JSON-RPC is a wire protocol. ASCII escaping keeps every response valid
        # UTF-8 even when a frozen Windows Python process inherited a legacy code page.
        encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
        with self.output_lock:
            self.output.write(encoded + "\n")
            self.output.flush()

    def notify_progress(self, event: ProgressEvent) -> None:
        self.send(
            {
                "jsonrpc": "2.0",
                "method": "job.progress",
                "params": {
                    "requestId": event.request_id,
                    "jobId": event.job_id,
                    "paperId": event.paper_id,
                    "status": event.status.value,
                    "progress": event.progress,
                    "message": event.message,
                },
            }
        )

    def library(self, root: str) -> Library:
        if root not in self.libraries:
            self.libraries[root] = Library(root, ocr_page=self.ocr_page)
        return self.libraries[root]

    def host_call(self, method: str, params: dict[str, Any], timeout: float = 100) -> Any:
        request_id = f"host-{uuid.uuid4()}"
        future: Future = Future()
        with self.host_pending_lock:
            self.host_pending[request_id] = future
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        try:
            response = future.result(timeout=timeout)
        finally:
            with self.host_pending_lock:
                self.host_pending.pop(request_id, None)
        if response.get("error"):
            raise RuntimeError(response["error"].get("message", "Host request failed"))
        return response.get("result")

    def ocr_page(self, params: dict[str, Any]) -> dict[str, Any]:
        return self.host_call("host.ocr_page", params, timeout=100)

    def dispatch(self, request: dict[str, Any]) -> Any:
        method = request.get("method")
        params = request.get("params") or {}
        request_id = request.get("id")
        if method == "ping":
            return {"pong": True, "version": __version__}
        if method == "library.initialize":
            library = self.library(params["root"])
            result = library.initialize(resume_recovered=False)
            recovered_job_ids = library.take_recovered_job_ids()
            if recovered_job_ids:
                self.executor.submit(
                    library.run_queued_jobs,
                    recovered_job_ids,
                    self.notify_progress,
                    request_id,
                )
            return result
        if method == "library.scan":
            return self.library(params["root"]).scan(
                self.notify_progress,
                request_id,
                bool(params.get("requireStable", False)),
            )
        if method == "library.list":
            return self.library(params["root"]).list_papers()
        if method == "library.file_events":
            return self.library(params["root"]).apply_file_events(
                params.get("events", []), self.notify_progress, request_id
            )
        if method == "job.list":
            return self.library(params["root"]).list_jobs()
        if method == "job.cancel":
            return {
                "cancelled": self.library(params["root"]).cancel_job(params["jobId"])
            }
        if method == "job.retry":
            return self.library(params["root"]).retry_job(
                params["jobId"], self.notify_progress, request_id
            )
        if method == "paper.reparse":
            return self.library(params["root"]).reparse_paper(
                params["paperId"], self.notify_progress, request_id
            )
        if method == "paper.read_markdown":
            return {
                "markdown": self.library(params["root"]).read_markdown(params["paperId"])
            }
        if method == "paper.read_document":
            return self.library(params["root"]).read_document(params["paperId"])
        if method == "paper.read_references":
            return self.library(params["root"]).read_references(params["paperId"])
        if method == "graph.build":
            return self.library(params["root"]).build_citation_graph(
                params["paperId"], int(params.get("maxDepth", 2)), bool(params.get("force", False))
            )
        if method == "translation.list":
            return self.library(params["root"]).list_translations(params["paperId"])
        if method == "translation.save":
            return self.library(params["root"]).save_translation(params)
        if method == "context.get":
            return self.library(params["root"]).get_context_draft()
        if method == "context.add_paper":
            return self.library(params["root"]).add_paper_to_context(
                params["paperId"], params.get("mode", "full")
            )
        if method == "context.add_selection":
            return self.library(params["root"]).add_selection_to_context(params)
        if method == "context.read_item":
            return self.library(params["root"]).read_context_item(params["itemId"])
        if method == "context.get_compression":
            return self.library(params["root"]).get_context_compression(
                params["itemId"], params["modelId"], params["promptVersion"]
            )
        if method == "context.activate_compression":
            return self.library(params["root"]).activate_context_compression(
                params["itemId"], params["modelId"], params["promptVersion"]
            )
        if method == "context.save_compression":
            return self.library(params["root"]).save_context_compression(params)
        if method == "context.remove_paper":
            return self.library(params["root"]).remove_paper_from_context(params["paperId"])
        if method == "context.clear":
            return self.library(params["root"]).clear_context()
        if method == "agent.list":
            return self.library(params["root"]).list_agent_profiles()
        if method == "agent.upsert":
            return self.library(params["root"]).upsert_agent_profile(params)
        if method == "agent.delete":
            return {
                "deleted": self.library(params["root"]).delete_agent_profile(
                    params["agentProfileId"]
                )
            }
        if method == "agent.run_list":
            return self.library(params["root"]).list_agent_runs(
                params.get("agentProfileId"), int(params.get("limit", 50))
            )
        if method == "agent.run_start":
            return self.library(params["root"]).start_agent_run(params)
        if method == "agent.run_update":
            return self.library(params["root"]).update_agent_run(params["runId"], params)
        if method == "agent.run_cancel":
            return self.library(params["root"]).cancel_agent_run(params["runId"])
        if method == "agent.run_retry":
            return self.library(params["root"]).retry_agent_run(params["runId"])
        if method == "zotero.inspect":
            from ..zotero import ZoteroImporter

            return ZoteroImporter(params.get("dataDir")).inspect()
        if method == "zotero.preview_import":
            from ..zotero import ZoteroImporter

            importer = ZoteroImporter(params.get("dataDir"))
            return importer.recommended_sample(importer.candidates())
        if method == "zotero.import":
            library = self.library(params["root"])
            result = library.import_zotero(
                params.get("candidates", []),
                params.get("dataDir"),
                self.notify_progress,
                request_id,
            )
            job_ids = result.get("jobIds", [])
            if job_ids:
                self.executor.submit(
                    library.run_queued_jobs,
                    job_ids,
                    self.notify_progress,
                    request_id,
                )
            return result
        if method == "component.status":
            import importlib.util

            return {
                "docling": {"available": importlib.util.find_spec("docling") is not None},
                "pymupdf": {"available": importlib.util.find_spec("fitz") is not None},
                "qwenOcr": {"available": True, "model": "qwen3.5-ocr", "requiresCredential": True},
            }
        if method == "shutdown":
            self.shutdown.set()
            return {"shutdown": True}
        raise KeyError(f"Unknown method: {method}")

    def handle(self, request: dict[str, Any]) -> None:
        request_id = request.get("id")
        try:
            result = self.dispatch(request)
            if request_id is not None:
                self.send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except Exception as error:
            if request_id is not None:
                self.send(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {
                            "code": -32603,
                            "message": str(error),
                            "data": {"type": type(error).__name__},
                        },
                    }
                )

    def run(self) -> None:
        for line in self.input:
            if self.shutdown.is_set():
                break
            # PowerShell 5 may send a UTF-8 BOM through a local Windows code page.
            line = line.lstrip("\ufeff\u9518\u7e36")
            try:
                request = json.loads(line)
            except json.JSONDecodeError as error:
                self.send(
                    {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32700, "message": str(error)},
                    }
                )
                continue
            if "method" not in request and request.get("id") is not None:
                with self.host_pending_lock:
                    future = self.host_pending.get(str(request["id"]))
                if future and not future.done():
                    future.set_result(request)
                    continue
            self.executor.submit(self.handle, request)
        self.executor.shutdown(wait=True, cancel_futures=False)


def serve(input_stream: TextIO = sys.stdin, output_stream: TextIO = sys.stdout) -> None:
    RpcServer(input_stream, output_stream).run()
