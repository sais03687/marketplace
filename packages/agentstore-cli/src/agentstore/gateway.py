"""A local stand-in for the platform's model gateway.

On the platform, every model call goes through a gateway that runs the model the
manifest declares, whatever name the code passed. Testing without that would
give a different answer locally than in production — or fail outright, since a
name like "gpt-4o" means nothing to OpenRouter. This does the same rewrite on
the creator's machine, with the creator's own key, and counts the calls.
"""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Gateway:
    def __init__(self, upstream: str, model: str | None, rewrite: bool | None = None):
        self.upstream = upstream.rstrip("/")
        # Rewriting only makes sense where model ids are OpenRouter's vendor/model.
        if rewrite is None:
            rewrite = "openrouter.ai" in self.upstream
        self.model = model if model and rewrite else None
        self.calls: list[dict] = []
        self._server: ThreadingHTTPServer | None = None

    @property
    def url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def start(self) -> "Gateway":
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep the creator's terminal clean
                pass

            def _forward(self, body: bytes | None) -> None:
                asked = None
                if body:
                    try:
                        payload = json.loads(body)
                        if isinstance(payload, dict) and "model" in payload:
                            asked = payload.get("model")
                            if gateway.model:
                                payload["model"] = gateway.model
                            body = json.dumps(payload).encode()
                    except json.JSONDecodeError:
                        pass
                headers = {k: v for k, v in self.headers.items()
                           if k.lower() in ("authorization", "content-type", "accept")}
                headers["X-Title"] = "agentstore test"
                req = urllib.request.Request(gateway.upstream + self.path, data=body,
                                             headers=headers, method=self.command)
                record = {"asked": asked, "ran": gateway.model or asked, "status": None, "tokens": None}
                try:
                    with urllib.request.urlopen(req, timeout=300) as resp:
                        status, data, ctype = resp.status, resp.read(), resp.headers.get("Content-Type", "")
                except urllib.error.HTTPError as e:
                    status, data, ctype = e.code, e.read(), e.headers.get("Content-Type", "")
                except Exception as e:  # network down, DNS, timeout
                    status, data, ctype = 502, json.dumps({"error": {"message": str(e)}}).encode(), "application/json"
                record["status"] = status
                try:
                    record["tokens"] = (json.loads(data).get("usage") or {}).get("total_tokens")
                except Exception:
                    pass
                gateway.calls.append(record)
                self.send_response(status)
                self.send_header("Content-Type", ctype or "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                self._forward(self.rfile.read(length) if length else None)

            def do_GET(self):
                self._forward(None)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
