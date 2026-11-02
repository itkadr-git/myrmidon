"""Synthetic benchmark suite for Myrmidon REDACT.

Tests:
1. Recall >= 0.95 on synthetic positives for INN, OGRN, BANK_ACCOUNT, BIC, BANK_CARD, SECRET.
2. False positive rate <= 0.02 on benign texts and invalid checksum numbers.
3. Byte-for-byte reconstruction on reversible masking.
4. Non-blocking behavior in FLAG mode.
5. Latency <= 150 ms on 4 KiB payload.
6. Zero external network calls.
"""

import socket
import time
import unittest
from unittest.mock import patch
from typing import List, Tuple
from myrmidon_redact.engine import RedactEngine, RedactMode
from myrmidon_redact.recognizers import check_inn, check_ogrn, check_luhn


class TestSyntheticBenchmark(unittest.TestCase):
    def setUp(self):
        self.engine = RedactEngine()

    def test_recall_and_false_positive_rates(self):
        # 1. INN datasets (valid vs invalid)
        valid_inns = [
            "7707083893", "7736207543", "7728168971", "7842349892", "7702070139",
            "500100732259", "7710140679", "7706107510", "7707049388", "7710349494",
            "7743001840", "7708503727", "7709259743", "7710030411", "7725038124",
            "7705031674", "7714086422", "7700000016", "7700000023", "7700000030"
        ]
        invalid_inns = [
            f"770000001{d}" for d in range(10) if not check_inn(f"770000001{d}")
        ] + [
            f"770000002{d}" for d in range(10) if not check_inn(f"770000002{d}")
        ]

        # 2. OGRN datasets (valid vs invalid)
        valid_ogrns = [
            "1027700132195", "1027700229193", "1027739609391", "1027700070518", "1027739244741",
            "1027700092661", "1027739007570", "304500116000157", "1027700000019", "1027700000020",
            "1027700000030", "1027700000041", "1027700000052", "1027700000063", "1027700000074",
            "304500100000017", "304500100000028", "304500100000039", "304500100000040", "304500100000051"
        ]
        invalid_ogrns = [
            f"102770000001{d}" for d in range(10) if not check_ogrn(f"102770000001{d}")
        ] + [
            f"102770000002{d}" for d in range(10) if not check_ogrn(f"102770000002{d}")
        ]

        # 3. Bank Cards (valid Luhn vs invalid)
        valid_cards = [
            "4532015112830366", "4532015112830010", "4532015112830028", "2200240012345670",
            "5425233430109903", "4012888888881881", "4111111111111111", "5555555555554444",
            "378282246310005",  "6011111111111117", "3566002020360505", "4222222222222"
        ]
        invalid_cards = [
            "4532015112830367", "4532752149999995", "2200240012345679", "5425233430109904",
            "4012888888881882", "4111111111111112", "5555555555554445", "378282246310006",
            "6011111111111118", "3566002020360506", "1234567890123456", "9876543210987654"
        ]

        # 4. Bank Accounts (valid vs invalid)
        valid_accounts = [
            "30101810400000000225", "40702810938000012345", "40817810099910004321",
            "40502810100000001111", "40602810200000002222", "42301810300000003333"
        ]
        invalid_accounts = [
            "10101810400000000225", "20702810938000012345", "90817810099910004321",
            "12345678901234567890", "99999999999999999999", "11111111111111111111"
        ]

        # 5. BIC (valid 9-digit starting with 04 vs invalid)
        valid_bics = [
            "044525225", "044525974", "044525092", "044525187", "044525700",
            "044525823", "044525600", "044525593", "044525411", "044525111",
            "044525360", "044525858", "044525999", "044525001", "044525002",
            "044525003", "044525004", "044525005", "044525006", "044525007"
        ]
        invalid_bics = [
            "014525225", "034525974", "054525092", "04452518", "0445251870",
            "123456789", "994525700", "004525225", "04452500a", "024525111"
        ]

        # 6. Secrets (valid patterns vs regular tokens)
        valid_secrets = [
            "password: my_secret_password_12345",
            "token: my_secret_token_abcdef123456",
            "api_key: secret_api_key_value_987654",
            "Bearer test_bearer_token_1234567890abcdef",
            "secret: secret_value_demo_778899",
            "auth_token: my_auth_token_value_554433",
        ]
        invalid_secrets = [
            "regular_identifier_12345", "user-id-998877", "session_abc", "commit-sha-79f023088",
            "version-1.7.0", "build_status_success"
        ]

        # Evaluate Recall on positives
        detected_inns = sum(1 for inn in valid_inns if any(m.entity_type == "INN" for m in self.engine.scan(f"ИНН {inn}")))
        inn_recall = detected_inns / len(valid_inns)

        detected_ogrns = sum(1 for ogrn in valid_ogrns if any(m.entity_type == "OGRN" for m in self.engine.scan(f"ОГРН {ogrn}")))
        ogrn_recall = detected_ogrns / len(valid_ogrns)

        detected_cards = sum(1 for card in valid_cards if any(m.entity_type == "BANK_CARD" for m in self.engine.scan(f"Карта {card}")))
        card_recall = detected_cards / len(valid_cards)

        detected_accs = sum(1 for acc in valid_accounts if any(m.entity_type == "BANK_ACCOUNT" for m in self.engine.scan(f"р/с {acc}")))
        acc_recall = detected_accs / len(valid_accounts)

        detected_bics = sum(1 for bic in valid_bics if any(m.entity_type == "BIC" for m in self.engine.scan(f"БИК {bic}")))
        bic_recall = detected_bics / len(valid_bics)

        detected_secrets = sum(1 for sec in valid_secrets if any(m.entity_type == "SECRET" for m in self.engine.scan(f"токен: {sec}")))
        secret_recall = detected_secrets / len(valid_secrets)

        # Assert recall >= 0.95
        self.assertGreaterEqual(inn_recall, 0.95, f"INN recall too low: {inn_recall}")
        self.assertGreaterEqual(ogrn_recall, 0.95, f"OGRN recall too low: {ogrn_recall}")
        self.assertGreaterEqual(card_recall, 0.95, f"Card recall too low: {card_recall}")
        self.assertGreaterEqual(acc_recall, 0.95, f"Account recall too low: {acc_recall}")
        self.assertGreaterEqual(bic_recall, 0.95, f"BIC recall too low: {bic_recall}")
        self.assertGreaterEqual(secret_recall, 0.95, f"Secret recall too low: {secret_recall}")

        # Evaluate False Positive Rate on invalid checksums, invalid BICs, and benign text
        fp_inns = sum(1 for inn in invalid_inns if any(m.entity_type == "INN" for m in self.engine.scan(f"ИНН {inn}")))
        fp_ogrns = sum(1 for ogrn in invalid_ogrns if any(m.entity_type == "OGRN" for m in self.engine.scan(f"ОГРН {ogrn}")))
        fp_cards = sum(1 for card in invalid_cards if any(m.entity_type == "BANK_CARD" for m in self.engine.scan(f"карта {card}")))
        fp_bics = sum(1 for bic in invalid_bics if any(m.entity_type == "BIC" for m in self.engine.scan(f"БИК {bic}")))

        benign_sentences = [
            "Доброе утро, коллеги! Направляю повестку дня для встречи в 14:00.",
            "Система обновлена до версии 1.7.0, контейнеры перезапущены штатно.",
            "Общий объем переданных данных составил 1024 мегабайта за 12 минут.",
            "План работ на следующий квартал согласован руководителем проекта.",
            "Пожалуйста, проверьте статус выполнения сборки в панели мониторинга.",
            "Файлы конфигурации сохранены в каталоге /etc/myrmidon/config.",
            "Запрос выполнен со статусом 200 OK, время ответа 45 миллисекунд.",
            "Количество активных сессий на текущий момент составляет 15.",
            "Отчет об инцидентах формируется автоматически каждое воскресенье.",
            "Резервная копия базы данных успешно создана и перенесена в архив."
        ]
        fp_benign = sum(1 for s in benign_sentences if len(self.engine.scan(s)) > 0)

        total_negatives = len(invalid_inns) + len(invalid_ogrns) + len(invalid_cards) + len(invalid_bics) + len(benign_sentences)
        total_fps = fp_inns + fp_ogrns + fp_cards + fp_bics + fp_benign
        fpr = total_fps / total_negatives

        self.assertLessEqual(fpr, 0.02, f"False positive rate exceeded threshold: {fpr} ({total_fps}/{total_negatives})")

    def test_latency_under_150ms_on_4kb_text(self):
        # 4 KiB text containing mixed Russian text and occasional sensitive items
        base_paragraph = (
            "Уведомление об исполнении обязательств по договору поставки оборудования. "
            "Компания ООО Альфа (ИНН 7707083893, ОГРН 1027700132195) произвела безналичный "
            "расчет на расчетный счет 40702810938000012345 в банке с БИК 044525225. "
            "Ответственный исполнитель: Иванов Сергей Петрович, e-mail: ivanov@alpha.ru, "
            "контактный телефон: +7 (495) 123-45-67. СНИЛС 112-233-445 95. "
            "Транзакция авторизована через платежный шлюз по карте 4532015112830366. "
            "Логи обработки зашифрованы ключом доступа token: secret_token_1234567890abcdef.\n"
        )
        # Repeat until >= 4096 bytes
        payload = ""
        while len(payload.encode("utf-8")) < 4096:
            payload += base_paragraph

        payload_bytes = len(payload.encode("utf-8"))
        self.assertGreaterEqual(payload_bytes, 4096)

        start = time.perf_counter()
        res = self.engine.redact(payload, mode=RedactMode.MASK, reversible=True)
        elapsed_ms = (time.perf_counter() - start) * 1000.0

        self.assertLess(elapsed_ms, 150.0, f"Latency too high: {elapsed_ms:.2f} ms >= 150 ms")
        self.assertTrue(res.flagged)
        self.assertGreater(len(res.matches), 0)

    def test_byte_for_byte_restoration_criterion(self):
        complex_text = (
            "Договор: ИНН 7707083893, КПП 773601001, ОГРН 1027700132195.\n"
            "Банк: р/с 40702810938000012345, БИК 044525225, карта 4532015112830366.\n"
            "Сотрудник: СНИЛС 112-233-445 95, тел. +7 999 123-45-67, e-mail test@example.com.\n"
            "Ключ: password: my_super_secret_password_123."
        )
        res = self.engine.redact(complex_text, mode=RedactMode.MASK, reversible=True)
        restored = self.engine.restore(res.text)
        self.assertEqual(restored, complex_text)
        self.assertEqual(restored.encode("utf-8"), complex_text.encode("utf-8"))

    def test_zero_external_network_calls_behavior(self):
        """Explicit behavioral test proving scanning, redacting, and restoring make zero network calls."""
        def forbidden_network(*args, **kwargs):
            raise AssertionError("External network call attempted in offline REDACT engine!")

        with patch.object(socket.socket, "connect", side_effect=forbidden_network), \
             patch("socket.create_connection", side_effect=forbidden_network):
            test_doc = (
                "Проверка ИНН 7707083893, ОГРН 1027700132195, БИК 044525225, "
                "р/с 40702810938000012345, карта 4532015112830366, token: secret_token_123456"
            )
            # Scan
            matches = self.engine.scan(test_doc)
            self.assertGreater(len(matches), 0)

            # Redact (mask + reversible)
            redacted = self.engine.redact(test_doc, mode=RedactMode.MASK, reversible=True)
            self.assertTrue(redacted.flagged)
            self.assertIn("<SUB:INN:", redacted.text)

            # Redact (flag only)
            flagged = self.engine.redact(test_doc, mode=RedactMode.FLAG)
            self.assertEqual(flagged.text, test_doc)

            # Restore
            restored = self.engine.restore(redacted.text)
            self.assertEqual(restored, test_doc)


if __name__ == "__main__":
    unittest.main()
