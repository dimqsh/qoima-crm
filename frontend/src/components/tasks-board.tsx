"use client";

/**
 * Trello-style tasks board.
 *
 * - Columns are TaskCategories of a given Onboard.
 * - Cards are OnboardTasks belonging to a category, kept in `position` order.
 * - While dragging, the card is moved between columns locally so the target
 *   column opens a gap exactly where it will land; on drop the backend gets
 *   `{category, before}` and renumbers the column.
 * - The whole card is draggable (no separate handle). Tap/click without drag
 *   opens the detail modal.
 * - List-level actions: add a new column, rename, delete (unless locked).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus, Trash2, Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { TaskDetailDialog } from "@/components/task-detail-dialog";
import { cn, formatDate } from "@/lib/utils";
import { asApiError } from "@/lib/api";
import { onboards } from "@/lib/endpoints";
import {
  PRIORITY_LABEL,
  PRIORITY_TONE,
  approvalChip,
  resolvePriority,
  ticketKey,
  typeMeta,
} from "@/lib/task-helpers";
import type { OnboardTask, TaskCategory } from "@/lib/types";

interface TasksBoardProps {
  onboardId: number;
  categories: TaskCategory[];
  /** No task changes at all — cards only open a read-only detail view. */
  readOnly?: boolean;
  /**
   * Columns can't be added, renamed or deleted. Used for clients, who manage
   * tasks (create, edit, move, delete) but not the board structure.
   */
  lockColumns?: boolean;
  /** Called when user clicks "+ Add card" on a column. */
  onAddCard: (categoryId: number) => void;
}

/** Column id → ordered card ids, e.g. { "column-3": ["task-7", "task-9"] }. */
type Columns = Record<string, string[]>;

type CachedOnboard = {
  categories?: TaskCategory[];
  [k: string]: unknown;
} | null;

const columnKey = (id: number) => `column-${id}`;
const cardKey = (id: number) => `task-${id}`;
const idOf = (key: UniqueIdentifier) => Number(String(key).split("-")[1]);

function columnsOf(categories: TaskCategory[]): Columns {
  return Object.fromEntries(
    categories.map((c) => [
      columnKey(c.id),
      (c.tasks ?? []).map((t) => cardKey(t.id)),
    ])
  );
}

function columnOf(cols: Columns, key: UniqueIdentifier) {
  const k = String(key);
  if (k in cols) return k;
  return Object.keys(cols).find((col) => cols[col].includes(k));
}

/** Same move the backend does, applied to the cached onboard. */
function moveInCache(
  cur: CachedOnboard | undefined,
  taskId: number,
  categoryId: number,
  before: number | null
): CachedOnboard | undefined {
  if (!cur?.categories) return cur;
  let task: OnboardTask | undefined;
  const stripped = cur.categories.map((c) => {
    const found = (c.tasks ?? []).find((t) => t.id === taskId);
    if (!found) return c;
    task = found;
    return { ...c, tasks: (c.tasks ?? []).filter((t) => t.id !== taskId) };
  });
  if (!task) return cur;
  const moved = { ...task, category: categoryId };
  return {
    ...cur,
    categories: stripped.map((c) => {
      if (c.id !== categoryId) return c;
      const list = [...(c.tasks ?? [])];
      const at = before == null ? -1 : list.findIndex((t) => t.id === before);
      list.splice(at < 0 ? list.length : at, 0, moved);
      return { ...c, tasks: list };
    }),
  };
}

const emptyUnsubscribe = () => () => {};
const trueSnapshot = () => true;
const falseSnapshot = () => false;

function useMounted() {
  return useSyncExternalStore(emptyUnsubscribe, trueSnapshot, falseSnapshot);
}

