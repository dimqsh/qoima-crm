from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from src.incomes.matching import (
    DEAL_PAYMENT_TYPE,
    MATCH_WINDOW_DAYS,
    deal_label,
    pick_manual_income,
)
from src.incomes.models import Income
from src.wallets.services import (
    record_income_created,
    record_income_deleted,
    record_income_updated,
)


def payment_is_received(payment):
    """Delayed or future-dated payments are expected money, not income yet."""
    return not payment.delayed and payment.payment_date <= timezone.localdate()


def find_manual_income(payment):
    window = timedelta(days=MATCH_WINDOW_DAYS)
    candidates = Income.objects.select_for_update().filter(
        deal_payment__isnull=True,
        created_from_payment=False,
        amount=payment.amount,
        date_earned__range=(
            payment.payment_date - window,
            payment.payment_date + window,
        ),
    )
    return pick_manual_income(
        list(candidates),
        deal_name=deal_label(payment.deal),
        payment_date=payment.payment_date,
    )


def detach_payment_income(income, *, actor=None):
    """Drop the income the payment created; an income entered by hand only
    loses the link and stays in Доходы."""
    if income.created_from_payment:
        record_income_deleted(income, actor=actor)
        income.delete()
        return

    income.deal_payment = None
    income.save(update_fields=("deal_payment",))


@transaction.atomic
def sync_payment_income(payment, *, wallet=None, actor=None):
    """A received project payment has exactly one income in Доходы; a delayed
    or planned one has none. Before creating an income, reuse the same money
    already entered by hand so it is not counted twice.

    Returns (income or None, linked_existing).
    """
    income = Income.objects.select_for_update().filter(deal_payment=payment).first()

    if not payment_is_received(payment):
        if income:
            detach_payment_income(income, actor=actor)
        return None, False

    if income:
        old_amount = income.amount
        old_wallet_id = income.wallet_id
        income.amount = payment.amount
        income.date_earned = payment.payment_date
        if wallet is not None:
            income.wallet = wallet
        income.save(update_fields=("amount", "date_earned", "wallet"))

        if income.amount != old_amount or income.wallet_id != old_wallet_id:
            record_income_updated(
                income,
                old_amount=old_amount,
                old_wallet_id=old_wallet_id,
                actor=actor,
            )
        return income, False

    match = find_manual_income(payment)
    if match:
        match.deal_payment = payment
        match.save(update_fields=("deal_payment",))
        return match, True

    income = Income.objects.create(
        name=deal_label(payment.deal),
        type=DEAL_PAYMENT_TYPE,
        amount=payment.amount,
        date_earned=payment.payment_date,
        wallet=wallet,
        deal_payment=payment,
        created_from_payment=True,
    )
    record_income_created(income, actor=actor)
    return income, False


@transaction.atomic
def delete_deal_payment(payment, *, actor=None):
    income = Income.objects.select_for_update().filter(deal_payment=payment).first()
    if income:
        detach_payment_income(income, actor=actor)
    payment.delete()
