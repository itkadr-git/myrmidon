"""CLI and service entrypoint for Myrmidon REDACT."""

from __future__ import annotations

import argparse
import os
import sys

from .engine import RedactEngine
from .http_server import run_server
from .mcp_server import MCPServer


def main() -> None:
    parser = argparse.ArgumentParser(description="Myrmidon REDACT service and CLI")
    parser.add_argument("--http", action="store_true", help="Run HTTP server")
    parser.add_argument("--mcp", action="store_true", help="Run MCP server over stdio")
    parser.add_argument("--host", default=os.environ.get("REDACT_HOST", "0.0.0.0"), help="HTTP host")
    parser.add_argument("--port", type=int, default=int(os.environ.get("REDACT_PORT", "8080")), help="HTTP port")
    parser.add_argument("text", nargs="?", help="Text to scan or redact via CLI")
    parser.add_argument("--mode", choices=["mask", "flag", "block"], default="mask", help="Redaction mode")
    parser.add_argument("--reversible", action="store_true", help="Enable reversible masking")

    args = parser.parse_args()

    if args.mcp:
        server = MCPServer()
        server.run_stdio()
    elif args.http:
        run_server(host=args.host, port=args.port)
    elif args.text:
        engine = RedactEngine()
        res = engine.redact(text=args.text, mode=args.mode, reversible=args.reversible)
        print(f"Original: {args.text}")
        print(f"Redacted: {res.text}")
        print(f"Score:    {res.score:.2f}")
        print(f"Matches:  {len(res.matches)}")
        for m in res.matches:
            print(f"  - [{m.entity_type}] {m.text} (score: {m.score})")
    else:
        # Default to HTTP server if no arguments
        run_server(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
