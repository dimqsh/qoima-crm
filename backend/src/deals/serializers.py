from rest_framework import serializers
from django.contrib.auth import get_user_model

from core.enums import UserRole
from core.permissions import can_view_deal_amount, is_scoped_collaborator
from src.deals.models import Deal, DealFile, DealLink, DealPayment, DealStage
from src.users.serializers import UserSerializer
from src.wallets.serializers import WalletSourceField


class DealFileSerializer(serializers.ModelSerializer):
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = DealFile
        fields = (
            'id',
            'deal',
            'file_name',
            'file',
            'file_url',
            'description',
        )
        read_only_fields = ('id', 'deal', 'file_url')
        extra_kwargs = {
            'file_name': {'required': False, 'allow_blank': True},
        }

    def get_file_url(self, obj):
        if not obj.file:
            return ""

        request = self.context.get("request")
        url = obj.file.url
        return request.build_absolute_uri(url) if request else url

    def validate(self, attrs):
        uploaded_file = attrs.get("file")
        if uploaded_file and not attrs.get("file_name"):
            attrs["file_name"] = getattr(uploaded_file, "name", "") or "file"

        return attrs


class DealPaymentSerializer(serializers.ModelSerializer):
    can_view_amount = serializers.SerializerMethodField()
    # Wallet the received money lands in (its income); omitted → default.
    wallet = WalletSourceField(write_only=True)
    income = serializers.SerializerMethodField()
    is_paid = serializers.SerializerMethodField()
    linked_existing = serializers.SerializerMethodField()

    class Meta:
        model = DealPayment
        fields = (
            'id',
            'amount',
            'can_view_amount',
            'payment_date',
            'delayed',
            'wallet',
            'income',
            'is_paid',
            'linked_existing',
        )
        read_only_fields = ('id', 'can_view_amount')

    def get_can_view_amount(self, obj) -> bool:
        request = self.context.get("request")
        return bool(request and can_view_deal_amount(request.user))

    def get_income(self, obj):
        income = getattr(obj, "income", None)
        return income.pk if income else None

    def get_is_paid(self, obj) -> bool:
        return getattr(obj, "income", None) is not None

    def get_linked_existing(self, obj) -> bool:
        """Set right after a save that matched an income entered by hand."""
        return bool(getattr(obj, "linked_existing", False))

    def validate_wallet(self, value):
        if value is not None and not value.is_active:
            raise serializers.ValidationError("Кошелёк отключён — выберите другой.")
        return value

    def to_representation(self, instance):
        data = super().to_representation(instance)

        if not data["can_view_amount"]:
            data["amount"] = None

        return data


class DealStageSerializer(serializers.ModelSerializer):
    responsible_detail = UserSerializer(source="responsible", read_only=True)
    task = serializers.SerializerMethodField()

    class Meta:
        model = DealStage
        fields = (
            'id',
            'deal',
            'parent_stage',
            'name',
            'status',
            'order',
            'responsible',
            'responsible_detail',
            'due_date',
            'completed_at',
            'task',
        )
        read_only_fields = ('id', 'deal', 'responsible_detail', 'task')

    def get_task(self, obj):
        try:
            return obj.task.id
        except DealStage.task.RelatedObjectDoesNotExist:
            return None

    def validate_parent_stage(self, parent_stage):
        if parent_stage is None:
            return parent_stage

        if self.instance and parent_stage.pk == self.instance.pk:
            raise serializers.ValidationError("Stage cannot be its own parent.")

        deal = self.context.get("deal")
        deal_id = getattr(deal, "id", None) or getattr(self.instance, "deal_id", None)
        if deal_id and parent_stage.deal_id != deal_id:
            raise serializers.ValidationError(
                "Parent stage must belong to the same project."
            )

        ancestor = parent_stage
        while ancestor is not None:
            if self.instance and ancestor.pk == self.instance.pk:
                raise serializers.ValidationError("Stage cannot be nested under itself.")
            ancestor = ancestor.parent_stage

        return parent_stage