export function TasksBoard({
  onboardId,
  categories,
  readOnly,
  lockColumns,
  onAddCard,
}: TasksBoardProps) {
  const qc = useQueryClient();
  const mounted = useMounted();
  const [activeTask, setActiveTask] = useState<OnboardTask | null>(null);
  const [detailTask, setDetailTask] = useState<OnboardTask | null>(null);
  const columnsLocked = readOnly || lockColumns;

  // Pointer sensor with small activation distance — short clicks open the
  // detail modal, longer drags move the card.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const onboardKey = ["onboard", onboardId];

  const baseColumns = useMemo(() => columnsOf(categories), [categories]);
  // Local copy of the layout while a card is in the air; null otherwise.
  const [dragColumns, setDragColumns] = useState<Columns | null>(null);
  const columns = dragColumns ?? baseColumns;
  const [originColumn, setOriginColumn] = useState<string | undefined>();

  const taskByKey = useMemo(() => {
    const map = new Map<string, OnboardTask>();
    for (const c of categories) {
      for (const t of c.tasks ?? []) map.set(cardKey(t.id), t);
    }
    return map;
  }, [categories]);

  const moveTask = useMutation({
    mutationFn: ({
      taskId,
      categoryId,
      before,
    }: {
      taskId: number;
      categoryId: number;
      before: number | null;
      snapshot: CachedOnboard | undefined;
    }) => onboards.moveTask(taskId, { category: categoryId, before }),
    onError: (err, vars) => {
      if (vars.snapshot !== undefined) {
        qc.setQueryData(onboardKey, vars.snapshot);
      }
      toast.error(asApiError(err).message);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: onboardKey });
      qc.invalidateQueries({ queryKey: ["onboards-for-deal"] });
    },
  });

  // Multi-column collision detection (dnd-kit "multiple containers" recipe):
  // when the pointer is over a column, snap to the closest card inside it so
  // the gap opens between cards rather than always at the end.
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const movedToNewColumn = useRef(false);

  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const pointerHits = pointerWithin(args);
      const hits = pointerHits.length > 0 ? pointerHits : rectIntersection(args);
      let overId = getFirstCollision(hits, "id");

      if (overId != null) {
        const inColumn = columns[String(overId)];
        if (inColumn && inColumn.length > 0) {
          overId =
            closestCenter({
              ...args,
              droppableContainers: args.droppableContainers.filter(
                (c) => c.id !== overId && inColumn.includes(String(c.id))
              ),
            })[0]?.id ?? overId;
        }
        lastOverId.current = overId;
        return [{ id: overId }];
      }

      // Layout is shifting right after a column switch — keep the last target.
      if (movedToNewColumn.current) lastOverId.current = args.active.id;
      return lastOverId.current ? [{ id: lastOverId.current }] : [];
    },
    [columns]
  );

  useEffect(() => {
    requestAnimationFrame(() => {
      movedToNewColumn.current = false;
    });
  }, [dragColumns]);

  function resetDrag() {
    setActiveTask(null);
    setDragColumns(null);
    setOriginColumn(undefined);
    lastOverId.current = null;
  }

  function handleDragStart({ active }: DragStartEvent) {
    const task = taskByKey.get(String(active.id));
    if (!task) return;
    setActiveTask(task);
    setDragColumns(baseColumns);
    setOriginColumn(columnOf(baseColumns, active.id));
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over || !dragColumns) return;
    const from = columnOf(dragColumns, active.id);
    const to = columnOf(dragColumns, over.id);
    if (!from || !to || from === to) return;

    const activeKey = String(active.id);
    const target = dragColumns[to];
    const overIndex = target.indexOf(String(over.id));
    let index = target.length;
    if (overIndex >= 0) {
      const dragged = active.rect.current.translated;
      const below =
        dragged && dragged.top > over.rect.top + over.rect.height / 2;
      index = overIndex + (below ? 1 : 0);
    }

    movedToNewColumn.current = true;
    setDragColumns({
      ...dragColumns,
      [from]: dragColumns[from].filter((k) => k !== activeKey),
      [to]: [...target.slice(0, index), activeKey, ...target.slice(index)],
    });
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    const cols = dragColumns;
    const origin = originColumn;
    const activeKey = String(active.id);
    const column = cols ? columnOf(cols, activeKey) : undefined;

    if (!over || !cols || !origin || !column) {
      resetDrag();
      return;
    }

    let order = cols[column];
    if (columnOf(cols, over.id) === column) {
      const from = order.indexOf(activeKey);
      const to = order.indexOf(String(over.id));
      if (to >= 0 && from !== to) order = arrayMove(order, from, to);
    }

    const beforeKey = order[order.indexOf(activeKey) + 1] ?? null;
    const original = baseColumns[origin];
    const originalBefore = original[original.indexOf(activeKey) + 1] ?? null;
    if (column === origin && beforeKey === originalBefore) {
      resetDrag();
      return;
    }

    const taskId = idOf(activeKey);
    const categoryId = idOf(column);
    const before = beforeKey ? idOf(beforeKey) : null;

    // Apply the move to the cache before the drag state is dropped, so the
    // card stays where it was released instead of flashing back.
    qc.cancelQueries({ queryKey: onboardKey });
    const snapshot = qc.getQueryData<CachedOnboard>(onboardKey);
    qc.setQueryData<CachedOnboard>(onboardKey, (cur) =>
      moveInCache(cur, taskId, categoryId, before)
    );
    resetDrag();
    moveTask.mutate({ taskId, categoryId, before, snapshot });
  }

  return (
    <>
      <div className="overflow-x-auto scrollbar-thin -mx-2 px-2 pb-3">
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={resetDrag}
        >
          <div className="flex items-start gap-3 min-w-fit">
            {categories.map((c) => {
              const key = columnKey(c.id);
              const cards = (columns[key] ?? [])
                .map((k) => taskByKey.get(k))
                .filter((t): t is OnboardTask => !!t);
              return (
                <CategoryColumn
                  key={c.id}
                  category={c}
                  cards={cards}
                  isDropTarget={
                    !!activeTask &&
                    key !== originColumn &&
                    cards.some((t) => t.id === activeTask.id)
                  }
                  readOnly={readOnly}
                  columnsLocked={columnsLocked}
                  onAddCard={onAddCard}
                  onOpenTask={(t) => setDetailTask(t)}
                />
              );
            })}
            {!columnsLocked && <AddColumn onboardId={onboardId} />}
          </div>

          {/* Portaled so transformed/animated ancestors can't offset it. */}
          {mounted &&
            createPortal(
              <DragOverlay zIndex={1000}>
                {activeTask ? (
                  <div className="rotate-2 shadow-pop rounded-md cursor-grabbing">
                    <TaskCardVisual t={activeTask} />
                  </div>
                ) : null}
              </DragOverlay>,
              document.body
            )}
        </DndContext>
      </div>

      <TaskDetailDialog
        task={detailTask}
        categories={categories}
        onboardId={onboardId}
        open={!!detailTask}
        onOpenChange={(v) => {
          if (!v) setDetailTask(null);
        }}
        readOnly={readOnly}
      />
    </>
  );
}

