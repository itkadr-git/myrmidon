"""MCP Server for Myrmidon REDACT.

Provides tools for AI agent containers via standard Model Context Protocol (MCP) JSON-RPC over stdio.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict, List, Optional

from .engine import RedactEngine

TOOLS_DEFINITIONS = [
    {
        "name": "redact_text",
        "description": "Mask or detect sensitive data (PII, legal entity requisites, banking details, secrets) in text.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The input text to redact"},
                "mode": {
                    "type": "string",
                    "enum": ["mask", "flag", "block"],
                    "default": "mask",
                    "description": "Redaction mode: 'mask' (replace), 'flag' (detect only), or 'block'",
                },
                "reversible": {
                    "type": "boolean",
                    "default": False,
                    "description": "If true, generates reversible tokens stored in TTL store",
                },
                "ttl_seconds": {
                    "type": "integer",
                    "default": 3600,
                    "description": "Time to live for reversible substitution mapping",
                },
                "counterparties": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of counterparty names to mask",
                },
                "signatories": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of signatory names to mask",
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "restore_text",
        "description": "Restore reversibly masked text back to original form using token mappings.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "Text with reversible substitution tokens"},
                "tokens": {
                    "type": "object",
                    "description": "Optional mapping of token -> original value",
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "scan_text",
        "description": "Scan text for sensitive entities and return detections with confidence scores.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The text to scan"},
                "counterparties": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional counterparty names",
                },
                "signatories": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional signatory names",
                },
            },
            "required": ["text"],
        },
    },
]


class MCPServer:
    def __init__(self, engine: Optional[RedactEngine] = None):
        self.engine = engine or RedactEngine()

    def handle_request(self, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        msg_id = request.get("id")
        method = request.get("method")
        params = request.get("params", {})

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "myrmidon-redact", "version": "1.7.0"},
                },
            }

        elif method == "notifications/initialized":
            return None

        elif method == "tools/list":
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"tools": TOOLS_DEFINITIONS},
            }

        elif method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments", {})
            result = self.call_tool(name, arguments)
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]},
            }

        else:
            if msg_id is not None:
                return {
                    "jsonrpc": "2.0",
                    "id": msg_id,
                    "error": {"code": -32601, "message": f"Method {method} not found"},
                }
            return None

    def call_tool(self, name: str, args: Dict[str, Any]) -> Any:
        if name == "redact_text":
            text = args["text"]
            mode = args.get("mode", "mask")
            reversible = bool(args.get("reversible", False))
            ttl = int(args.get("ttl_seconds", 3600))
            counterparties = args.get("counterparties")
            signatories = args.get("signatories")

            res = self.engine.redact(
                text=text,
                mode=mode,
                reversible=reversible,
                ttl_seconds=ttl,
                counterparties=counterparties,
                signatories=signatories,
            )
            return res.to_dict()

        elif name == "restore_text":
            text = args["text"]
            tokens = args.get("tokens")
            restored = self.engine.restore(text, tokens=tokens)
            return {"text": restored}

        elif name == "scan_text":
            text = args["text"]
            counterparties = args.get("counterparties")
            signatories = args.get("signatories")
            matches = self.engine.scan(
                text=text,
                counterparties=counterparties,
                signatories=signatories,
            )
            score = max((m.score for m in matches), default=0.0)
            return {
                "matches": [m.to_dict() for m in matches],
                "score": score,
                "flagged": len(matches) > 0,
            }
        else:
            raise ValueError(f"Unknown tool: {name}")

    def run_stdio(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                resp = self.handle_request(req)
                if resp is not None:
                    sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
                    sys.stdout.flush()
            except Exception as e:
                err_resp = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32603, "message": str(e)},
                }
                sys.stdout.write(json.dumps(err_resp, ensure_ascii=False) + "\n")
                sys.stdout.flush()
