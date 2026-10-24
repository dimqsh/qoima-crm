"""Matching project payments with incomes entered by hand.

Kept free of model imports so the data migration can reuse it.
"""
import re

DEAL_PAYMENT_TYPE = "deal_payment"
MATCH_WINDOW_DAYS = 7

_TRANSLIT = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "i", "ь": "", "э": "e", "ю": "iu", "я": "ia",
    "ә": "a", "ғ": "g", "қ": "k", "ң": "n", "ө": "o", "ұ": "u", "ү": "u",
    "һ": "h", "і": "i", "y": "i",
})


def _words(text):
    """«Кайлас 2 транш» and «Kaylas» both give {"kailas", ...}."""
    normalized = (text or "").lower().translate(_TRANSLIT)
    return set(re.sub(r"[^a-z0-9]+", " ", normalized).split())


def deal_label(deal):
    return deal.name or f"Проект #{deal.pk}"


def pick_manual_income(candidates, *, deal_name, payment_date):
    """Pick the income that is this payment already entered by hand.

    `candidates` are unlinked incomes with the payment's amount, dated within
    MATCH_WINDOW_DAYS of it. One that names the project wins (closest date
    first); otherwise only a lone «Оплата по проекту» on the very same day.
    """
    tokens = {word for word in _words(deal_name) if len(word) >= 4}
    named = [
        income
        for income in candidates
        if tokens & _words(f"{income.name} {income.note or ''}")
    ]

    if named:
        return min(
            named,
            key=lambda income: (abs((income.date_earned - payment_date).days), income.pk),
        )

    same_day = [
        income
        for income in candidates
        if income.date_earned == payment_date and income.type == DEAL_PAYMENT_TYPE
    ]
    return same_day[0] if len(same_day) == 1 else None
