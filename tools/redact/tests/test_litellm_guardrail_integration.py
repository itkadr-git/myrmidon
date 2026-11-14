"""Integration tests: the adapter against a fake LiteLLM request flow.

Acceptance criteria (OPE: LiteLLM guardrail adapter):
- block by score >= threshold, pass below it;
- flag mode never changes the payload and never blocks;
- the async hook variants behave like the sync ones.
"""

import asyncio
import unittest

from myrmidon_redact.litellm_guardrail import LiteLLMRedactGuardrail

SENSITIVE_MESSAGES = [
    {"role": "system", "content": "Ты помощник оператора."},
    {"role": "user", "content": "Паспорт 4517 123456, карта клиента 4532015112830366."},
]
BENIGN_MESSAGES = [
    {"role": "system", "content": "Ты помощник оператора."},
    {"role": "user", "content": "Созвон в 15:00 по проекту."},
]


class TestLiteLLMGuardrailFakeRequestFlow(unittest.TestCase):
    def test_block_mode_blocks_messages_flow_at_or_above_threshold(self):
        guardrail = LiteLLMRedactGuardrail(mode="block", threshold=0.8)
        with self.assertRaises(ValueError) as ctx:
            guardrail.pre_call_hook(messages=[dict(m) for m in SENSITIVE_MESSAGES])
        self.assertIn("blocked by guardrail", str(ctx.exception))

    def test_block_mode_passes_messages_flow_below_threshold(self):
        guardrail = LiteLLMRedactGuardrail(mode="block", threshold=0.8)
        payload = [dict(m) for m in BENIGN_MESSAGES]
        _, messages, meta = guardrail.pre_call_hook(messages=payload)
        self.assertLess(meta["score"], 0.8)
        self.assertEqual(messages[1]["content"], BENIGN_MESSAGES[1]["content"])

    def test_flag_mode_never_changes_messages_payload(self):
        guardrail = LiteLLMRedactGuardrail(mode="flag")
        payload = [dict(m) for m in SENSITIVE_MESSAGES]
        _, messages, meta = guardrail.pre_call_hook(messages=payload)
        self.assertTrue(meta["flagged"])
        self.assertEqual([m["content"] for m in messages], [m["content"] for m in SENSITIVE_MESSAGES])

    def test_async_hooks_match_sync_behavior(self):
        guardrail = LiteLLMRedactGuardrail(mode="block", threshold=0.8)
        with self.assertRaises(ValueError):
            asyncio.run(guardrail.async_pre_call_hook(user_prompt="token: my_secret_token_123456"))
        _, _, meta = asyncio.run(
            guardrail.async_pre_call_hook(messages=[dict(m) for m in BENIGN_MESSAGES])
        )
        self.assertLess(meta["score"], 0.8)
        restored = asyncio.run(
            guardrail.async_post_call_success_hook(response_text="plain answer", tokens={})
        )
        self.assertEqual(restored, "plain answer")


if __name__ == "__main__":
    unittest.main()
