from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from core.enums import UserRole
from src.deals.models import Deal, DealPayment
from src.incomes.matching import pick_manual_income
from src.incomes.models import Income
from src.wallets.models import Wallet


class DealPaymentIncomeTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = get_user_model().objects.create_superuser(
            username="admin",
            email="admin@example.com",
            password="password",
            role=UserRole.EMPLOYEE,
        )
        self.client.force_authenticate(self.admin)
        self.wallet = Wallet.default()
        self.cash = Wallet.objects.create(name="Наличные", code="cash")
        self.deal = Deal.objects.create(
            name="Kaylas - мебельный цех",
            stage="active",
            date_start="2026-06-01",
            date_end="2026-12-31",
            deal_amount="9000000.00",
            payment_type="cash",
        )
        self.today = timezone.localdate()

    def test_received_payment_becomes_income(self):
        response = self.pay(amount="3000000.00", wallet=self.cash.id)

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["is_paid"])
        self.assertFalse(response.data["linked_existing"])
        income = Income.objects.get(deal_payment_id=response.data["id"])
        self.assertEqual(income.name, "Kaylas - мебельный цех")
        self.assertEqual(income.type, "deal_payment")
        self.assertEqual(income.amount, Decimal("3000000.00"))
        self.assertEqual(income.wallet, self.cash)
        self.cash.refresh_from_db()
        self.assertEqual(self.cash.balance, Decimal("3000000.00"))
        self.assertEqual(self.paid_to_date(), "3000000.00")

        listed = self.client.get("/api/incomes/").data["results"]
        self.assertEqual(listed[0]["deal"], self.deal.id)
        self.assertEqual(listed[0]["deal_name"], "Kaylas - мебельный цех")

    def test_payment_reuses_income_entered_by_hand(self):
        manual = Income.objects.create(
            name="Кайлас 2 транш",
            type="deal_payment",
            amount="1000000.00",
            date_earned=self.today - timedelta(days=2),
            wallet=self.wallet,
        )

        response = self.pay(amount="1000000.00")

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["linked_existing"])
        self.assertEqual(Income.objects.count(), 1)
        manual.refresh_from_db()
        self.assertEqual(manual.deal_payment_id, response.data["id"])
        self.wallet.refresh_from_db()
        self.assertEqual(self.wallet.balance, Decimal("0.00"))
        self.assertEqual(self.paid_to_date(), "1000000.00")

    def test_delayed_and_planned_payments_are_not_income_until_paid(self):
        delayed = self.pay(amount="500000.00", delayed=True)
        planned = self.pay(
            amount="700000.00",
            payment_date=(self.today + timedelta(days=10)).isoformat(),
        )

        self.assertFalse(delayed.data["is_paid"])
        self.assertFalse(planned.data["is_paid"])
        self.assertFalse(Income.objects.exists())
        self.assertEqual(self.paid_to_date(), "0.00")

        response = self.client.patch(
            f"/api/projects/{self.deal.id}/payments/{delayed.data['id']}/",
            {"delayed": False, "payment_date": self.today.isoformat()},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["is_paid"])
        self.assertEqual(self.paid_to_date(), "500000.00")

    def test_deleting_payment_removes_its_income_and_refunds_wallet(self):
        response = self.pay(amount="300000.00")

        self.client.delete(
            f"/api/projects/{self.deal.id}/payments/{response.data['id']}/"
        )

        self.assertFalse(Income.objects.exists())
        self.wallet.refresh_from_db()
        self.assertEqual(self.wallet.balance, Decimal("0.00"))

    def test_deleting_payment_keeps_income_entered_by_hand(self):
        manual = Income.objects.create(
            name="Kaylas",
            type="deal_payment",
            amount="200000.00",
            date_earned=self.today,
            wallet=self.wallet,
        )
        response = self.pay(amount="200000.00")

        self.client.delete(
            f"/api/projects/{self.deal.id}/payments/{response.data['id']}/"
        )

        manual.refresh_from_db()
        self.assertIsNone(manual.deal_payment_id)
        self.assertFalse(DealPayment.objects.exists())

    def test_editing_and_deleting_income_updates_the_payment(self):
        response = self.pay(amount="400000.00")
        income = Income.objects.get(deal_payment_id=response.data["id"])

        self.client.patch(
            f"/api/incomes/{income.id}/",
            {"amount": "450000.00"},
            format="json",
        )

        payment = DealPayment.objects.get(pk=response.data["id"])
        self.assertEqual(payment.amount, Decimal("450000.00"))
        self.assertEqual(self.paid_to_date(), "450000.00")

        self.client.delete(f"/api/incomes/{income.id}/")

        self.assertFalse(DealPayment.objects.exists())
        self.assertEqual(self.paid_to_date(), "0.00")

    def pay(self, **payload):
        payload.setdefault("payment_date", self.today.isoformat())
        return self.client.post(
            f"/api/projects/{self.deal.id}/payments/",
            payload,
            format="json",
        )

    def paid_to_date(self):
        return self.client.get(f"/api/projects/{self.deal.id}/").data["paid_to_date"]


class PickManualIncomeTests(TestCase):
    def income(self, pk, name, days=0, type="other", note=""):
        income = Income(
            name=name,
            type=type,
            amount="100.00",
            date_earned=date(2026, 10, 10) + timedelta(days=days),
            note=note,
        )
        income.pk = pk
        return income

    def pick(self, *candidates):
        return pick_manual_income(
            list(candidates),
            deal_name="Kaylas - мебельный цех",
            payment_date=date(2026, 10, 10),
        )

    def test_matches_project_name_across_alphabets_closest_date_first(self):
        far = self.income(1, "Kaylas", days=5)
        near = self.income(2, "Кайлас 2 транш", days=-1)

        self.assertEqual(self.pick(far, near), near)

    def test_lone_same_day_project_payment_matches_without_name(self):
        lone = self.income(1, "Оплата", type="deal_payment")

        self.assertEqual(self.pick(lone), lone)

    def test_unrelated_incomes_do_not_match(self):
        other_day = self.income(1, "Жаркын", days=1, type="deal_payment")
        other_type = self.income(2, "Жаркын", type="consulting")

        self.assertIsNone(self.pick(other_day, other_type))
        self.assertIsNone(
            self.pick(
                self.income(3, "Оплата", type="deal_payment"),
                self.income(4, "Оплата", type="deal_payment"),
            )
        )
