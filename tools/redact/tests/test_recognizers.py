"""Unit tests for individual recognizers and checksum validators."""

import unittest
from myrmidon_redact.recognizers import (
    check_inn,
    check_ogrn,
    check_snils,
    check_luhn,
    check_okpo,
    check_bank_account,
    create_default_registry,
    NestDictionaryRecognizer,
)


class TestRecognizers(unittest.TestCase):
    def setUp(self):
        self.registry = create_default_registry()

    def test_inn_validation(self):
        # Valid 10-digit legal entity INN
        self.assertTrue(check_inn("7707083893"))  # Sberbank
        self.assertTrue(check_inn("7736207543"))  # Yandex
        # Invalid 10-digit INN (tampered checksum)
        self.assertFalse(check_inn("7707083894"))
        self.assertFalse(check_inn("1234567890"))

        # Valid 12-digit individual INN
        self.assertTrue(check_inn("500100732259"))
        # Invalid 12-digit INN
        self.assertFalse(check_inn("500100732250"))

    def test_ogrn_validation(self):
        # Valid 13-digit OGRN
        self.assertTrue(check_ogrn("1027700132195"))  # Sberbank
        self.assertTrue(check_ogrn("1027700229193"))  # Yandex
        self.assertFalse(check_ogrn("1027700132190"))

        # Valid 15-digit OGRNIP
        self.assertTrue(check_ogrn("304500116000157"))
        self.assertFalse(check_ogrn("304500116000150"))

    def test_snils_validation(self):
        self.assertTrue(check_snils("112-233-445 95"))
        self.assertTrue(check_snils("087-654-303 00"))
        self.assertFalse(check_snils("112-233-445 00"))

    def test_luhn_card_validation(self):
        # Valid test card numbers
        self.assertTrue(check_luhn("4532015112830366"))
        self.assertTrue(check_luhn("2200240012345670"))  # Mir
        self.assertFalse(check_luhn("4532015112830367"))

    def test_okpo_validation(self):
        self.assertTrue(check_okpo("00032537"))
        self.assertFalse(check_okpo("00032530"))

    def test_bank_account_and_bic(self):
        # Valid correspondent account
        self.assertTrue(check_bank_account("30101810400000000225"))
        # Valid settlement account
        self.assertTrue(check_bank_account("40702810938000012345"))
        # Invalid prefix / length
        self.assertFalse(check_bank_account("123456789"))
        self.assertFalse(check_bank_account("99902810938000012345"))

    def test_scan_text_detection(self):
        sample = (
            "Договор с ПАО Сбербанк, ИНН 7707083893, КПП 773601001, "
            "ОГРН 1027700132195, р/с 40702810938000012345, БИК 044525225. "
            "Гендиректор: Иванов Иван Иванович. СНИЛС 112-233-445 95. "
            "Контакт: ivanov@sberbank.ru, тел +7 (495) 500-55-50. "
            "Секретный токен: token: my_secret_token_abcdef123456"
        )
        matches = self.registry.scan_all(sample)
        found_types = {m.entity_type for m in matches}
        self.assertIn("INN", found_types)
        self.assertIn("KPP", found_types)
        self.assertIn("OGRN", found_types)
        self.assertIn("BANK_ACCOUNT", found_types)
        self.assertIn("BIC", found_types)
        self.assertIn("SNILS", found_types)
        self.assertIn("EMAIL", found_types)
        self.assertIn("PHONE", found_types)
        self.assertIn("SECRET", found_types)

    def test_nest_dictionary_recognizer(self):
        rec = NestDictionaryRecognizer(
            counterparties=["ООО Ромашка", "ЗАО Вектор"],
            signatories=["Петров П.П."],
            contract_patterns=[r"Договор\s+№\s*[0-9]+-[А-Я]+"],
        )
        text = "Оплата по Договор № 445-А в адрес ООО Ромашка, подписал Петров П.П."
        matches = rec.scan(text)
        types = {m.entity_type for m in matches}
        self.assertIn("COUNTERPARTY", types)
        self.assertIn("SIGNATORY", types)
        self.assertIn("CONTRACT_NUMBER", types)


if __name__ == "__main__":
    unittest.main()