/* ---------------------- Column ---------------------- */

function CategoryColumn({
  category,
  cards,
  isDropTarget,
  readOnly,
  columnsLocked,
  onAddCard,
  onOpenTask,
}: {
  category: TaskCategory;
  cards: OnboardTask[];
  isDropTarget: boolean;
  readOnly?: boolean;
  columnsLocked?: boolean;
  onAddCard: (categoryId: number) => void;
  onOpenTask: (task: OnboardTask) => void;
}) {
  const qc = useQueryClient();
  const cardIds = useMemo(() => cards.map((t) => cardKey(t.id)), [cards]);
  // The whole column (header and footer included) accepts drops.
  const { setNodeRef } = useDroppable({ id: columnKey(category.id) });

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(category.name);

  const rename = useMutation({
    mutationFn: (name: string) =>
      onboards.updateCategory(category.id, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["onboard"] });
      qc.invalidateQueries({ queryKey: ["onboards-for-deal"] });
      qc.invalidateQueries({ queryKey: ["onboards"] });
      toast.success("Категория переименована.");
      setRenaming(false);
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const remove = useMutation({
    mutationFn: () => onboards.removeCategory(category.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["onboard"] });
      qc.invalidateQueries({ queryKey: ["onboards-for-deal"] });
      qc.invalidateQueries({ queryKey: ["onboards"] });
      toast.success("Категория удалена.");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "bg-surface-2 border border-hairline rounded-xl flex flex-col w-[280px] sm:w-[300px] shrink-0 max-h-[calc(100dvh-180px)] md:max-h-[calc(100vh-280px)] transition-colors",
        isDropTarget && "border-accent/50 bg-accent-soft/30"
      )}
    >
      {/* Column header */}
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        {renaming ? (
          <form
            className="flex items-center gap-1 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (draftName.trim() && draftName.trim() !== category.name) {
                rename.mutate(draftName.trim());
              } else {
                setRenaming(false);
              }
            }}
          >
            <Input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => {
                if (draftName.trim() && draftName.trim() !== category.name) {
                  rename.mutate(draftName.trim());
                } else {
                  setRenaming(false);
                  setDraftName(category.name);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setRenaming(false);
                  setDraftName(category.name);
                }
              }}
              className="h-7 text-[14px] font-semibold"
            />
          </form>
        ) : (
          <button
            type="button"
            disabled={columnsLocked}
            onClick={() => !columnsLocked && setRenaming(true)}
            className="flex items-center gap-2 flex-1 text-left h-7 min-w-0"
            title={columnsLocked ? undefined : "Переименовать"}
          >
            <span className="text-[14px] font-semibold text-ink truncate">
              {category.name}
            </span>
            <span className="text-[12px] text-ink-3 tabular-nums">
              {cards.length}
            </span>
          </button>
        )}
        {!columnsLocked && !renaming && (
          <button
            type="button"
            onClick={() => {
              const msg =
                cards.length > 0
                  ? `Удалить категорию «${category.name}» и ${cards.length} задач(и) внутри?`
                  : `Удалить категорию «${category.name}»?`;
              if (confirm(msg)) remove.mutate();
            }}
            className="h-6 w-6 grid place-items-center rounded text-ink-4 hover:text-danger hover:bg-tag-red-bg/30 transition-colors"
            aria-label="Удалить категорию"
            title="Удалить категорию"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Cards (sortable inside the column) */}
      <SortableContext
        id={columnKey(category.id)}
        items={cardIds}
        strategy={verticalListSortingStrategy}
      >
        <div className="px-2 pb-2 flex flex-col gap-2 flex-1 min-h-[60px] overflow-y-auto scrollbar-thin">
          {cards.length === 0 && (
            <div className="text-[13px] text-ink-4 text-center py-8 px-3 border border-dashed border-hairline rounded-md">
              Перетащите задачу сюда
            </div>
          )}
          {cards.map((t) => (
            <SortableTaskCard
              key={t.id}
              t={t}
              readOnly={readOnly}
              onOpen={() => onOpenTask(t)}
            />
          ))}
        </div>
      </SortableContext>

      {/* Footer — Add card */}
      {!readOnly && (
        <button
          type="button"
          onClick={() => onAddCard(category.id)}
          className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors rounded-b-xl border-t border-hairline"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить карточку
        </button>
      )}
    </div>
  );
}

