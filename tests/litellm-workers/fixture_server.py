#!/usr/bin/env python3
"""Disposable board and LiteLLM HTTP fixture for the worker-resize load test."""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

state = {"workers": 2}
state_lock = threading.Lock()


class LiteLLMHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        with state_lock:
            workers = state["workers"]
        payload = {"id": "fixture", "object": "chat.completion", "model": "mock-gpt",
                   "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
                   "fixture_workers": workers}
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


class BoardHandler(BaseHTTPRequestHandler):
    def do_PUT(self):
        prefix = "/api/myrmidon/companies/fixture-company/litellm/workers"
        if self.path != prefix:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            target = json.loads(self.rfile.read(length))["target"]
            if target not in (2, 4):
                raise ValueError
        except (ValueError, KeyError, json.JSONDecodeError):
            self.send_error(400)
            return
        with state_lock:
            state["workers"] = target
            current = state["workers"]
        body = json.dumps({"view": {"target": target, "current": current, "currentSource": "gateway"},
                           "applied": True, "changed": True, "signals": [], "deliveries": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def serve(handler, port):
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


parser = argparse.ArgumentParser()
parser.add_argument("--board-port", type=int, default=3100)
parser.add_argument("--litellm-port", type=int, default=8090)
args = parser.parse_args()
threads = [threading.Thread(target=serve, args=(BoardHandler, args.board_port), daemon=True),
           threading.Thread(target=serve, args=(LiteLLMHandler, args.litellm_port), daemon=True)]
for thread in threads:
    thread.start()
threading.Event().wait()