class DealLinkSerializer(serializers.ModelSerializer):
    class Meta:
        model = DealLink
        fields = (
            'id',
            'deal',
            'title',
            'url',
            'description',
        )
        read_only_fields = ('id', 'deal')


class DealSerializer(serializers.ModelSerializer):
    user = serializers.PrimaryKeyRelatedField(
        queryset=get_user_model().objects.filter(role=UserRole.COLLABORATOR),
        allow_null=True,
        required=False,
    )
    collaborators = serializers.PrimaryKeyRelatedField(
        queryset=get_user_model().objects.filter(role=UserRole.COLLABORATOR),
        many=True,
        required=False,
    )
    responsibles = serializers.PrimaryKeyRelatedField(
        queryset=get_user_model().objects.filter(role=UserRole.EMPLOYEE),
        many=True,
        required=False,
    )
    files = DealFileSerializer(many=True, read_only=True)
    stages = DealStageSerializer(many=True, read_only=True)
    links = DealLinkSerializer(many=True, read_only=True)
    payments = DealPaymentSerializer(many=True, read_only=True)
    user_detail = UserSerializer(source="user", read_only=True)
    collaborator_details = UserSerializer(
        source="collaborators",
        many=True,
        read_only=True,
    )
    responsible_details = UserSerializer(
        source="responsibles",
        many=True,
        read_only=True,
    )
    paid_to_date = serializers.DecimalField(
        max_digits=20,
        decimal_places=2,
        read_only=True,
    )
    remaining = serializers.DecimalField(
        max_digits=20,
        decimal_places=2,
        read_only=True,
    )
    progress_percent = serializers.SerializerMethodField()
    current_stage_name = serializers.SerializerMethodField()
    can_view_amount = serializers.SerializerMethodField()

    class Meta:
        model = Deal
        fields = (
            'id',
            'name',
            'user',
            'stage',
            'date_start',
            'date_end',
            'deal_amount',
            'payment_type',
            'is_active',
            'is_archived',
            'payment_completed',
            'collaborators',
            'collaborator_details',
            'responsibles',
            'responsible_details',
            'stages',
            'links',
            'files',
            'payments',
            'user_detail',
            'paid_to_date',
            'remaining',
            'can_view_amount',
            'progress_percent',
            'current_stage_name',
        )

        read_only_fields = (
            'id',
            'paid_to_date',
            'remaining',
            'can_view_amount',
            'progress_percent',
            'current_stage_name',
        )

    def validate(self, attrs):
        request = self.context.get("request")
        user = getattr(request, "user", None)

        if is_scoped_collaborator(user):
            attrs.pop("user", None)
            attrs.pop("collaborators", None)
            attrs.pop("responsibles", None)

        return attrs

    def get_can_view_amount(self, obj) -> bool:
        request = self.context.get("request")
        return bool(request and can_view_deal_amount(request.user))

    def to_representation(self, instance):
        data = super().to_representation(instance)

        if not data["can_view_amount"]:
            data["deal_amount"] = None
            data["paid_to_date"] = None
            data["remaining"] = None

        return data

    def get_progress_percent(self, obj):
        stages = list(getattr(obj, "stages").all())
        if not stages:
            if obj.stage == "completed" or obj.payment_completed:
                return 100
            if obj.stage == "cancelled":
                return 0
            return 0

        completed = sum(
            1 for stage in stages if stage.status == DealStage.Status.COMPLETED
        )
        return round((completed / len(stages)) * 100)

    def get_current_stage_name(self, obj):
        stages = list(getattr(obj, "stages").all())
        if not stages:
            return obj.stage

        in_progress = next(
            (
                stage
                for stage in stages
                if stage.status == DealStage.Status.IN_PROGRESS
            ),
            None,
        )
        if in_progress:
            return in_progress.name

        pending = next(
            (stage for stage in stages if stage.status == DealStage.Status.PENDING),
            None,
        )
        if pending:
            return pending.name

        return stages[-1].name