/* ---------------------- Add Column ---------------------- */

function AddColumn({ onboardId }: { onboardId: number }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: (name: string) =>
      onboards.createCategory({ name, onboard: onboardId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["onboard"] });
      qc.invalidateQueries({ queryKey: ["onboards-for-deal"] });
      qc.invalidateQueries({ queryKey: ["onboards"] });
      toast.success("Категория создана.");
      setName("");
      setAdding(false);
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="w-[280px] sm:w-[300px] shrink-0 h-10 grid place-items-center text-[13px] text-ink-3 hover:text-ink bg-surface/60 hover:bg-surface border border-dashed border-hairline-strong rounded-xl transition-colors"
      >
        <span className="inline-flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Новая категория
        </span>
      </button>
    );
  }

  return (
    <form
      className="bg-surface-2 border border-hairline-strong rounded-xl p-2 w-[280px] sm:w-[300px] shrink-0 flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate(name.trim());
      }}
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Название категории"
        className="h-8 text-[13px]"
      />
      <Button
        type="submit"
        variant="primary"
        size="icon"
        disabled={!name.trim() || create.isPending}
        title="Создать"
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => {
          setName("");
          setAdding(false);
        }}
        title="Отмена"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}

/* ---------------------- Sortable Card ---------------------- *
 *
 * The card itself is the drag handle — that's the Trello pattern. To still
 * detect clicks for opening the detail modal, we rely on dnd-kit's pointer
 * activation distance (6px). If the user moves more than 6px, it's a drag and
 * the click handler won't fire (we bail in onClick when isDragging was true).
 */

function SortableTaskCard({
  t,
  readOnly,
  onOpen,
}: {
  t: OnboardTask;
  readOnly?: boolean;
  onOpen: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: cardKey(t.id),
    disabled: readOnly,
  });

  // Translate (not Transform): cards have different heights, and a scale
  // component would squash neighbours while they shift.
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => {
        if (isDragging) return;
        onOpen();
      }}
      className={cn(
        "touch-none select-none rounded-md",
        // The card's slot stays visible as a drop placeholder.
        isDragging && "opacity-40 outline-2 outline-dashed outline-accent/60",
        readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
      )}
    >
      <TaskCardVisual t={t} />
    </div>
  );
}

/* ---------------------- Card visual (Trello-style) ---------------------- */

