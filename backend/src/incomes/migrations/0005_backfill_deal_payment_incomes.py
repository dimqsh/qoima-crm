from datetime import timedelta

from django.db import migrations
from django.utils import timezone

from src.incomes.matching import (
    DEAL_PAYMENT_TYPE,
    MATCH_WINDOW_DAYS,
    deal_label,
    pick_manual_income,
)


def backfill(apps, schema_editor):
    """Put past project payments into Доходы.

    A payment that was already entered by hand is linked to that income;
    any other received payment gets a new income in the default wallet,
    booked through the wallet log like every other income.
    """
    DealPayment = apps.get_model("deals", "DealPayment")
    Income = apps.get_model("incomes", "Income")
    Wallet = apps.get_model("wallets", "Wallet")
    WalletLog = apps.get_model("wallets", "WalletLog")

    window = timedelta(days=MATCH_WINDOW_DAYS)
    payments = (
        DealPayment.objects.select_related("deal")
        .filter(
            delayed=False,
            payment_date__lte=timezone.localdate(),
            income__isnull=True,
        )
        .order_by("payment_date", "id")
    )
    wallet = None

    for payment in payments:
        candidates = Income.objects.filter(
            deal_payment__isnull=True,
            created_from_payment=False,
            amount=payment.amount,
            date_earned__range=(
                payment.payment_date - window,
                payment.payment_date + window,
            ),
        )
        match = pick_manual_income(
            list(candidates),
            deal_name=deal_label(payment.deal),
            payment_date=payment.payment_date,
        )

        if match:
            match.deal_payment = payment
            match.save(update_fields=("deal_payment",))
            continue

        if wallet is None:
            wallet = Wallet.objects.filter(is_default=True).first()
            if wallet is None:
                wallet = Wallet.objects.create(name="Company wallet", is_default=True)

        income = Income.objects.create(
            name=deal_label(payment.deal),
            type=DEAL_PAYMENT_TYPE,
            amount=payment.amount,
            date_earned=payment.payment_date,
            wallet=wallet,
            deal_payment=payment,
            created_from_payment=True,
        )
        balance_before = wallet.balance
        wallet.balance = balance_before + payment.amount
        wallet.save(update_fields=("balance",))
        WalletLog.objects.create(
            wallet=wallet,
            action="income_created",
            amount_delta=payment.amount,
            balance_before=balance_before,
            balance_after=wallet.balance,
            related_object_type="incomes.Income",
            related_object_id=str(income.pk),
            description=f"Платёж по проекту перенесён в доходы: {income.name}",
        )


class Migration(migrations.Migration):

    dependencies = [
        ("incomes", "0004_income_deal_payment"),
        ("deals", "0009_deal_is_archived"),
        ("wallets", "0004_backfill_wallet_codes_and_sources"),
    ]

    operations = [
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
