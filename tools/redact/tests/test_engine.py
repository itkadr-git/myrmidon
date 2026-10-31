"""Unit tests for RedactEngine, masking modes, and reversible substitution."""

import unittest
from myrmidon_redact.engine import RedactEngine, RedactMode, SubstitutionStore


class TestEngine(unittest.TestCase):
    def setUp(self):
        self.engine = RedactEngine()

    def test_flag_mode_never_modifies_text(self):
        text = "Секретный токен token: secret_value_123456 и ИНН 7707083893"
        res = self.engine.redact(text, mode=RedactMode.FLAG)
        self.assertEqual(res.text, text)
        self.assertTrue(res.flagged)
        self.assertGreater(res.score, 0.9)
        self.assertEqual(len(res.matches), 2)

    def test_irreversible_masking(self):
        text = "Оплата на карту 4532015112830366 по договору"
        res = self.engine.redact(text, mode=RedactMode.MASK, reversible=False)
        self.assertNotIn("4532015112830366", res.text)
        self.assertIn("[REDACTED_BANK_CARD]", res.text)
        self.assertTrue(res.flagged)

    def test_reversible_masking_restores_byte_for_byte(self):
        original = (
            "Уважаемый клиент, ваш ИНН 7707083893 и счет 40702810938000012345 "
            "привязаны к e-mail client@domain.ru и карте 4532015112830366."
        )
        res = self.engine.redact(original, mode=RedactMode.MASK, reversible=True)
        # Ensure masked text contains substitution tokens and not raw sensitive values
        self.assertNotIn("7707083893", res.text)
        self.assertNotIn("4532015112830366", res.text)
        self.assertIn("<SUB:INN:", res.text)
        self.assertIn("<SUB:BANK_CARD:", res.text)

        # Restore using the store
        restored = self.engine.restore(res.text)
        self.assertEqual(restored, original)

        # Restore using explicit tokens dictionary
        restored_dict = self.engine.restore(res.text, tokens=res.tokens)
        self.assertEqual(restored_dict, original)

    def test_block_mode_threshold(self):
        sensitive = "Секрет: password: test_secret_password_123"
        benign = "Обычный текст без каких-либо чувствительных данных."

        res_sens = self.engine.redact(sensitive, mode=RedactMode.BLOCK)
        self.assertTrue(res_sens.flagged)
        self.assertGreaterEqual(res_sens.score, 0.85)

        res_benign = self.engine.redact(benign, mode=RedactMode.BLOCK)
        self.assertFalse(res_benign.flagged)
        self.assertEqual(res_benign.score, 0.0)

    def test_substitution_store_ttl_expiration(self):
        store = SubstitutionStore(default_ttl_seconds=0)  # expires immediately
        store.put("<SUB:TEST:1>", "secret_val")
        # should be None because time.time() > expires_at
        self.assertIsNone(store.get("<SUB:TEST:1>"))


if __name__ == "__main__":
    unittest.main()
