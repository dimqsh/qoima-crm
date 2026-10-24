import logging

from src.onboards.models import Task
from src.telegram_bot.services.telegram import TelegramClient

logger = logging.getLogger(__name__)


def notify_responsibles_about_client_task(task_id: int) -> None:
    """Personally notify the deal's responsible employees about a new
    client-created task. Failures must never break task creation."""
    task = (
        Task.objects.select_related("category__onboard__deal", "created_by")
        .filter(pk=task_id)
        .first()
    )

    if not task:
        return

    category = task.category
    onboard = category.onboard if category else None
    deal = onboard.deal if onboard else None

    if not deal:
        logger.info(
            "Task %s is not linked to a deal; skipping responsible notification.",
            task_id,
        )
        return

    responsibles = [user for user in deal.responsibles.all() if user.telegram_id]

    if not responsibles:
        logger.info(
            "Deal %s has no responsibles with linked Telegram; skipping.",
            deal.pk,
        )
        return

    text = _client_task_message(task, deal)
    client = TelegramClient()

    for responsible in responsibles:
        try:
            client.send_message(responsible.telegram_id, text)
        except Exception:
            logger.exception(
                "Failed to notify responsible %s about task %s.",
                responsible.pk,
                task_id,
            )


def _client_task_message(task: Task, deal) -> str:
    creator = task.created_by
    client_label = (
        (creator.get_full_name() or creator.email or creator.username)
        if creator
        else "клиент"
    )
    deal_label = deal.name or f"#{deal.pk}"
    return "\n".join(
        [
            f"🆕 Новая задача от клиента {client_label}",
            f"Проект: {deal_label}",
            f"Задача: {task.name} (срок: {task.date_end.isoformat()})",
        ]
    )