function TaskCardVisual({ t }: { t: OnboardTask }) {
  const tm = typeMeta(t.type);
  const priority = resolvePriority(t);
  const isDone = !t.is_active;
  const chip = approvalChip(t);
  const approval = t.approval_status;
  const isPendingCreate =
    approval === "pending" && t.approval_action !== "cancel";
  const isPendingCancel =
    approval === "pending" && t.approval_action === "cancel";
  const isRejected = approval === "rejected";
  const isCancelled = approval === "cancelled" || t.status === "cancelled";

  // Trello-style: chunky colored labels at the top of the card.
  const labels: { color: string; tooltip: string }[] = [
    { color: LABEL_COLORS[tm.tone] ?? "#9b9a94", tooltip: tm.label },
    {
      color: PRIORITY_LABEL_COLOR[priority],
      tooltip: PRIORITY_LABEL[priority],
    },
  ];

  return (
    <div
      className={cn(
        "group relative bg-canvas border border-hairline rounded-md p-2.5 hover:border-hairline-strong hover:shadow-card transition-all",
        isDone && "opacity-70",
        isPendingCreate && "border-warn/40 ring-1 ring-warn/20",
        isPendingCancel && "border-orange-400/40 ring-1 ring-orange-300/20",
        isRejected && "border-danger/40 ring-1 ring-danger/20",
        isCancelled && "opacity-60"
      )}
    >
      {/* Top labels */}
      <div className="flex items-center gap-1 mb-2 flex-wrap">
        {labels.map((l, i) => (
          <span
            key={i}
            title={l.tooltip}
            className="h-2 min-w-[36px] rounded-sm"
            style={{ background: l.color }}
          />
        ))}
        {isDone && (
          <span
            className="h-2 min-w-[36px] rounded-sm bg-success"
            title="Выполнено"
          />
        )}
      </div>

      {chip && chip.short !== "одобрено" && (
        <div className="mb-2">
          <Badge tone={chip.tone} className="text-[11px]">
            {chip.short}
          </Badge>
        </div>
      )}

      {/* Title */}
      <div
        className={cn(
          "text-[14px] leading-snug font-medium text-ink",
          isDone && "line-through text-ink-3"
        )}
      >
        {t.name}
      </div>

      {/* Sub-labels for hover detail */}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <Badge tone={tm.tone} className="text-[11px]">
          <span>{tm.emoji}</span>
          {tm.label}
        </Badge>
        <Badge tone={PRIORITY_TONE[priority]} className="text-[11px]">
          {PRIORITY_LABEL[priority]}
        </Badge>
      </div>

      {/* Footer */}
      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] text-ink-4">
          <span className="font-mono tabular-nums">{ticketKey(t)}</span>
          <span className="tabular-nums">
            {formatDate(t.date_end, { month: "short", day: "2-digit" })}
          </span>
        </div>
        <AssigneeStack task={t} />
      </div>
    </div>
  );
}

function AssigneeStack({ task }: { task: OnboardTask }) {
  // Prefer performance[] (real backend), fall back to legacy single assignee.
  const items: { id: number; name: string }[] = [];
  if (task.performance && task.performance.length > 0) {
    for (const p of task.performance) {
      const u = p.user_detail;
      const name = u
        ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() ||
          u.username ||
          `User #${p.user}`
        : `User #${p.user}`;
      items.push({ id: p.user, name });
    }
  } else if (task.assignee) {
    items.push({ id: task.assignee.id, name: task.assignee.name });
  }
  if (items.length === 0) return null;
  const visible = items.slice(0, 3);
  const extra = items.length - visible.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((it) => (
        <Avatar
          key={it.id}
          name={it.name}
          size={22}
          className="text-[10px] ring-2 ring-canvas"
        />
      ))}
      {extra > 0 && (
        <span className="h-[22px] min-w-[22px] px-1.5 grid place-items-center rounded-full bg-surface-3 text-[10px] font-medium text-ink-3 ring-2 ring-canvas">
          +{extra}
        </span>
      )}
    </div>
  );
}

/* ---------------------- Constants ---------------------- */

const LABEL_COLORS: Record<string, string> = {
  blue: "#2383E2",
  green: "#3D9C47",
  purple: "#7C5CC4",
  orange: "#E08A3A",
  gray: "#9B9A94",
  red: "#D8473A",
  yellow: "#C5A23E",
  brown: "#A87A55",
  pink: "#C95A8B",
};

const PRIORITY_LABEL_COLOR = {
  urgent: "#D8473A",
  high: "#E08A3A",
  medium: "#C5A23E",
  low: "#9B9A94",
};
