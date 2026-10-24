import shutil
import tempfile
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient
from unittest.mock import patch

from core.enums import UserRole
from src.deals.models import Deal
from src.employees.models import Employee
from src.onboards.models import (
    Onboard,
    Task,
    TaskAttachment,
    TaskAuditLog,
    TaskCategory,
)
from src.telegram_bot.models import TelegramBotConfig, TelegramChat
from src.telegram_bot.services.handler import TelegramBotService


class CollaboratorOnboardAccessTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.collaborator = get_user_model().objects.create_user(
            username="client-a",
            email="client-a@example.com",
            password="password",
            role=UserRole.COLLABORATOR,
        )
        self.other_collaborator = get_user_model().objects.create_user(
            username="client-b",
            email="client-b@example.com",
            password="password",
            role=UserRole.COLLABORATOR,
        )

        self.own_deal = self.create_deal(self.collaborator)
        self.other_deal = self.create_deal(self.other_collaborator)
        self.own_onboard = self.create_onboard(self.own_deal)
        self.other_onboard = self.create_onboard(self.other_deal)
        self.own_category = TaskCategory.objects.create(
            name="Own category",
            onboard=self.own_onboard,
        )
        self.other_category = TaskCategory.objects.create(
            name="Other category",
            onboard=self.other_onboard,
        )
        self.own_task = self.create_task(self.own_category, "Own task")
        self.other_task = self.create_task(self.other_category, "Other task")

    def test_collaborator_sees_only_onboards_for_attached_deals(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.get("/api/onboards/")

        self.assertEqual(response.status_code, 200)
        onboard_ids = {item["id"] for item in self.results(response)}
        self.assertEqual(onboard_ids, {self.own_onboard.id})

    def test_collaborator_sees_only_categories_for_attached_deals(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.get("/api/onboards/categories/")

        self.assertEqual(response.status_code, 200)
        category_ids = {item["id"] for item in self.results(response)}
        self.assertEqual(category_ids, {self.own_category.id})

    def test_collaborator_sees_only_tasks_for_attached_deals(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.get("/api/onboards/tasks/")

        self.assertEqual(response.status_code, 200)
        task_ids = {item["id"] for item in self.results(response)}
        self.assertEqual(task_ids, {self.own_task.id})

    def test_collaborator_can_create_task_for_attached_deal(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.post(
            "/api/onboards/tasks/",
            self.task_payload(self.own_category.id),
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertTrue(
            Task.objects.filter(
                id=response.data["id"],
                category=self.own_category,
                approval_status=Task.ApprovalStatus.APPROVED,
                created_by=self.collaborator,
            ).exists()
        )
        task = Task.objects.get(pk=response.data["id"])
        self.assertTrue(
            task.audit_logs.filter(action=TaskAuditLog.Action.CREATED).exists()
        )

    def test_collaborator_can_create_category_for_attached_deal(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.post(
            "/api/onboards/categories/",
            {"name": "New category", "onboard": self.own_onboard.id},
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertTrue(
            TaskCategory.objects.filter(
                id=response.data["id"],
                onboard=self.own_onboard,
            ).exists()
        )

    def test_collaborator_can_create_onboard_for_attached_deal(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.post(
            "/api/onboards/",
            {
                "deal": self.own_deal.id,
                "term_of_end": "2026-07-31",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertTrue(
            Onboard.objects.filter(
                id=response.data["id"],
                deal=self.own_deal,
            ).exists()
        )

    def test_collaborator_cannot_create_task_for_other_deal(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.post(
            "/api/onboards/tasks/",
            self.task_payload(self.other_category.id),
            format="json",
        )

        self.assertEqual(response.status_code, 403)

    def test_collaborator_cannot_create_category_for_other_deal(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.post(
            "/api/onboards/categories/",
            {"name": "Blocked", "onboard": self.other_onboard.id},
            format="json",
        )

        self.assertEqual(response.status_code, 403)

    def test_collaborator_cannot_create_onboard_for_other_deal(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.post(
            "/api/onboards/",
            {
                "deal": self.other_deal.id,
                "term_of_end": "2026-06-30",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 403)

    def create_deal(self, user):
        deal = Deal.objects.create(
            user=user,
            stage="active",
            date_start="2026-06-01",
            date_end="2026-06-30",
            deal_amount="100000.00",
            payment_type="cash",
        )
        deal.collaborators.add(user)
        return deal

    def create_onboard(self, deal):
        return Onboard.objects.create(
            deal=deal,
            term_of_end="2026-06-30",
        )

    def create_task(self, category, name):
        return Task.objects.create(
            category=category,
            name=name,
            type="deliverable",
            description="Description",
            date_start="2026-06-01",
            date_end="2026-06-30",
        )

    def task_payload(self, category_id):
        return {
            "category": category_id,
            "name": "New task",
            "type": "deliverable",
            "description": "Description",
            "date_start": "2026-06-01",
            "date_end": "2026-06-30",
        }

    def results(self, response):
        return response.data.get("results", response.data)


class TaskApprovalTelegramTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.media_override = override_settings(MEDIA_ROOT=self.media_root)
        self.media_override.enable()

        self.client = APIClient()
        self.collaborator = get_user_model().objects.create_user(
            username="client-a",
            email="client-a@example.com",
            password="password",
            role=UserRole.COLLABORATOR,
        )
        self.reviewer = get_user_model().objects.create_user(
            username="reviewer",
            email="reviewer@example.com",
            password="password",
            telegram_id=987654321,
            role=UserRole.EMPLOYEE,
        )
        Employee.objects.create(
            user=self.reviewer,
            role="Manager",
            salary="200000.00",
            tasks_can_edit=True,
        )
        self.chat = TelegramChat.objects.create(
            chat_id=-100123456,
            title="CRM approvals",
            type="supergroup",
        )
        TelegramBotConfig.objects.create(
            name="default",
            task_approval_chat=self.chat,
        )
        deal = Deal.objects.create(
            user=self.collaborator,
            stage="active",
            date_start="2026-06-01",
            date_end="2026-06-30",
            deal_amount="100000.00",
            payment_type="cash",
        )
        deal.collaborators.add(self.collaborator)
        onboard = Onboard.objects.create(deal=deal, term_of_end="2026-06-30")
        self.category = TaskCategory.objects.create(name="Delivery", onboard=onboard)

    def tearDown(self):
        self.media_override.disable()
        shutil.rmtree(self.media_root, ignore_errors=True)
        super().tearDown()

    @patch("src.telegram_bot.services.telegram.TelegramClient.send_message_with_result")
    def test_collaborator_task_creation_is_approved_without_telegram_request(
        self,
        send_message,
    ):
        self.client.force_authenticate(self.collaborator)

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                "/api/onboards/tasks/",
                self.task_payload(self.category.id),
                format="json",
            )

        self.assertEqual(response.status_code, 201)
        task = Task.objects.get(pk=response.data["id"])
        self.assertEqual(task.approval_status, Task.ApprovalStatus.APPROVED)
        self.assertEqual(task.approval_action, "")
        self.assertEqual(task.created_by, self.collaborator)
        send_message.assert_not_called()

    @patch("src.telegram_bot.services.telegram.TelegramClient.edit_message_text")
    @patch("src.telegram_bot.services.telegram.TelegramClient.answer_callback_query")
    def test_telegram_approval_callback_approves_pending_task(
        self,
        answer_callback_query,
        edit_message_text,
    ):
        answer_callback_query.return_value = True
        edit_message_text.return_value = True
        task = self.create_pending_task()

        result = TelegramBotService().handle_update(
            self.callback_update("task_approval:approve:%s" % task.id)
        )

        task.refresh_from_db()
        self.assertEqual(result["status"], "success")
        self.assertEqual(task.approval_status, Task.ApprovalStatus.APPROVED)
        self.assertEqual(task.reviewed_by, self.reviewer)
        self.assertIsNotNone(task.reviewed_at)
        self.assertTrue(
            task.audit_logs.filter(
                action=TaskAuditLog.Action.APPROVED,
                actor=self.reviewer,
            ).exists()
        )
        answer_callback_query.assert_called_once()
        edit_message_text.assert_called_once()

    @patch("src.telegram_bot.services.telegram.TelegramClient.edit_message_text")
    @patch("src.telegram_bot.services.telegram.TelegramClient.answer_callback_query")
    def test_telegram_reject_callback_rejects_pending_task(
        self,
        answer_callback_query,
        edit_message_text,
    ):
        answer_callback_query.return_value = True
        edit_message_text.return_value = True
        task = self.create_pending_task()

        result = TelegramBotService().handle_update(
            self.callback_update("task_approval:reject:%s" % task.id)
        )

        task.refresh_from_db()
        self.assertEqual(result["status"], "success")
        self.assertEqual(task.approval_status, Task.ApprovalStatus.REJECTED)
        self.assertFalse(task.is_active)
        self.assertEqual(task.reviewed_by, self.reviewer)
        self.assertTrue(
            task.audit_logs.filter(
                action=TaskAuditLog.Action.REJECTED,
                actor=self.reviewer,
            ).exists()
        )

    @patch("src.telegram_bot.services.telegram.TelegramClient.send_message_with_result")
    def test_collaborator_delete_task_cancels_it_directly(self, send_message):
        task = self.create_approved_task()
        self.client.force_authenticate(self.collaborator)

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(f"/api/onboards/tasks/{task.id}/")

        self.assertEqual(response.status_code, 204)
        task.refresh_from_db()
        self.assertEqual(task.approval_status, Task.ApprovalStatus.CANCELLED)
        self.assertEqual(task.status, Task.Status.CANCELLED)
        self.assertFalse(task.is_active)
        self.assertEqual(task.cancelled_by, self.collaborator)
        send_message.assert_not_called()
        self.assertTrue(
            task.audit_logs.filter(
                action=TaskAuditLog.Action.CANCELLED,
                actor=self.collaborator,
            ).exists()
        )

    @patch("src.telegram_bot.services.telegram.TelegramClient.send_message_with_result")
    def test_collaborator_can_update_task_directly(self, send_message):
        task = self.create_approved_task(status=Task.Status.IN_PROGRESS)
        other_category = TaskCategory.objects.create(
            name="Done",
            onboard=self.category.onboard,
        )
        self.client.force_authenticate(self.collaborator)

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.patch(
                f"/api/onboards/tasks/{task.id}/",
                {
                    "name": "Renamed",
                    "category": other_category.id,
                    "status": Task.Status.CANCELLED,
                },
                format="json",
            )

        self.assertEqual(response.status_code, 200)
        task.refresh_from_db()
        self.assertEqual(task.name, "Renamed")
        self.assertEqual(task.category, other_category)
        self.assertEqual(task.status, Task.Status.CANCELLED)
        self.assertEqual(task.approval_status, Task.ApprovalStatus.APPROVED)
        send_message.assert_not_called()

    @patch("src.telegram_bot.services.telegram.TelegramClient.edit_message_text")
    @patch("src.telegram_bot.services.telegram.TelegramClient.answer_callback_query")
    def test_telegram_approval_callback_approves_task_cancellation(
        self,
        answer_callback_query,
        edit_message_text,
    ):
        answer_callback_query.return_value = True
        edit_message_text.return_value = True
        task = self.create_cancel_pending_task()

        result = TelegramBotService().handle_update(
            self.callback_update("task_approval:approve:%s" % task.id)
        )

        task.refresh_from_db()
        self.assertEqual(result["status"], "success")
        self.assertEqual(task.approval_status, Task.ApprovalStatus.CANCELLED)
        self.assertEqual(task.status, Task.Status.CANCELLED)
        self.assertFalse(task.is_active)
        self.assertEqual(task.cancelled_by, self.collaborator)
        self.assertEqual(task.reviewed_by, self.reviewer)
        self.assertEqual(task.approval_action, "")
        self.assertIsNone(task.approval_requested_by)
        self.assertTrue(
            task.audit_logs.filter(
                action=TaskAuditLog.Action.CANCELLED,
                actor=self.reviewer,
            ).exists()
        )

    @patch("src.telegram_bot.services.telegram.TelegramClient.edit_message_text")
    @patch("src.telegram_bot.services.telegram.TelegramClient.answer_callback_query")
    def test_telegram_reject_callback_rejects_task_cancellation(
        self,
        answer_callback_query,
        edit_message_text,
    ):
        answer_callback_query.return_value = True
        edit_message_text.return_value = True
        task = self.create_cancel_pending_task(status=Task.Status.IN_PROGRESS)

        result = TelegramBotService().handle_update(
            self.callback_update("task_approval:reject:%s" % task.id)
        )

        task.refresh_from_db()
        self.assertEqual(result["status"], "success")
        self.assertEqual(task.approval_status, Task.ApprovalStatus.APPROVED)
        self.assertEqual(task.status, Task.Status.IN_PROGRESS)
        self.assertTrue(task.is_active)
        self.assertIsNone(task.cancelled_by)
        self.assertEqual(task.approval_action, "")
        self.assertIsNone(task.approval_requested_by)
        self.assertTrue(
            task.audit_logs.filter(
                action=TaskAuditLog.Action.REJECTED,
                actor=self.reviewer,
                metadata__approval_action=Task.ApprovalAction.CANCEL,
            ).exists()
        )

    def test_task_attachment_upload_accepts_voice_files(self):
        task = self.create_approved_task()
        self.client.force_authenticate(self.collaborator)
        uploaded = SimpleUploadedFile(
            "note.ogg",
            b"voice-bytes",
            content_type="audio/ogg",
        )

        response = self.client.post(
            f"/api/onboards/tasks/{task.id}/attachments/",
            {"file": uploaded},
            format="multipart",
        )

        self.assertEqual(response.status_code, 201)
        attachment = TaskAttachment.objects.get(task=task)
        self.assertEqual(attachment.kind, TaskAttachment.Kind.VOICE)
        self.assertEqual(attachment.file_name, "note.ogg")
        self.assertEqual(attachment.uploaded_by, self.collaborator)
        self.assertIn("file_url", response.data)
        self.assertTrue(
            task.audit_logs.filter(
                action=TaskAuditLog.Action.ATTACHMENT_ADDED,
                actor=self.collaborator,
            ).exists()
        )

    def create_pending_task(self):
        task = Task.objects.create(
            category=self.category,
            name="Pending task",
            type="deliverable",
            description="Description",
            date_start="2026-06-01",
            date_end="2026-06-30",
            created_by=self.collaborator,
            approval_status=Task.ApprovalStatus.PENDING,
            approval_action=Task.ApprovalAction.CREATE,
            approval_requested_by=self.collaborator,
            approval_requested_at=timezone.now(),
        )
        record = TaskAuditLog.objects.create(
            task=task,
            task_id_snapshot=task.id,
            actor=self.collaborator,
            action=TaskAuditLog.Action.CREATED,
        )
        self.assertEqual(record.task_id_snapshot, task.id)
        return task

    def create_approved_task(self, status=Task.Status.TODO):
        return Task.objects.create(
            category=self.category,
            name="Approved task",
            type="deliverable",
            status=status,
            description="Description",
            date_start="2026-06-01",
            date_end="2026-06-30",
            created_by=self.collaborator,
            approval_status=Task.ApprovalStatus.APPROVED,
        )

    def create_cancel_pending_task(self, status=Task.Status.TODO):
        task = self.create_approved_task(status=status)
        task.approval_status = Task.ApprovalStatus.PENDING
        task.approval_action = Task.ApprovalAction.CANCEL
        task.approval_requested_by = self.collaborator
        task.approval_requested_at = timezone.now()
        task.save(
            update_fields=(
                "approval_status",
                "approval_action",
                "approval_requested_by",
                "approval_requested_at",
                "updated_at",
            )
        )
        return task

    def callback_update(self, data):
        return {
            "update_id": 1000 + len(data),
            "callback_query": {
                "id": "callback-id",
                "from": {
                    "id": self.reviewer.telegram_id,
                    "username": "reviewer",
                },
                "message": {
                    "message_id": 77,
                    "chat": {
                        "id": self.chat.chat_id,
                        "title": self.chat.title,
                        "type": self.chat.type,
                    },
                },
                "data": data,
            },
        }

    def task_payload(self, category_id):
        return {
            "category": category_id,
            "name": "New task",
            "type": "deliverable",
            "description": "Description",
            "date_start": "2026-06-01",
            "date_end": "2026-06-30",
        }


class ClientTaskResponsibleNotificationTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.collaborator = get_user_model().objects.create_user(
            username="client-n",
            email="client-n@example.com",
            password="password",
            role=UserRole.COLLABORATOR,
            first_name="Иван",
            last_name="Клиентов",
        )
        self.responsible = get_user_model().objects.create_user(
            username="resp-with-telegram",
            email="resp-with-telegram@example.com",
            password="password",
            telegram_id=111111,
        )
        self.responsible_without_telegram = get_user_model().objects.create_user(
            username="resp-without-telegram",
            email="resp-without-telegram@example.com",
            password="password",
        )
        self.deal = Deal.objects.create(
            name="Мучной завод",
            user=self.collaborator,
            stage="active",
            date_start="2026-06-01",
            date_end="2026-06-30",
            deal_amount="100000.00",
            payment_type="cash",
        )
        self.deal.collaborators.add(self.collaborator)
        self.deal.responsibles.add(
            self.responsible,
            self.responsible_without_telegram,
        )
        onboard = Onboard.objects.create(deal=self.deal, term_of_end="2026-06-30")
        self.category = TaskCategory.objects.create(name="CRM", onboard=onboard)

    @patch(
        "src.telegram_bot.services.telegram.TelegramClient.send_message",
        return_value=True,
    )
    def test_client_task_creation_notifies_responsibles_with_telegram(
        self,
        send_message,
    ):
        self.client.force_authenticate(self.collaborator)

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                "/api/onboards/tasks/",
                self.task_payload(),
                format="json",
            )

        self.assertEqual(response.status_code, 201)
        send_message.assert_called_once()
        chat_id, text = send_message.call_args.args
        self.assertEqual(chat_id, self.responsible.telegram_id)
        self.assertIn("Новая задача от клиента Иван Клиентов", text)
        self.assertIn("Мучной завод", text)
        self.assertIn("New task", text)
        self.assertNotIn("на согласовании", text)

    @patch(
        "src.telegram_bot.services.telegram.TelegramClient.send_message",
        return_value=True,
    )
    def test_employee_task_creation_does_not_notify_responsibles(self, send_message):
        employee = get_user_model().objects.create_user(
            username="employee-creator",
            email="employee-creator@example.com",
            password="password",
        )
        self.client.force_authenticate(employee)

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                "/api/onboards/tasks/",
                self.task_payload(),
                format="json",
            )

        self.assertEqual(response.status_code, 201)
        send_message.assert_not_called()

    @patch(
        "src.telegram_bot.services.telegram.TelegramClient.send_message",
        side_effect=Exception("telegram down"),
    )
    def test_notification_failure_does_not_break_task_creation(self, send_message):
        self.client.force_authenticate(self.collaborator)

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                "/api/onboards/tasks/",
                self.task_payload(),
                format="json",
            )

        self.assertEqual(response.status_code, 201)
        send_message.assert_called_once()
        self.assertTrue(Task.objects.filter(pk=response.data["id"]).exists())

    @patch(
        "src.telegram_bot.services.telegram.TelegramClient.send_message",
        return_value=True,
    )
    def test_notification_skipped_when_task_has_no_deal(self, send_message):
        from src.telegram_bot.services.task_notifications import (
            notify_responsibles_about_client_task,
        )

        category = TaskCategory.objects.create(name="No deal", onboard=None)
        task = Task.objects.create(
            category=category,
            name="Orphan task",
            type="deliverable",
            date_start="2026-06-01",
            date_end="2026-06-30",
            created_by=self.collaborator,
        )

        notify_responsibles_about_client_task(task.pk)

        send_message.assert_not_called()

    def task_payload(self):
        return {
            "category": self.category.id,
            "name": "New task",
            "type": "deliverable",
            "description": "Description",
            "date_start": "2026-06-01",
            "date_end": "2026-06-30",
        }


class TaskMoveTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.collaborator = get_user_model().objects.create_user(
            username="client-m",
            email="client-m@example.com",
            password="password",
            role=UserRole.COLLABORATOR,
        )
        deal = Deal.objects.create(
            user=self.collaborator,
            stage="active",
            date_start="2026-06-01",
            date_end="2026-06-30",
            deal_amount="100000.00",
            payment_type="cash",
        )
        deal.collaborators.add(self.collaborator)
        onboard = Onboard.objects.create(deal=deal, term_of_end="2026-06-30")
        self.todo = TaskCategory.objects.create(name="Todo", onboard=onboard)
        self.done = TaskCategory.objects.create(name="Done", onboard=onboard)
        self.a = self.create_task(self.todo, "A")
        self.b = self.create_task(self.todo, "B")
        self.c = self.create_task(self.todo, "C")
        self.x = self.create_task(self.done, "X")
        self.y = self.create_task(self.done, "Y")
        self.client.force_authenticate(self.collaborator)

    def test_new_tasks_are_appended_to_their_column(self):
        self.assertEqual(
            [self.a.position, self.b.position, self.c.position],
            [0, 1, 2],
        )
        self.assertEqual([self.x.position, self.y.position], [0, 1])

    def test_move_to_other_column_before_card(self):
        response = self.client.post(
            f"/api/onboards/tasks/{self.c.id}/move/",
            {"category": self.done.id, "before": self.y.id},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.names(self.done), ["X", "C", "Y"])
        self.assertEqual(self.names(self.todo), ["A", "B"])
        self.assertTrue(
            self.c.audit_logs.filter(action=TaskAuditLog.Action.UPDATED).exists()
        )

    def test_move_to_end_of_other_column(self):
        response = self.client.post(
            f"/api/onboards/tasks/{self.a.id}/move/",
            {"category": self.done.id, "before": None},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.names(self.done), ["X", "Y", "A"])

    def test_reorder_inside_column(self):
        response = self.client.post(
            f"/api/onboards/tasks/{self.c.id}/move/",
            {"category": self.todo.id, "before": self.a.id},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.names(self.todo), ["C", "A", "B"])
        self.assertFalse(
            self.c.audit_logs.filter(action=TaskAuditLog.Action.UPDATED).exists()
        )

    def test_move_rejects_column_from_other_onboard(self):
        foreign_onboard = Onboard.objects.create(term_of_end="2026-06-30")
        foreign = TaskCategory.objects.create(name="Foreign", onboard=foreign_onboard)

        response = self.client.post(
            f"/api/onboards/tasks/{self.a.id}/move/",
            {"category": foreign.id},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.a.refresh_from_db()
        self.assertEqual(self.a.category, self.todo)

    def names(self, category):
        return list(
            Task.objects.filter(category=category).values_list("name", flat=True)
        )

    def create_task(self, category, name):
        return Task.objects.create(
            category=category,
            name=name,
            type="deliverable",
            date_start="2026-06-01",
            date_end="2026-06-30",
        )
