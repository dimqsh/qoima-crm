from django.conf import settings
from django.db import models
from django.utils import timezone

from src.deals.models import Deal


# Create your models here.
class Onboard(models.Model):
    name = models.CharField(max_length=120, blank=True, default="")
    deal = models.ForeignKey(Deal, on_delete=models.CASCADE, null=True)
    is_completed = models.BooleanField(default=False)
    term_of_end = models.DateField()


class TaskCategory(models.Model):
    name = models.CharField(max_length=100)
    onboard = models.ForeignKey(Onboard, on_delete=models.CASCADE, null=True)


class Task(models.Model):
    class Status(models.TextChoices):
        TODO = "todo", "To do"
        IN_PROGRESS = "in_progress", "In progress"
        IN_REVIEW = "in_review", "In review"
        DONE = "done", "Done"
        CANCELLED = "cancelled", "Cancelled"

    class ApprovalStatus(models.TextChoices):
        PENDING = "pending", "Pending"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"
        CANCELLED = "cancelled", "Cancelled"

    class ApprovalAction(models.TextChoices):
        CREATE = "create", "Create"
        CANCEL = "cancel", "Cancel"

    class CreatedVia(models.TextChoices):
        API = "api", "API"
        TELEGRAM = "telegram", "Telegram"
        SYSTEM = "system", "System"

    category = models.ForeignKey(TaskCategory, on_delete=models.CASCADE)
    deal_stage = models.OneToOneField(
        "deals.DealStage",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="task",
    )
    name = models.CharField(max_length=100)
    type = models.CharField(max_length=100)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.TODO,
    )
    is_active = models.BooleanField(default=True)
    description = models.TextField(blank=True, default="")
    date_start = models.DateField()
    date_end = models.DateField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_tasks",
    )
    created_via = models.CharField(
        max_length=16,
        choices=CreatedVia.choices,
        default=CreatedVia.API,
    )
    approval_status = models.CharField(
        max_length=16,
        choices=ApprovalStatus.choices,
        default=ApprovalStatus.APPROVED,
    )
    approval_action = models.CharField(
        max_length=16,
        choices=ApprovalAction.choices,
        blank=True,
        default="",
    )
    approval_requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="requested_task_approvals",
    )
    approval_requested_at = models.DateTimeField(null=True, blank=True)
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reviewed_tasks",
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    cancelled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="cancelled_tasks",
    )
    cancelled_at = models.DateTimeField(null=True, blank=True)
    review_comment = models.TextField(blank=True, default="")
    # Order of the card inside its board column (category).
    position = models.PositiveIntegerField(default=0, db_index=True)
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("position", "id")

    def save(self, *args, **kwargs):
        if self._state.adding and not self.position and self.category_id:
            last = Task.objects.filter(category_id=self.category_id).aggregate(
                last=models.Max("position"),
            )["last"]
            self.position = 0 if last is None else last + 1

        super().save(*args, **kwargs)

    @property
    def is_cancelled(self):
        return self.approval_status == self.ApprovalStatus.CANCELLED


class TaskPerformance(models.Model):
    task = models.ForeignKey(Task, on_delete=models.CASCADE)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='task_performance')


class TaskAuditLog(models.Model):
    class Action(models.TextChoices):
        CREATED = "created", "Created"
        UPDATED = "updated", "Updated"
        APPROVAL_REQUESTED = "approval_requested", "Approval requested"
        CANCELLATION_REQUESTED = "cancellation_requested", "Cancellation requested"
        APPROVED = "approved", "Approved"
        REJECTED = "rejected", "Rejected"
        CANCELLED = "cancelled", "Cancelled"
        ASSIGNED = "assigned", "Assigned"
        UNASSIGNED = "unassigned", "Unassigned"
        ATTACHMENT_ADDED = "attachment_added", "Attachment added"
        ATTACHMENT_REMOVED = "attachment_removed", "Attachment removed"

    task = models.ForeignKey(
        Task,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="audit_logs",
    )
    task_id_snapshot = models.PositiveBigIntegerField(null=True, blank=True, db_index=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="task_audit_logs",
    )
    action = models.CharField(max_length=32, choices=Action.choices)
    source = models.CharField(
        max_length=16,
        choices=Task.CreatedVia.choices,
        default=Task.CreatedVia.API,
    )
    description = models.TextField(blank=True, default="")
    metadata = models.JSONField(blank=True, default=dict)
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        ordering = ("-created_at", "-id")

    def save(self, *args, **kwargs):
        if self.task_id_snapshot is None and self.task_id:
            self.task_id_snapshot = self.task_id

        super().save(*args, **kwargs)


class TaskAttachment(models.Model):
    class Kind(models.TextChoices):
        FILE = "file", "File"
        VOICE = "voice", "Voice"

    task = models.ForeignKey(
        Task,
        on_delete=models.CASCADE,
        related_name="attachments",
    )
    file = models.FileField(upload_to="task_attachments/%Y/%m/%d/")
    file_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=120, blank=True, default="")
    size = models.PositiveBigIntegerField(default=0)
    kind = models.CharField(
        max_length=16,
        choices=Kind.choices,
        default=Kind.FILE,
    )
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="task_attachments",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        ordering = ("created_at", "id")
