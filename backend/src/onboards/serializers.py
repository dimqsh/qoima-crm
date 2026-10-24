from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied

from core.permissions import is_scoped_collaborator
from src.onboards.models import (
    Onboard,
    Task,
    TaskAttachment,
    TaskAuditLog,
    TaskCategory,
    TaskPerformance
)
from src.users.serializers import UserSerializer


def assert_collaborator_deal_access(request, deal):
    user = getattr(request, "user", None)

    if not is_scoped_collaborator(user):
        return

    if deal is None or not deal.has_collaborator(user):
        raise PermissionDenied("You do not have access to this deal.")


class TaskAuditLogSerializer(serializers.ModelSerializer):
    actor_detail = UserSerializer(source="actor", read_only=True)

    class Meta:
        model = TaskAuditLog
        fields = (
            'id',
            'task',
            'task_id_snapshot',
            'actor',
            'actor_detail',
            'action',
            'source',
            'description',
            'metadata',
            'created_at',
        )
        read_only_fields = fields


class TaskPerformanceSerializer(serializers.ModelSerializer):
    user_detail = UserSerializer(source="user", read_only=True)

    class Meta:
        model = TaskPerformance
        fields = (
            'id',
            'user',
            'task',
            'user_detail',
        )


class TaskAttachmentSerializer(serializers.ModelSerializer):
    uploaded_by_detail = UserSerializer(source="uploaded_by", read_only=True)
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = TaskAttachment
        fields = (
            'id',
            'task',
            'file',
            'file_url',
            'file_name',
            'content_type',
            'size',
            'kind',
            'uploaded_by',
            'uploaded_by_detail',
            'created_at',
        )
        read_only_fields = fields

    def get_file_url(self, obj):
        if not obj.file:
            return ""

        request = self.context.get("request")
        url = obj.file.url
        return request.build_absolute_uri(url) if request else url


class TaskSerializer(serializers.ModelSerializer):
    performance = TaskPerformanceSerializer(
        source="taskperformance_set",
        many=True,
        read_only=True,
    )
    audit_logs = TaskAuditLogSerializer(many=True, read_only=True)
    attachments = TaskAttachmentSerializer(many=True, read_only=True)
    created_by_detail = UserSerializer(source="created_by", read_only=True)
    approval_requested_by_detail = UserSerializer(
        source="approval_requested_by",
        read_only=True,
    )
    reviewed_by_detail = UserSerializer(source="reviewed_by", read_only=True)
    cancelled_by_detail = UserSerializer(source="cancelled_by", read_only=True)
    is_cancelled = serializers.BooleanField(read_only=True)

    class Meta:
        model = Task
        fields = (
            'id',
            'name',
            'type',
            'status',
            'is_active',
            'description',
            'date_start',
            'date_end',
            'category',
            'deal_stage',
            'performance',
            'created_by',
            'created_by_detail',
            'created_via',
            'approval_status',
            'approval_action',
            'approval_requested_by',
            'approval_requested_by_detail',
            'approval_requested_at',
            'reviewed_by',
            'reviewed_by_detail',
            'reviewed_at',
            'cancelled_by',
            'cancelled_by_detail',
            'cancelled_at',
            'review_comment',
            'is_cancelled',
            'position',
            'created_at',
            'updated_at',
            'audit_logs',
            'attachments',
        )
        read_only_fields = (
            'deal_stage',
            'created_by',
            'created_by_detail',
            'created_via',
            'approval_status',
            'approval_action',
            'approval_requested_by',
            'approval_requested_by_detail',
            'approval_requested_at',
            'reviewed_by',
            'reviewed_by_detail',
            'reviewed_at',
            'cancelled_by',
            'cancelled_by_detail',
            'cancelled_at',
            'review_comment',
            'is_cancelled',
            'position',
            'created_at',
            'updated_at',
            'audit_logs',
            'attachments',
        )

    def validate(self, attrs):
        category = attrs.get("category", getattr(self.instance, "category", None))
        onboard = category.onboard if category else None
        deal = onboard.deal if onboard else None

        assert_collaborator_deal_access(
            self.context.get("request"),
            deal,
        )

        return attrs


class TaskCategorySerializer(serializers.ModelSerializer):
    tasks = TaskSerializer(
        source="task_set",
        many=True,
        read_only=True,
    )

    class Meta:
        model = TaskCategory
        fields = (
            'id',
            'name',
            'onboard',
            'tasks',
        )

    def validate(self, attrs):
        onboard = attrs.get("onboard", getattr(self.instance, "onboard", None))
        deal = onboard.deal if onboard else None

        assert_collaborator_deal_access(
            self.context.get("request"),
            deal,
        )

        return attrs


class OnboardListSerializer(serializers.ModelSerializer):
    class Meta:
        model = Onboard
        fields = (
            'id',
            'name',
            'deal',
            'is_completed',
            'term_of_end',
        )


class OnboardSerializer(serializers.ModelSerializer):
    categories = TaskCategorySerializer(
        source="taskcategory_set",
        many=True,
        read_only=True,
    )

    class Meta:
        model = Onboard
        fields = (
            'id',
            'name',
            'deal',
            'is_completed',
            'term_of_end',
            'categories',
        )

    def validate(self, attrs):
        deal = attrs.get("deal", getattr(self.instance, "deal", None))

        assert_collaborator_deal_access(
            self.context.get("request"),
            deal,
        )

        return attrs
