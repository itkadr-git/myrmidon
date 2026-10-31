"""Recognizers for sensitive data, legal entity requisites, banking, PII, and secrets.

Operates purely offline with zero external network calls.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Pattern, Dict, Any, Callable


@dataclass
class RecognizerMatch:
    entity_type: str
    text: str
    start: int
    end: int
    score: float
    metadata: Dict[str, Any]


class BaseRecognizer:
    def __init__(self, name: str, entity_type: str):
        self.name = name
        self.entity_type = entity_type

    def scan(self, text: str) -> List[RecognizerMatch]:
        raise NotImplementedError


# --- Checksum helpers ---

def check_luhn(card_number: str) -> bool:
    digits = [int(c) for c in card_number if c.isdigit()]
    if len(digits) < 13 or len(digits) > 19:
        return False
    checksum = 0
    reverse_digits = digits[::-1]
    for i, d in enumerate(reverse_digits):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def check_inn(inn: str) -> bool:
    if not inn.isdigit():
        return False
    digits = [int(c) for c in inn]
    if len(digits) == 10:
        coeffs = [2, 4, 10, 3, 5, 9, 4, 6, 8]
        s = sum(d * c for d, c in zip(digits[:9], coeffs))
        expected = (s % 11) % 10
        return digits[9] == expected
    elif len(digits) == 12:
        coeffs11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
        s11 = sum(d * c for d, c in zip(digits[:10], coeffs11))
        expected11 = (s11 % 11) % 10
        coeffs12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]
        s12 = sum(d * c for d, c in zip(digits[:11], coeffs12))
        expected12 = (s12 % 11) % 10
        return digits[10] == expected11 and digits[11] == expected12
    return False


def check_ogrn(ogrn: str) -> bool:
    if not ogrn.isdigit():
        return False
    if len(ogrn) == 13:
        n = int(ogrn[:12])
        return int(ogrn[12]) == (n % 11) % 10
    elif len(ogrn) == 15:
        n = int(ogrn[:14])
        return int(ogrn[14]) == (n % 13) % 10
    return False


def check_snils(snils: str) -> bool:
    digits = [c for c in snils if c.isdigit()]
    if len(digits) != 11:
        return False
    d = [int(c) for c in digits]
    first9 = d[:9]
    if first9 == [0] * 9 or int("".join(str(x) for x in first9)) <= 1001998:
        return True
    s = sum(first9[i] * (9 - i) for i in range(9))
    if s < 100:
        expected = s
    elif s in (100, 101):
        expected = 0
    else:
        rem = s % 101
        expected = 0 if rem in (100, 101) else rem
    control = d[9] * 10 + d[10]
    return control == expected


def check_okpo(okpo: str) -> bool:
    if not okpo.isdigit() or len(okpo) not in (8, 10):
        return False
    digits = [int(c) for c in okpo]
    n = len(digits) - 1
    w1 = [(i % 10) + 1 for i in range(n)]
    s = sum(d * w for d, w in zip(digits[:n], w1))
    rem = s % 11
    if rem < 10:
        return digits[-1] == rem
    w2 = [((i + 2) % 10) + 1 for i in range(n)]
    s2 = sum(d * w for d, w in zip(digits[:n], w2))
    rem2 = s2 % 11
    expected = 0 if rem2 >= 10 else rem2
    return digits[-1] == expected


def check_bank_account(account: str, bic: Optional[str] = None) -> bool:
    if not account.isdigit() or len(account) != 20:
        return False
    if not bic or not bic.isdigit() or len(bic) != 9:
        # Without BIC, verify valid balance account prefix
        # Valid Russian prefixes: 301, 302, 405, 406, 407, 408, 423, etc.
        prefix = account[:3]
        return prefix in {"301", "302", "401", "402", "403", "404", "405", "406", "407", "408", "423", "425", "474"}
    # Central Bank weighting
    weights = [7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1]
    if account.startswith("301"):
        # Correspondent account with BIC: '0' + bic[4:6]
        full_seq = "0" + bic[4:6] + account
    else:
        # Settlement account with BIC: bic[6:9]
        full_seq = bic[6:9] + account
    if len(full_seq) != 23:
        return False
    s = sum(int(c) * w for c, w in zip(full_seq, weights))
    return (s % 10) == 0


class RegexChecksumRecognizer(BaseRecognizer):
    def __init__(
        self,
        name: str,
        entity_type: str,
        pattern: str,
        checksum_fn: Optional[Callable[[str], bool]] = None,
        base_score: float = 0.95,
        flags: int = re.IGNORECASE,
    ):
        super().__init__(name, entity_type)
        self.regex: Pattern[str] = re.compile(pattern, flags)
        self.checksum_fn = checksum_fn
        self.base_score = base_score

    def scan(self, text: str) -> List[RecognizerMatch]:
        matches: List[RecognizerMatch] = []
        for m in self.regex.finditer(text):
            val = m.group(1) if m.groups() else m.group(0)
            clean_val = re.sub(r"[\s\-_]", "", val)
            if self.checksum_fn is not None:
                if not self.checksum_fn(clean_val):
                    continue
            matches.append(
                RecognizerMatch(
                    entity_type=self.entity_type,
                    text=m.group(0),
                    start=m.start(),
                    end=m.end(),
                    score=self.base_score,
                    metadata={"clean_value": clean_val, "recognizer": self.name},
                )
            )
        return matches


class SecretsRecognizer(BaseRecognizer):
    SECRET_PATTERNS = [
        ("PRIVATE_KEY", r"-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE\s+KEY-----", 0.99),
        ("API_KEY", r"\b(?:sk-[A-Za-z0-9_-]{20,})\b", 0.98),
        ("JWT_TOKEN", r"\b(?:eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b", 0.96),
        ("PASSWORD_ASSIGN", r"(?i)\b(?:password|passwd|pwd|secret|api_key|token|auth_token)\s*[:=]\s*[\"']?([^\s\"',;]{6,})[\"']?", 0.92),
        ("BEARER_TOKEN", r"(?i)\bBearer\s+([A-Za-z0-9_\-\.]{16,})\b", 0.95),
    ]

    def __init__(self, name: str = "secrets"):
        super().__init__(name, "SECRET")
        self.compiled = [
            (kind, re.compile(pat), score) for kind, pat, score in self.SECRET_PATTERNS
        ]

    def scan(self, text: str) -> List[RecognizerMatch]:
        results: List[RecognizerMatch] = []
        for kind, regex, score in self.compiled:
            for m in regex.finditer(text):
                results.append(
                    RecognizerMatch(
                        entity_type="SECRET",
                        text=m.group(0),
                        start=m.start(),
                        end=m.end(),
                        score=score,
                        metadata={"kind": kind, "recognizer": self.name},
                    )
                )
        return results


class NestDictionaryRecognizer(BaseRecognizer):
    def __init__(
        self,
        name: str = "nest_dictionary",
        counterparties: Optional[List[str]] = None,
        signatories: Optional[List[str]] = None,
        contract_patterns: Optional[List[str]] = None,
    ):
        super().__init__(name, "NEST_DATA")
        self.counterparties = [c.strip() for c in (counterparties or []) if c.strip()]
        self.signatories = [s.strip() for s in (signatories or []) if s.strip()]
        self.contract_regexes = [
            re.compile(p, re.IGNORECASE) for p in (contract_patterns or [])
        ]

    def scan(self, text: str) -> List[RecognizerMatch]:
        matches: List[RecognizerMatch] = []
        # Counterparties
        for cp in self.counterparties:
            pattern = re.compile(r"(?<!\w)" + re.escape(cp) + r"(?!\w)", re.IGNORECASE)
            for m in pattern.finditer(text):
                matches.append(
                    RecognizerMatch(
                        entity_type="COUNTERPARTY",
                        text=m.group(0),
                        start=m.start(),
                        end=m.end(),
                        score=0.97,
                        metadata={"type": "counterparty", "canonical": cp},
                    )
                )
        # Signatories
        for sig in self.signatories:
            pattern = re.compile(r"(?<!\w)" + re.escape(sig) + r"(?!\w)", re.IGNORECASE)
            for m in pattern.finditer(text):
                matches.append(
                    RecognizerMatch(
                        entity_type="SIGNATORY",
                        text=m.group(0),
                        start=m.start(),
                        end=m.end(),
                        score=0.97,
                        metadata={"type": "signatory", "canonical": sig},
                    )
                )
        # Contract / invoice regexes
        for rx in self.contract_regexes:
            for m in rx.finditer(text):
                matches.append(
                    RecognizerMatch(
                        entity_type="CONTRACT_NUMBER",
                        text=m.group(0),
                        start=m.start(),
                        end=m.end(),
                        score=0.95,
                        metadata={"type": "nest_contract"},
                    )
                )
        return matches


class RecognizerRegistry:
    def __init__(self) -> None:
        self.recognizers: List[BaseRecognizer] = []

    def register(self, recognizer: BaseRecognizer) -> None:
        self.recognizers.append(recognizer)

    def scan_all(self, text: str) -> List[RecognizerMatch]:
        raw_matches: List[RecognizerMatch] = []
        for rec in self.recognizers:
            raw_matches.extend(rec.scan(text))

        # Sort matches by start position, then longer span first, then higher score
        raw_matches.sort(key=lambda m: (m.start, -(m.end - m.start), -m.score))

        # Deduplicate overlapping matches
        deduped: List[RecognizerMatch] = []
        last_end = -1
        for m in raw_matches:
            if m.start >= last_end:
                deduped.append(m)
                last_end = m.end
            else:
                # Overlap: keep the higher score or longer match
                if deduped and (m.score > deduped[-1].score or (m.score == deduped[-1].score and (m.end - m.start) > (deduped[-1].end - deduped[-1].start))):
                    deduped[-1] = m
                    last_end = m.end
        return deduped


def create_default_registry() -> RecognizerRegistry:
    registry = RecognizerRegistry()

    # 1. INN (10 digits for legal entity, 12 digits for individual/entrepreneur)
    registry.register(
        RegexChecksumRecognizer(
            name="ru_inn",
            entity_type="INN",
            pattern=r"(?i)\b(?:ИНН\s*[:#№]?\s*)?([0-9]{10}|[0-9]{12})\b",
            checksum_fn=check_inn,
            base_score=0.98,
        )
    )

    # 2. KPP (9 digits)
    registry.register(
        RegexChecksumRecognizer(
            name="ru_kpp",
            entity_type="KPP",
            pattern=r"(?i)\b(?:КПП\s*[:#№]?\s*)?([0-9]{4}[0-9A-Z]{2}[0-9]{3})\b",
            checksum_fn=lambda val: len(val) == 9 and val[:4].isdigit() and val[6:].isdigit(),
            base_score=0.94,
        )
    )

    # 3. OGRN (13 digits) and OGRNIP (15 digits)
    registry.register(
        RegexChecksumRecognizer(
            name="ru_ogrn",
            entity_type="OGRN",
            pattern=r"(?i)\b(?:ОГРН(?:ИП)?\s*[:#№]?\s*)?([0-9]{13}|[0-9]{15})\b",
            checksum_fn=check_ogrn,
            base_score=0.98,
        )
    )

    # 4. OKPO (8 or 10 digits)
    registry.register(
        RegexChecksumRecognizer(
            name="ru_okpo",
            entity_type="OKPO",
            pattern=r"(?i)\b(?:ОКПО\s*[:#№]?\s*)?([0-9]{8}|[0-9]{10})\b",
            checksum_fn=check_okpo,
            base_score=0.95,
        )
    )

    # 5. Bank cards (Luhn check, 13 to 19 digits)
    registry.register(
        RegexChecksumRecognizer(
            name="bank_card",
            entity_type="BANK_CARD",
            pattern=r"\b((?:[0-9]{4}[-\s]?){3}[0-9]{1,7}|[0-9]{13,19})\b",
            checksum_fn=check_luhn,
            base_score=0.98,
        )
    )

    # 6. BIC (9 digits starting with 04)
    registry.register(
        RegexChecksumRecognizer(
            name="ru_bic",
            entity_type="BIC",
            pattern=r"(?i)\b(?:БИК\s*[:#№]?\s*)?(04[0-9]{7})\b",
            checksum_fn=lambda val: len(val) == 9 and val.startswith("04"),
            base_score=0.96,
        )
    )

    # 7. Settlement and correspondent accounts (20 digits, starting with 301, 407, 408, etc.)
    registry.register(
        RegexChecksumRecognizer(
            name="ru_bank_account",
            entity_type="BANK_ACCOUNT",
            pattern=r"(?i)\b(?:[рк]/с\s*[:#№]?\s*|(?:расчетный|корр(?:еспондентский)?)\s+счет\s*[:#№]?\s*)?([34][0-9]{19})\b",
            checksum_fn=check_bank_account,
            base_score=0.96,
        )
    )

    # 8. SNILS (11 digits: XXX-XXX-XXX YY or 11 continuous digits)
    registry.register(
        RegexChecksumRecognizer(
            name="ru_snils",
            entity_type="SNILS",
            pattern=r"(?i)\b(?:СНИЛС\s*[:#№]?\s*)?([0-9]{3}[-\s]?[0-9]{3}[-\s]?[0-9]{3}[-\s]?[0-9]{2})\b",
            checksum_fn=check_snils,
            base_score=0.97,
        )
    )

    # 9. Russian Passport (серия 4 цифры + номер 6 цифр)
    registry.register(
        RegexChecksumRecognizer(
            name="ru_passport",
            entity_type="PASSPORT",
            pattern=r"(?i)\b(?:паспорт\s*(?:РФ)?\s*[:#№]?\s*)?([0-9]{2}\s?[0-9]{2}\s+[0-9]{6})\b",
            checksum_fn=lambda val: len(re.sub(r"\s+", "", val)) == 10 and re.sub(r"\s+", "", val).isdigit(),
            base_score=0.93,
        )
    )

    # 10. Email address
    registry.register(
        RegexChecksumRecognizer(
            name="email",
            entity_type="EMAIL",
            pattern=r"\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b",
            checksum_fn=lambda val: "@" in val and "." in val.split("@")[-1],
            base_score=0.97,
        )
    )

    # 11. Phone numbers
    registry.register(
        RegexChecksumRecognizer(
            name="phone",
            entity_type="PHONE",
            pattern=r"(?:\+7|8)[\s\-]?(?:\([0-9]{3}\)|[0-9]{3})[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}\b",
            checksum_fn=lambda val: 10 <= len(re.sub(r"\D", "", val)) <= 11,
            base_score=0.95,
        )
    )

    # 12. Address
    registry.register(
        RegexChecksumRecognizer(
            name="ru_address",
            entity_type="ADDRESS",
            pattern=r"(?i)\b(?:г\.|город|обл\.|область|ул\.|улица|пр-кт|проспект|д\.|дом)\s+[А-Яа-я0-9\s,\.\-]{10,80}(?:д\.|дом|кв\.|оф\.|офис)\s*[0-9]+[А-Яа-я]?\b",
            checksum_fn=None,
            base_score=0.90,
        )
    )

    # 13. Russian Person Names (ФИО) with title/prefix
    registry.register(
        RegexChecksumRecognizer(
            name="ru_fio",
            entity_type="FIO",
            pattern=r"(?i)\b(?:директор|гендиректор|главбух|заказчик|исполнитель|подписант|клиент|пациент|гр\.|гражданин|фио)\s*[:\-]?\s*([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)\b",
            checksum_fn=None,
            base_score=0.92,
        )
    )

    # 14. Secrets recognizer (keys, tokens, private keys, passwords)
    registry.register(SecretsRecognizer())

    return registry
