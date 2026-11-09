"""Unit tests for LiteLLM Guardrail adapter."""

import unittest
from myrmidon_redact.litellm_guardrail import LiteLLMRedactGuardrail


class TestLiteLLMGuardrail(unittest.TestCase):
    def test_pre_call_flag_mode_does_not_block(self):
        guardrail = LiteLLMRedactGuardrail(mode="flag")
        prompt = "Клиент с ИНН 7707083893 запросил выписку"
        mod_prompt, _, meta = guardrail.pre_call_hook(user_prompt=prompt)
        self.assertEqual(mod_prompt, prompt)
        self.assertTrue(meta["flagged"])
        self.assertGreater(meta["score"], 0.9)

    def test_pre_call_mask_mode_replaces_and_restores(self):
        guardrail = LiteLLMRedactGuardrail(mode="mask", reversible=True)
        prompt = "Номер карты клиента 4532015112830366."
        mod_prompt, _, meta = guardrail.pre_call_hook(user_prompt=prompt)
        self.assertNotIn("4532015112830366", mod_prompt)
        self.assertIn("<SUB:BANK_CARD:", mod_prompt)

        # Simulate LLM echoing back the substituted prompt
        llm_response = f"Обработан {mod_prompt}"
        restored = guardrail.post_call_success_hook(llm_response, tokens=meta.get("tokens"))
        self.assertIn("4532015112830366", restored)
        self.assertEqual(restored, f"Обработан {prompt}")

    def test_pre_call_block_mode_raises_on_sensitive_data(self):
        guardrail = LiteLLMRedactGuardrail(mode="block", threshold=0.8)
        prompt = "Утечка ключа token: my_secret_token_123456"
        with self.assertRaises(ValueError) as ctx:
            guardrail.pre_call_hook(user_prompt=prompt)
        self.assertIn("blocked by guardrail", str(ctx.exception).lower())

    def test_pre_call_block_mode_allows_benign_prompt(self):
        guardrail = LiteLLMRedactGuardrail(mode="block", threshold=0.8)
        prompt = "Какая сегодня погода в Санкт-Петербурге?"
        mod_prompt, _, meta = guardrail.pre_call_hook(user_prompt=prompt)
        self.assertEqual(mod_prompt, prompt)
        self.assertFalse(meta["flagged"])
        self.assertEqual(meta["score"], 0.0)


if __name__ == "__main__":
    unittest.main()
