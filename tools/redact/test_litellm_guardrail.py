import unittest
import asyncio
from types import SimpleNamespace

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

    def test_rd1_failure_passes_in_flag_and_mask(self):
        def failing_transport(url, payload, timeout):
            raise TimeoutError("RD1 unavailable")

        for mode in ("flag", "mask"):
            with self.subTest(mode=mode):
                guardrail = LiteLLMRedactGuardrail(
                    GuardrailConfig("http://rd1.test/scan", mode=mode),
                    transport=failing_transport,
                )
                data = {"messages": [{"content": "keep me"}]}
                self.assertEqual(
                    asyncio.run(guardrail.async_pre_call_hook("key", None, data, "pid")),
                    data,
                )

    def test_post_call_block_uses_score(self):
        guardrail = LiteLLMRedactGuardrail(
            GuardrailConfig("http://rd1.test/scan", mode="block", threshold=0.8),
            transport=self.transport,
        )
        response = {"choices": [{"message": {"content": "sensitive"}}]}
        with self.assertRaises(RedactGuardrailBlocked):
            asyncio.run(guardrail.async_post_call_success_hook({}, {}, response))

    def test_post_call_below_threshold_passes(self):
        guardrail = LiteLLMRedactGuardrail(
            GuardrailConfig("http://rd1.test/scan", mode="block", threshold=0.8),
            transport=self.transport,
        )
        response = {"choices": [{"message": {"content": "ordinary"}}]}
        self.assertIs(
            asyncio.run(guardrail.async_post_call_success_hook({}, {}, response)),
            response,
        )

    def test_post_call_mask_replaces_dict_and_object_response(self):
        def masking_transport(url, payload, timeout):
            return {"score": 0.9, "redacted_text": "[MASKED]"}

        guardrail = LiteLLMRedactGuardrail(
            GuardrailConfig("http://rd1.test/scan", mode="mask", threshold=0.8),
            transport=masking_transport,
        )
        response = {"choices": [{"message": {"content": "secret"}}]}
        masked = asyncio.run(guardrail.async_post_call_success_hook({}, {}, response))
        self.assertEqual(masked["choices"][0]["message"]["content"], "[MASKED]")
        obj = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="secret"))])
        masked_obj = asyncio.run(guardrail.async_post_call_success_hook({}, {}, obj))
        self.assertEqual(masked_obj.choices[0].message.content, "[MASKED]")

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
