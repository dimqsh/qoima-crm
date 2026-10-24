from core.permissions import DealPermissions, IsCollaborator, is_scoped_collaborator
from core.views import BasePermissionMixin, BaseSerializerMixin
from decimal import Decimal
from django.db import transaction
from django.db.models import DecimalField, F, Q, Sum
from django.db.models.functions import Coalesce
from django_filters import rest_framework as django_filters
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters, mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from src.deals.models import Deal
from src.deals.services import ensure_task_for_sub_stage
from src.deals.serializers import (
    DealFileSerializer,
    DealLinkSerializer,
    DealPaymentSerializer,
    DealStageSerializer,
)
from src.deals.serializers import DealSerializer
from src.incomes.services import delete_deal_payment, sync_payment_income


class DealFilter(django_filters.FilterSet):
    user = django_filters.NumberFilter(method="filter_user")

    class Meta:
        model = Deal
        fields = ("user", "stage", "is_active")

    def filter_user(self, queryset, name, value):
        return queryset.filter(
            Q(user_id=value) | Q(collaborators__id=value),
        ).distinct()


# Create your views here.
class DealViewSet(
    BasePermissionMixin,
    BaseSerializerMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = DealSerializer
    permission_classes = [IsAuthenticated, DealPermissions]
    permissions = {
        "create": [IsCollaborator | DealPermissions],
    }
    serializers = {
        "create_file": DealFileSerializer,
        "create_payment": DealPaymentSerializer,
        "update_payment": DealPaymentSerializer,
        "create_stage": DealStageSerializer,
        "update_stage": DealStageSerializer,
        "create_link": DealLinkSerializer,
        "update_link": DealLinkSerializer,
    }
    queryset = Deal.objects.all()
    filter_backends = (
        DjangoFilterBackend,
        filters.SearchFilter,
        filters.OrderingFilter,
    )
    filterset_class = DealFilter
    search_fields = (
        "name",
        "user__username",
        "user__email",
        "user__first_name",
        "user__last_name",
        "responsibles__username",
        "responsibles__email",
        "responsibles__first_name",
        "responsibles__last_name",
    )
    ordering_fields = (
        "id",
        "date_start",
        "date_end",
        "deal_amount",
        "paid_to_date",
        "remaining",
    )

    def get_queryset(self):
        zero_amount = Decimal("0.00")

        queryset = (
            Deal.objects.select_related("user")
            .prefetch_related(
                "collaborators",
                "responsibles",
                "stages",
                "stages__task",
                "stages__responsible",
                "links",
                "files",
                "payments",
                "payments__income",
            )
            .annotate(
                # Only money that actually came in, i.e. is in Доходы.
                paid_to_date=Coalesce(
                    Sum(
                        "payments__amount",
                        filter=Q(payments__income__isnull=False),
                    ),
                    zero_amount,
                    output_field=DecimalField(max_digits=20, decimal_places=2),
                ),
            )
            .annotate(
                remaining=F("deal_amount") - F("paid_to_date"),
            )
            .order_by("id")
        )

        user = self.request.user
        if is_scoped_collaborator(user):
            queryset = queryset.filter(
                Q(user=user) | Q(collaborators=user),
            ).distinct()

        return queryset

    def perform_create(self, serializer):
        if is_scoped_collaborator(self.request.user):
            deal = serializer.save(user=self.request.user)
            deal.collaborators.set([self.request.user])
            return

        deal = serializer.save()

        if deal.user_id:
            deal.collaborators.add(deal.user)

    @action(detail=True, methods=["post"], url_path="files")
    def create_file(self, request, *args, **kwargs):
        deal = self.get_object()
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(deal=deal)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="stages")
    def create_stage(self, request, *args, **kwargs):
        deal = self.get_object()
        serializer = self.get_serializer(
            data=request.data,
            context={"request": request, "view": self, "deal": deal},
        )
        serializer.is_valid(raise_exception=True)

        with transaction.atomic():
            stage = serializer.save(deal=deal)
            ensure_task_for_sub_stage(stage, actor=request.user)

        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch"], url_path=r"stages/(?P<stage_id>[^/.]+)")
    def update_stage(self, request, stage_id=None, *args, **kwargs):
        deal = self.get_object()
        stage = deal.stages.filter(id=stage_id).first()

        if stage is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        serializer = self.get_serializer(
            stage,
            data=request.data,
            partial=True,
            context={"request": request, "view": self, "deal": deal},
        )
        serializer.is_valid(raise_exception=True)

        with transaction.atomic():
            stage = serializer.save(deal=deal)
            ensure_task_for_sub_stage(stage, actor=request.user)

        return Response(serializer.data)

    @update_stage.mapping.delete
    def delete_stage(self, request, stage_id=None, *args, **kwargs):
        deal = self.get_object()
        deleted_count, _ = deal.stages.filter(id=stage_id).delete()

        if deleted_count == 0:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="links")
    def create_link(self, request, *args, **kwargs):
        deal = self.get_object()
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(deal=deal)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["patch"], url_path=r"links/(?P<link_id>[^/.]+)")
    def update_link(self, request, link_id=None, *args, **kwargs):
        deal = self.get_object()
        link = deal.links.filter(id=link_id).first()

        if link is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        serializer = self.get_serializer(link, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(deal=deal)
        return Response(serializer.data)

    @update_link.mapping.delete
    def delete_link(self, request, link_id=None, *args, **kwargs):
        deal = self.get_object()
        deleted_count, _ = deal.links.filter(id=link_id).delete()

        if deleted_count == 0:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="payments")
    def create_payment(self, request, *args, **kwargs):
        deal = self.get_object()
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        wallet = serializer.validated_data.pop("wallet", None)

        with transaction.atomic():
            payment = serializer.save(deal=deal)
            _, payment.linked_existing = sync_payment_income(
                payment,
                wallet=wallet,
                actor=request.user,
            )

        return Response(
            self.get_serializer(payment).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["delete"], url_path=r"files/(?P<file_id>[^/.]+)")
    def delete_file(self, request, file_id=None, *args, **kwargs):
        deal = self.get_object()
        deleted_count, _ = deal.files.filter(id=file_id).delete()

        if deleted_count == 0:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["delete"], url_path=r"payments/(?P<payment_id>[^/.]+)")
    def delete_payment(self, request, payment_id=None, *args, **kwargs):
        deal = self.get_object()
        payment = deal.payments.filter(id=payment_id).first()

        if payment is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        delete_deal_payment(payment, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @delete_payment.mapping.patch
    def update_payment(self, request, payment_id=None, *args, **kwargs):
        deal = self.get_object()
        payment = deal.payments.filter(id=payment_id).first()

        if payment is None:
            return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

        serializer = self.get_serializer(payment, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        wallet = serializer.validated_data.pop("wallet", None)

        with transaction.atomic():
            payment = serializer.save()
            _, payment.linked_existing = sync_payment_income(
                payment,
                wallet=wallet,
                actor=request.user,
            )

        return Response(self.get_serializer(payment).data)
