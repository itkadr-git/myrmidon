import unittest
import asyncio

from litellm_guardrail import (
    GuardrailConfig,
    LiteLLMRedactGuardrail,
    RedactGuardrailBlocked,
)


class RedactGuardrailIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def transport(url, payload, timeout):
            self.calls.append((url, payload, timeout))
            return {"score": 0.9 if "sensitive" in payload["text"] else 0.2}

        self.transport = transport

    def test_block_uses_score_not_entity_presence(self):
        guardrail = LiteLLMRedactGuardrail(
            GuardrailConfig("http://rd1.test/scan", mode="block", threshold=0.8),
            transport=self.transport,
        )
        with self.assertRaises(RedactGuardrailBlocked):
            asyncio.run(guardrail.async_pre_call_hook("key", None, {"messages": [{"content": "sensitive"}]}, "pid"))
        self.assertEqual(self.calls[0][1]["stage"], "pre_call")

    def test_score_below_threshold_passes(self):
        guardrail = LiteLLMRedactGuardrail(
            GuardrailConfig("http://rd1.test/scan", mode="block", threshold=0.8),
            transport=self.transport,
        )
        data = {"messages": [{"role": "user", "content": "ordinary"}]}
        self.assertEqual(asyncio.run(guardrail.async_pre_call_hook("key", None, data, "pid")), data)

    def test_flag_mode_does_not_change_payload(self):
        guardrail = LiteLLMRedactGuardrail(
            GuardrailConfig("http://rd1.test/scan", mode="flag", threshold=0.1),
            transport=self.transport,
        )
        data = {"messages": [{"role": "user", "content": "sensitive"}], "extra": "kept"}
        self.assertEqual(asyncio.run(guardrail.async_pre_call_hook("key", None, data, "pid")), data)
        self.assertEqual(self.calls[0][1]["mode"], "flag")

    def test_invalid_score_fails_closed(self):
        def invalid_transport(url, payload, timeout):
            return {"entities": ["email"]}

        guardrail = LiteLLMRedactGuardrail(
            GuardrailConfig("http://rd1.test/scan", mode="block"),
            transport=invalid_transport,
        )
        with self.assertRaises(ValueError):
            asyncio.run(guardrail.async_pre_call_hook("key", None, {"messages": [{"content": "sensitive"}]}, "pid"))


if __name__ == "__main__":
    unittest.main()
