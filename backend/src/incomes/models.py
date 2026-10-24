from django.db import models
from django.utils import timezone


# Create your models here.
class Income(models.Model):
    name = models.CharField(max_length=120)
    type = models.CharField(max_length=120)
    amount = models.DecimalField(decimal_places=2, max_digits=20)
    date_earned = models.DateField(default=timezone.localdate, db_index=True)
    note = models.TextField(blank=True, null=True)
    wallet = models.ForeignKey(
        "wallets.Wallet",
        blank=True,
        null=True,
        on_delete=models.PROTECT,
        related_name="incomes",
    )
    # Payments recorded on a project («Зафиксировать платёж») are incomes too.
    deal_payment = models.OneToOneField(
        "deals.DealPayment",
        blank=True,
        null=True,
        on_delete=models.SET_NULL,
        related_name="income",
    )
    # True when the payment created this income; False for an income entered
    # by hand that was later matched to a payment.
    created_from_payment = models.BooleanField(default=False, editable=False)

    class Meta:
        ordering = ("-date_earned", "-id")
