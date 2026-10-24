"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { onboards } from "@/lib/endpoints";
import { asApiError } from "@/lib/api";
import { cn, formatBytes } from "@/lib/utils";
import { VoiceRecorder } from "@/components/voice-recorder";
import { Loader2, Paperclip, Plus, X } from "lucide-react";
import type {
  OnboardTaskCreate,
  TaskCategory,
  TaskStatus,
} from "@/lib/types";

const TASK_TYPES = [
  "research",
  "deliverable",
  "design",
  "infra",
  "data",
  "integration",
  "qa",
  "review",
  "compliance",
  "training",
  "rollout",
];

type CategoryMode = "existing" | "new";

export function AddTaskDialog({
  open,
  onOpenChange,
  onboardId,
  categories,
  defaultStatus,
  defaultCategoryId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Onboard the task (and any new category) will be attached to. */
  onboardId: number;
  /** Existing categories to pick from. */
  categories: TaskCategory[];
  /** Pre-select column when opening from a Kanban "+" button. */
  defaultStatus?: TaskStatus;
  /** Pre-select category if opening from a per-category "+" button. */
  defaultCategoryId?: number;
}) {
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [type, setType] = useState("deliverable");
  const [description, setDescription] = useState("");
  const [dateStart, setDateStart] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [dateEnd, setDateEnd] = useState("");
  const [files, setFiles] = useState<File[]>([]);

  // Category picker: existing or freshly-typed
  const initialMode: CategoryMode = categories.length === 0 ? "new" : "existing";
  const [categoryMode, setCategoryMode] = useState<CategoryMode>(initialMode);
  const [categoryId, setCategoryId] = useState<number | "">(
    defaultCategoryId ?? categories[0]?.id ?? ""
  );
  const [newCategoryName, setNewCategoryName] = useState("");

  // is_active still flips with status (backend keeps the legacy boolean in
  // sync, but old code paths read it directly):
  //   todo / in_progress / in_review → true (still active)
  //   done / cancelled               → false
  const isActive = defaultStatus !== "done" && defaultStatus !== "cancelled";

  function reset() {
    setName("");
    setType("deliverable");
    setDescription("");
    setDateStart(new Date().toISOString().slice(0, 10));
    setDateEnd("");
    setFiles([]);
    setCategoryMode(categories.length === 0 ? "new" : "existing");
    setCategoryId(categories[0]?.id ?? "");
    setNewCategoryName("");
  }

  const mutation = useMutation({
    mutationFn: async () => {
      // 1. Resolve category — create on the fly if requested.
      let resolvedCategoryId: number;
      if (categoryMode === "new") {
        const cat = await onboards.createCategory({
          name: newCategoryName.trim(),
          onboard: onboardId,
        });
        resolvedCategoryId = cat.id;
      } else {
        if (categoryId === "") throw new Error("Выберите категорию.");
        resolvedCategoryId = categoryId;
      }

      // 2. Create the task. Description is optional — omit when empty.
      const trimmedDescription = description.trim();
      const payload: OnboardTaskCreate = {
        category: resolvedCategoryId,
        name: name.trim(),
        type: type.trim(),
        date_start: dateStart,
        date_end: dateEnd,
        is_active: isActive,
      };
      if (trimmedDescription) payload.description = trimmedDescription;
      if (defaultStatus) payload.status = defaultStatus;

      const task = await onboards.createTask(payload);

      // 3. If files were attached, upload them to the new task.
      if (files.length > 0) {
        const form = new FormData();
        for (const f of files) form.append("files", f);
        try {
          await onboards.uploadTaskAttachment(task.id, form);
        } catch (err) {
          // Task created but attachment failed — surface, don't throw, so the
          // dialog still closes and the user sees the task.
          toast.error(
            `Задача создана, но вложение не загрузилось: ${asApiError(err).message}`
          );
        }
      }
      return task;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["onboard"] });
      qc.invalidateQueries({ queryKey: ["onboards-for-deal"] });
      qc.invalidateQueries({ queryKey: ["onboards"] });
      toast.success("Задача создана.");
      onOpenChange(false);
      reset();
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const canSubmit =
    !!name &&
    !!dateEnd &&
    (categoryMode === "existing"
      ? categoryId !== ""
      : !!newCategoryName.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[540px]">
        <DialogHeader
          eyebrow="Задача · Новая"
          title="Создать задачу"
          description="Задача добавится в выбранную категорию плана работ этого проекта."
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto scrollbar-thin pr-1"
        >
          <Field label="Название">
            <Input
              placeholder="например, Согласовать ТЗ с клиентом"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </Field>

          {/* Category picker */}
          <div>
            <label className="block text-[12px] font-medium text-ink-2 mb-1.5">
              Категория
            </label>
            <div className="inline-flex bg-surface-2 border border-hairline rounded-md p-0.5 mb-2">
              <ModeChip
                active={categoryMode === "existing"}
                onClick={() => setCategoryMode("existing")}
                label="Существующая"
                disabled={categories.length === 0}
              />
              <ModeChip
                active={categoryMode === "new"}
                onClick={() => setCategoryMode("new")}
                label="Новая"
              />
            </div>
            {categoryMode === "existing" ? (
              <select
                className="h-9 w-full bg-canvas border border-hairline-strong rounded-md px-3 text-[14px] text-ink hover:border-ink-5 focus:border-accent focus:shadow-[0_0_0_3px_rgba(35,131,226,0.18)] outline-none transition-all cursor-pointer"
                value={categoryId === "" ? "" : String(categoryId)}
                onChange={(e) =>
                  setCategoryId(e.target.value ? Number(e.target.value) : "")
                }
                required={categoryMode === "existing"}
              >
                <option value="">— выберите категорию —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                placeholder="например, Discovery, Setup, Go-live"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                required={categoryMode === "new"}
              />
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Тип">
              <select
                className="h-9 w-full bg-canvas border border-hairline-strong rounded-md px-3 text-[14px] text-ink hover:border-ink-5 focus:border-accent focus:shadow-[0_0_0_3px_rgba(35,131,226,0.18)] outline-none transition-all cursor-pointer"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Срок">
              <Input
                type="date"
                value={dateEnd}
                onChange={(e) => setDateEnd(e.target.value)}
                required
              />
            </Field>
          </div>

          <Field label="Дата начала">
            <Input
              type="date"
              value={dateStart}
              onChange={(e) => setDateStart(e.target.value)}
              required
            />
          </Field>

          <Field label="Описание (необязательно)">
            <Textarea
              placeholder="Что нужно сделать?"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <AttachmentPicker files={files} onChange={setFiles} />

          <VoiceRecorder
            onRecorded={(audio) => setFiles((prev) => [...prev, audio])}
          />

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => onOpenChange(false)}
            >
              Отмена
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={mutation.isPending || !canSubmit}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Создаём…
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  Создать
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModeChip({
  active,
  onClick,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-7 px-3 text-[13px] rounded transition-colors",
        active
          ? "bg-canvas text-ink shadow-sm font-medium"
          : "text-ink-3 hover:text-ink",
        disabled && "opacity-40 cursor-not-allowed hover:text-ink-3"
      )}
    >
      {label}
    </button>
  );
}

function AttachmentPicker({
  files,
  onChange,
}: {
  files: File[];
  onChange: (next: File[]) => void;
}) {
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length === 0) return;
    onChange([...files, ...picked]);
    // Reset the input so re-picking the same file re-fires onChange.
    e.target.value = "";
  }

  function remove(idx: number) {
    onChange(files.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <label className="block text-[12px] font-medium text-ink-2 mb-1.5">
        Вложения (необязательно)
      </label>

      {files.length > 0 && (
        <ul className="space-y-1.5 mb-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center gap-2 px-2 h-8 rounded-md bg-surface-2 border border-hairline"
            >
              <Paperclip className="h-3 w-3 text-ink-3 shrink-0" />
              <span className="flex-1 text-[12px] text-ink-2 truncate">
                {f.name}
              </span>
              <span className="text-[11px] text-ink-4 tabular-nums">
                {formatBytes(f.size)}
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="h-5 w-5 grid place-items-center rounded text-ink-4 hover:text-danger hover:bg-tag-red-bg/30"
                aria-label="Удалить из списка"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-dashed border-hairline-strong text-[13px] text-ink-3 hover:text-ink hover:bg-surface-2 cursor-pointer transition-colors">
        <Paperclip className="h-3.5 w-3.5" />
        Добавить файл
        <input
          type="file"
          multiple
          onChange={onPick}
          className="sr-only"
        />
      </label>
      <p className="mt-1 text-[11px] text-ink-4">
        Файлы загрузятся после создания задачи. Аудио-файлы будут помечены как
        голосовое сообщение.
      </p>
    </div>
  );
}
