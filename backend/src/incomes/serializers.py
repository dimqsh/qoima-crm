from rest_framework import serializers

from src.incomes.models import Income
from src.wallets.serializers import WalletSourceField, validate_wallet_source


class IncomeSerializer(serializers.ModelSerializer):
    wallet = WalletSourceField()
    wallet_name = serializers.SerializerMethodField()
    # Project the income came from, when it is a payment recorded there.
    deal = serializers.SerializerMethodField()
    deal_name = serializers.SerializerMethodField()

    class Meta:
        model = Income
        fields = (
            "id",
            "name",
            "type",
            "amount",
            "date_earned",
            "note",
            "wallet",
            "wallet_name",
            "deal",
            "deal_name",
        )

    def get_wallet_name(self, obj):
        return obj.wallet.name if obj.wallet_id else None

    def get_deal(self, obj):
        return obj.deal_payment.deal_id if obj.deal_payment_id else None

    def get_deal_name(self, obj):
        if not obj.deal_payment_id:
            return None
        deal = obj.deal_payment.deal
        return deal.name or f"Проект #{deal.pk}"

    def validate_wallet(self, value):
        return validate_wallet_source(self, value)
