import shutil
import tempfile

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.test.utils import override_settings
from rest_framework.test import APIClient

from core.enums import UserRole
from src.deals.models import Deal, DealFile, DealLink, DealPayment, DealStage
from src.employees.models import Employee
from src.incomes.services import sync_payment_income
from src.onboards.models import Task, TaskPerformance


class CollaboratorDealAccessTests(TestCase):
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
        self.shared_collaborator = get_user_model().objects.create_user(
            username="client-c",
            email="client-c@example.com",
            password="password",
            role=UserRole.COLLABORATOR,
        )
        self.own_deal = self.create_deal(self.collaborator)
        self.other_deal = self.create_deal(self.other_collaborator)

    def test_collaborator_sees_only_attached_deals(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.get("/api/deals/")

        self.assertEqual(response.status_code, 200)
        deal_ids = {item["id"] for item in self.results(response)}
        self.assertEqual(deal_ids, {self.own_deal.id})

    def test_collaborator_cannot_retrieve_other_collaborator_deal(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.get(f"/api/deals/{self.other_deal.id}/")

        self.assertEqual(response.status_code, 404)

    def test_collaborator_created_deal_is_attached_to_request_user(self):
        self.client.force_authenticate(self.collaborator)

        response = self.client.post(
            "/api/deals/",
            {
                "stage": "active",
                "date_start": "2026-06-01",
                "date_end": "2026-06-30",
                "deal_amount": "150000.00",
                "payment_type": "cash",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        deal = Deal.objects.get(pk=response.data["id"])
        self.assertEqual(deal.user, self.collaborator)
        self.assertEqual(list(deal.collaborators.all()), [self.collaborator])

    def test_collaborator_sees_deals_from_collaborators_many_to_many(self):
        shared_deal = self.create_deal(
            self.other_collaborator,
            collaborators=[self.collaborator, self.shared_collaborator],
        )
        self.client.force_authenticate(self.collaborator)

        response = self.client.get("/api/deals/")

        self.assertEqual(response.status_code, 200)
        deal_ids = {item["id"] for item in self.results(response)}
        self.assertEqual(deal_ids, {self.own_deal.id, shared_deal.id})

    def test_user_filter_matches_primary_and_many_to_many_collaborators(self):
        shared_deal = self.create_deal(
            self.other_collaborator,
            collaborators=[self.collaborator],
        )
        self.client.force_authenticate(self.collaborator)

        response = self.client.get(f"/api/deals/?user={self.collaborator.id}")

        self.assertEqual(response.status_code, 200)
        deal_ids = {item["id"] for item in self.results(response)}
        self.assertEqual(deal_ids, {self.own_deal.id, shared_deal.id})

    def create_deal(self, user, collaborators=None):
        deal = Deal.objects.create(
            user=user,
            stage="active",
            date_start="2026-06-01",
            date_end="2026-06-30",
            deal_amount="100000.00",
            payment_type="cash",
        )
        deal.collaborators.add(user)

        if collaborators:
            deal.collaborators.add(*collaborators)

        return deal

    def results(self, response):
        return response.data.get("results", response.data)


class ProjectFeatureTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp()
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()

        self.client = APIClient()
        self.admin = get_user_model().objects.create_superuser(
            username="admin",
            email="admin@example.com",
            password="password",
            role=UserRole.EMPLOYEE,
        )
        self.client_user = get_user_model().objects.create_user(
            username="client",
            email="client@example.com",
            password="password",
            role=UserRole.COLLABORATOR,
        )
        self.responsible = get_user_model().objects.create_user(
            username="kevin",
            email="kevin@example.com",
            password="password",
            first_name="Кевин",
            role=UserRole.EMPLOYEE,
        )
        self.client.force_authenticate(self.admin)

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media_root)

    def test_project_alias_creates_named_project_with_responsibles(self):
        response = self.client.post(
            "/api/projects/",
            {
                "name": "CRM для «Алтын Маркет»",
                "user": self.client_user.id,
                "responsibles": [self.responsible.id],
                "stage": "active",
                "date_start": "2026-06-01",
                "date_end": "2026-08-20",
                "deal_amount": "2800000.00",
                "payment_type": "card",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["name"], "CRM для «Алтын Маркет»")
        self.assertEqual(response.data["responsibles"], [self.responsible.id])
        self.assertEqual(
            response.data["responsible_details"][0]["username"],
            self.responsible.username,
        )

    def test_project_can_be_created_without_client(self):
        response = self.client.post(
            "/api/projects/",
            {
                "name": "Внутренний проект",
                "responsibles": [self.responsible.id],
                "stage": "active",
                "date_start": "2026-06-01",
                "date_end": "2026-08-20",
                "deal_amount": "500000.00",
                "payment_type": "card",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertIsNone(response.data["user"])
        self.assertEqual(response.data["collaborators"], [])
        self.assertEqual(response.data["name"], "Внутренний проект")

    def test_project_stages_links_and_files_are_returned_on_project(self):
        deal = self.create_project()

        stage_response = self.client.post(
            f"/api/projects/{deal.id}/stages/",
            {
                "name": "Разработка",
                "status": "in_progress",
                "order": 3,
                "responsible": self.responsible.id,
                "due_date": "2026-08-20",
            },
            format="json",
        )
        link_response = self.client.post(
            f"/api/projects/{deal.id}/links/",
            {
                "title": "Figma",
                "url": "https://example.com/figma",
                "description": "Макеты проекта",
            },
            format="json",
        )
        file_response = self.client.post(
            f"/api/projects/{deal.id}/files/",
            {
                "file_name": "brief.txt",
                "file": SimpleUploadedFile(
                    "brief.txt",
                    b"project brief",
                    content_type="text/plain",
                ),
            },
            format="multipart",
        )

        self.assertEqual(stage_response.status_code, 201)
        self.assertEqual(link_response.status_code, 201)
        self.assertEqual(file_response.status_code, 201)
        self.assertEqual(DealStage.objects.filter(deal=deal).count(), 1)
        self.assertEqual(DealLink.objects.filter(deal=deal).count(), 1)
        self.assertEqual(DealFile.objects.filter(deal=deal).count(), 1)

        response = self.client.get(f"/api/projects/{deal.id}/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["current_stage_name"], "Разработка")
        self.assertEqual(response.data["stages"][0]["responsible"], self.responsible.id)
        self.assertEqual(response.data["links"][0]["title"], "Figma")
        self.assertEqual(response.data["files"][0]["file_name"], "brief.txt")

    def test_project_stage_can_have_sub_stages(self):
        deal = self.create_project()
        parent = DealStage.objects.create(
            deal=deal,
            name="Согласование КП",
            status=DealStage.Status.IN_PROGRESS,
            order=1,
        )

        response = self.client.post(
            f"/api/projects/{deal.id}/stages/",
            {
                "parent_stage": parent.id,
                "name": "Подготовить договор",
                "status": DealStage.Status.PENDING,
                "order": 1,
                "responsible": self.responsible.id,
                "due_date": "2026-08-01",
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["parent_stage"], parent.id)
        child = DealStage.objects.get(pk=response.data["id"])
        self.assertEqual(child.parent_stage, parent)
        task = Task.objects.get(deal_stage=child)
        self.assertEqual(response.data["task"], task.id)
        self.assertEqual(task.name, "Подготовить договор")
        self.assertEqual(task.type, "project_sub_stage")
        self.assertEqual(task.status, Task.Status.TODO)
        self.assertEqual(str(task.date_start), "2026-06-01")
        self.assertEqual(str(task.date_end), "2026-08-01")
        self.assertEqual(task.category.name, "Project sub-stages")
        self.assertEqual(task.category.onboard.deal, deal)
        self.assertTrue(
            TaskPerformance.objects.filter(
                task=task,
                user=self.responsible,
            ).exists()
        )

    def test_project_stage_parent_must_belong_to_same_project(self):
        deal = self.create_project()
        other_deal = self.create_project()
        parent = DealStage.objects.create(
            deal=other_deal,
            name="Другой проект",
            status=DealStage.Status.PENDING,
            order=1,
        )

        response = self.client.post(
            f"/api/projects/{deal.id}/stages/",
            {
                "parent_stage": parent.id,
                "name": "Неверный подэтап",
                "status": DealStage.Status.PENDING,
                "order": 1,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("parent_stage", response.data)

    def test_project_stage_status_can_be_patched(self):
        deal = self.create_project()
        stage = DealStage.objects.create(
            deal=deal,
            name="Разработка",
            status=DealStage.Status.PENDING,
            order=1,
        )

        response = self.client.patch(
            f"/api/projects/{deal.id}/stages/{stage.id}/",
            {"status": DealStage.Status.IN_PROGRESS},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["status"], DealStage.Status.IN_PROGRESS)
        stage.refresh_from_db()
        self.assertEqual(stage.status, DealStage.Status.IN_PROGRESS)

    def test_project_amounts_are_masked_without_amount_permission(self):
        deal = self.create_project()
        payment = DealPayment.objects.create(
            deal=deal,
            amount="700000.00",
            payment_date="2026-06-05",
        )
        payment.refresh_from_db()
        sync_payment_income(payment)
        employee_user = get_user_model().objects.create_user(
            username="manager",
            email="manager@example.com",
            password="password",
            role=UserRole.EMPLOYEE,
        )
        employee = Employee.objects.create(
            user=employee_user,
            role="Manager",
            salary="100000.00",
        )

        self.client.force_authenticate(employee_user)
        response = self.client.get(f"/api/projects/{deal.id}/")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["can_view_amount"])
        self.assertIsNone(response.data["deal_amount"])
        self.assertIsNone(response.data["paid_to_date"])
        self.assertIsNone(response.data["remaining"])
        self.assertIsNone(response.data["payments"][0]["amount"])

        employee.deals_can_view_amount = True
        employee.save(update_fields=("deals_can_view_amount",))
        response = self.client.get(f"/api/projects/{deal.id}/")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["can_view_amount"])
        self.assertEqual(response.data["deal_amount"], "2800000.00")
        self.assertEqual(response.data["paid_to_date"], "700000.00")
        self.assertEqual(response.data["remaining"], "2100000.00")
        self.assertEqual(response.data["payments"][0]["amount"], "700000.00")

    def test_project_can_be_archived_and_unarchived(self):
        deal = self.create_project()

        response = self.client.patch(
            f"/api/projects/{deal.id}/",
            {"is_archived": True},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data["is_archived"])
        deal.refresh_from_db()
        self.assertTrue(deal.is_archived)

        response = self.client.patch(
            f"/api/projects/{deal.id}/",
            {"is_archived": False},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        deal.refresh_from_db()
        self.assertFalse(deal.is_archived)

    def create_project(self):
        deal = Deal.objects.create(
            name="CRM для «Алтын Маркет»",
            user=self.client_user,
            stage="active",
            date_start="2026-06-01",
            date_end="2026-08-20",
            deal_amount="2800000.00",
            payment_type="card",
        )
        deal.collaborators.add(self.client_user)
        deal.responsibles.add(self.responsible)
        return deal


class StageStatusPermissionTests(TestCase):
    """An assignee may change ONLY the status of their own stage without the
    deals_can_update flag (used by the dashboard my-tasks modal)."""

    def setUp(self):
        self.client = APIClient()
        self.responsible = get_user_model().objects.create_user(
            username="assignee",
            email="assignee@example.com",
            password="password",
            role=UserRole.EMPLOYEE,
        )
        self.outsider = get_user_model().objects.create_user(
            username="outsider",
            email="outsider@example.com",
            password="password",
            role=UserRole.EMPLOYEE,
        )
        self.deal = Deal.objects.create(
            name="Проект",
            stage="active",
            date_start="2026-06-01",
            date_end="2026-08-20",
            deal_amount="100000.00",
            payment_type="card",
        )
        self.stage = DealStage.objects.create(
            deal=self.deal,
            name="Разработка",
            status=DealStage.Status.PENDING,
            order=1,
            responsible=self.responsible,
        )

    def stage_url(self):
        return f"/api/projects/{self.deal.id}/stages/{self.stage.id}/"

    def test_stage_responsible_can_change_status_without_flag(self):
        self.client.force_authenticate(self.responsible)

        response = self.client.patch(
            self.stage_url(),
            {"status": DealStage.Status.COMPLETED},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.stage.refresh_from_db()
        self.assertEqual(self.stage.status, DealStage.Status.COMPLETED)

    def test_task_assignee_can_change_status_without_flag(self):
        parent = DealStage.objects.create(
            deal=self.deal,
            name="Родитель",
            status=DealStage.Status.PENDING,
            order=2,
        )
        sub_stage = DealStage.objects.create(
            deal=self.deal,
            parent_stage=parent,
            name="Подэтап",
            status=DealStage.Status.PENDING,
            order=1,
        )
        from src.deals.services import ensure_task_for_sub_stage

        task = ensure_task_for_sub_stage(sub_stage)
        TaskPerformance.objects.create(task=task, user=self.outsider)
        self.client.force_authenticate(self.outsider)

        response = self.client.patch(
            f"/api/projects/{self.deal.id}/stages/{sub_stage.id}/",
            {"status": DealStage.Status.IN_PROGRESS},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        sub_stage.refresh_from_db()
        task.refresh_from_db()
        self.assertEqual(sub_stage.status, DealStage.Status.IN_PROGRESS)
        self.assertEqual(task.status, Task.Status.IN_PROGRESS)

    def test_stage_responsible_cannot_change_other_fields_without_flag(self):
        self.client.force_authenticate(self.responsible)

        response = self.client.patch(
            self.stage_url(),
            {"status": DealStage.Status.COMPLETED, "name": "Другое имя"},
            format="json",
        )

        self.assertEqual(response.status_code, 403)

    def test_unrelated_employee_cannot_change_status_without_flag(self):
        self.client.force_authenticate(self.outsider)

        response = self.client.patch(
            self.stage_url(),
            {"status": DealStage.Status.COMPLETED},
            format="json",
        )

        self.assertEqual(response.status_code, 403)
