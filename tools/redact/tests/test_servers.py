"""Tests for HTTP and MCP server handlers."""

import io
import json
import threading
import unittest
import urllib.request
import urllib.error
from http.server import HTTPServer

from myrmidon_redact.engine import RedactEngine
from myrmidon_redact.mcp_server import MCPServer
from myrmidon_redact.http_server import RedactHTTPRequestHandler


class TestServers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = RedactEngine()
        RedactHTTPRequestHandler.engine = cls.engine
        cls.httpd = HTTPServer(("127.0.0.1", 0), RedactHTTPRequestHandler)
        cls.port = cls.httpd.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.server_thread.join(timeout=2.0)

    def setUp(self):
        self.mcp = MCPServer(self.engine)

    # ------------------ HTTP Server Tests ------------------

    def test_http_healthz(self):
        req = urllib.request.Request(f"{self.base_url}/healthz")
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data.get("status"), "ok")
            self.assertEqual(data.get("service"), "myrmidon-redact")
            self.assertEqual(data.get("version"), "1.7.0")

    def test_http_redact_and_restore(self):
        original_text = "Договор ООО Альфа ИНН 7707083893 карта 4532015112830366"
        redact_body = json.dumps({
            "text": original_text,
            "mode": "mask",
            "reversible": True,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/redact",
            data=redact_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["flagged"])
            masked_text = data["text"]
            self.assertIn("<SUB:INN:", masked_text)
            self.assertIn("<SUB:BANK_CARD:", masked_text)

        # Restore
        restore_body = json.dumps({
            "text": masked_text,
        }).encode("utf-8")
        restore_req = urllib.request.Request(
            f"{self.base_url}/restore",
            data=restore_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(restore_req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            restore_data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(restore_data["text"], original_text)

    def test_http_scan(self):
        scan_body = json.dumps({
            "text": "Реквизиты: БИК 044525225, счет 40702810938000012345",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/scan",
            data=scan_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["flagged"])
            self.assertGreater(data["score"], 0.8)
            types = [m["entity_type"] for m in data["matches"]]
            self.assertIn("BIC", types)
            self.assertIn("BANK_ACCOUNT", types)

    def test_http_bad_request_and_not_found(self):
        bad_req = urllib.request.Request(
            f"{self.base_url}/redact",
            data=json.dumps({"invalid_field": 123}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(bad_req, timeout=5)
        self.assertEqual(ctx.exception.code, 400)

        not_found_req = urllib.request.Request(f"{self.base_url}/nonexistent")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(not_found_req, timeout=5)
        self.assertEqual(ctx.exception.code, 404)

    # ------------------ MCP Server Tests ------------------

    def test_mcp_initialize_and_tools_list(self):
        init_req = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
        init_resp = self.mcp.handle_request(init_req)
        self.assertEqual(init_resp["result"]["serverInfo"]["name"], "myrmidon-redact")

        list_req = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
        list_resp = self.mcp.handle_request(list_req)
        tool_names = [t["name"] for t in list_resp["result"]["tools"]]
        self.assertIn("redact_text", tool_names)
        self.assertIn("restore_text", tool_names)
        self.assertIn("scan_text", tool_names)

    def test_mcp_call_tool(self):
        call_req = {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "redact_text",
                "arguments": {
                    "text": "Номер карты: 4532015112830366",
                    "mode": "mask",
                    "reversible": True,
                },
            },
        }
        resp = self.mcp.handle_request(call_req)
        content = json.loads(resp["result"]["content"][0]["text"])
        self.assertIn("<SUB:BANK_CARD:", content["text"])
        self.assertTrue(content["flagged"])

        # Test restore
        restore_req = {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "restore_text",
                "arguments": {
                    "text": content["text"],
                    "tokens": content["tokens"],
                },
            },
        }
        restore_resp = self.mcp.handle_request(restore_req)
        restore_content = json.loads(restore_resp["result"]["content"][0]["text"])
        self.assertEqual(restore_content["text"], "Номер карты: 4532015112830366")

        # Test scan_text
        scan_req = {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "scan_text",
                "arguments": {
                    "text": "ИНН компании 7707083893",
                },
            },
        }
        scan_resp = self.mcp.handle_request(scan_req)
        scan_content = json.loads(scan_resp["result"]["content"][0]["text"])
        self.assertTrue(scan_content["flagged"])
        self.assertEqual(scan_content["matches"][0]["entity_type"], "INN")

    def test_mcp_unknown_method_and_stdio(self):
        unknown_req = {"jsonrpc": "2.0", "id": 99, "method": "unknown/method", "params": {}}
        resp = self.mcp.handle_request(unknown_req)
        self.assertIn("error", resp)
        self.assertEqual(resp["error"]["code"], -32601)


if __name__ == "__main__":
    unittest.main()
