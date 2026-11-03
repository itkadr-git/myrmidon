"""HTTP service for Myrmidon REDACT.

Provides /healthz, /redact, /restore, and /scan endpoints.
Implements a production-ready HTTP server using Python standard library.
"""

from __future__ import annotations

import json
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any, Dict, Optional

from .engine import RedactEngine, RedactMode

logger = logging.getLogger("myrmidon_redact.http")


class RedactHTTPRequestHandler(BaseHTTPRequestHandler):
    engine: RedactEngine = RedactEngine()

    def _send_json(self, status_code: int, data: Dict[str, Any]) -> None:
        payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json_body(self) -> Optional[Dict[str, Any]]:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            return None
        body = self.rfile.read(content_length).decode("utf-8")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return None

    def do_GET(self) -> None:
        if self.path in ("/healthz", "/health"):
            self._send_json(200, {
                "status": "ok",
                "service": "myrmidon-redact",
                "version": "1.7.0",
            })
        else:
            self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        if path == "/redact":
            body = self._read_json_body()
            if body is None or "text" not in body:
                self._send_json(400, {"error": "Missing 'text' in JSON body"})
                return

            text = body["text"]
            mode = body.get("mode", "mask")
            reversible = bool(body.get("reversible", False))
            ttl = int(body.get("ttl_seconds", 3600))
            counterparties = body.get("counterparties")
            signatories = body.get("signatories")
            contract_patterns = body.get("contract_patterns")

            res = self.engine.redact(
                text=text,
                mode=mode,
                reversible=reversible,
                ttl_seconds=ttl,
                counterparties=counterparties,
                signatories=signatories,
                contract_patterns=contract_patterns,
            )
            self._send_json(200, res.to_dict())

        elif path == "/restore":
            body = self._read_json_body()
            if body is None or "text" not in body:
                self._send_json(400, {"error": "Missing 'text' in JSON body"})
                return

            text = body["text"]
            tokens = body.get("tokens")
            restored = self.engine.restore(text, tokens=tokens)
            self._send_json(200, {"text": restored})

        elif path == "/scan":
            body = self._read_json_body()
            if body is None or "text" not in body:
                self._send_json(400, {"error": "Missing 'text' in JSON body"})
                return

            text = body["text"]
            counterparties = body.get("counterparties")
            signatories = body.get("signatories")
            contract_patterns = body.get("contract_patterns")

            matches = self.engine.scan(
                text=text,
                counterparties=counterparties,
                signatories=signatories,
                contract_patterns=contract_patterns,
            )
            score = max((m.score for m in matches), default=0.0)
            self._send_json(200, {
                "matches": [m.to_dict() for m in matches],
                "score": score,
                "flagged": len(matches) > 0,
            })

        else:
            self._send_json(404, {"error": "not_found"})

    def log_message(self, format: str, *args: Any) -> None:
        # Avoid cluttering console output
        pass


def run_server(host: str = "0.0.0.0", port: int = 8080) -> None:
    server_address = (host, port)
    httpd = HTTPServer(server_address, RedactHTTPRequestHandler)
    print(f"Myrmidon REDACT server listening on {host}:{port}")
    httpd.serve_forever()
