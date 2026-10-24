"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Topbar } from "@/components/app-shell/topbar";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, THead, TR, TH, TD } from "@/components/ui/table";
import { Avatar } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Input, Field } from "@/components/ui/input";
import { PermissionDenied } from "@/components/permission-gate";
import { AddPaymentDialog } from "./payment-dialog";
import { AddTaskDialog } from "./task-dialog";
import { EditDealDialog } from "./edit-deal-dialog";
import { TasksBoard } from "@/components/tasks-board";
import { asApiError } from "@/lib/api";
import { deals, onboards, users } from "@/lib/endpoints";
import {
  useCurrentUser,
  useRole,
  useIsSuperuser,
  useHasPermission,
} from "@/lib/permissions";
import { formatCurrency, formatDate, cn, plural } from "@/lib/utils";
import {
  dealClientName,
  paymentTypeLabel,
  projectName,
  projectStageStatusLabel,
  stageLabel,
} from "@/lib/deal-labels";
import { userDisplayName, userIdOf } from "@/lib/user-helpers";
import {
  PRIORITY_LABEL,
  PRIORITY_TONE,
  STATUS_TONE,
  TASK_COLUMNS,
  approvalChip,
  resolveApprovalStatus,
  resolvePriority,
  resolveStatus,
  ticketKey,
  typeMeta,
} from "@/lib/task-helpers";
import {
  ArrowLeft,
  FileText,
  Download,
  Check,
  CheckCircle2,
  Clock,
  Plus,
  LayoutGrid,
  List as ListIcon,
  Filter,
  Pencil,
  Search,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import type {
  Deal,
  DealFile,
  DealFileCreate,
  DealLink,
  DealLinkCreate,
  DealPayment,
  DealPaymentCreate,
  DealStage,
  DealStageCreate,
  DealStageStatus,
  Onboard,
  OnboardTask,
  TaskCategory,
} from "@/lib/types";

const MASKED_AMOUNT = "******";

function canViewDealAmount(deal: Deal | undefined) {
  return deal?.can_view_amount !== false;
}

function formatProtectedCurrency(
  value: number | string | null | undefined,
  canView: boolean
) {
  return canView ? formatCurrency(value) : MASKED_AMOUNT;
}

function numericAmount(value: number | string | null | undefined) {
  if (value == null || value === "") return 0;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

type Tab = "overview" | "stages" | "tasks" | "links" | "payments" | "files";

export default function DealDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const dealId = Number(id);
  const role = useRole();
  const user = useCurrentUser();
  const isSuper = useIsSuperuser();
  const canUpdateDeal = useHasPermission("deals_can_update");
  const isCollaborator = role === "collaborator" && !isSuper;
  const canManagePayments =
    isSuper || (role === "employee" && canUpdateDeal.granted);

  const dealQ = useQuery({
    queryKey: ["deal", dealId],
    queryFn: () => deals.retrieve(dealId),
  });

  const [tab, setTab] = useState<Tab>("overview");

  // The "Record payment" action lives in two places (header + Payments tab),
  // so the dialog state is lifted up here.
  const [payDialogOpen, setPayDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const qc = useQueryClient();

  // A received payment is also an income, so money views refresh too.
  function invalidatePayments() {
    qc.invalidateQueries({ queryKey: ["deal", dealId] });
    qc.invalidateQueries({ queryKey: ["deals"] });
    qc.invalidateQueries({ queryKey: ["incomes"] });
    qc.invalidateQueries({ queryKey: ["incomes-analytics"] });
    qc.invalidateQueries({ queryKey: ["wallets"] });
    qc.invalidateQueries({ queryKey: ["wallets-current"] });
    qc.invalidateQueries({ queryKey: ["wallets-logs"] });
    qc.invalidateQueries({ queryKey: ["wallets-analytics"] });
  }

  const addPayment = useMutation({
    mutationFn: (payload: DealPaymentCreate) =>
      deals.addPayment(dealId, payload),
    onSuccess: (p) => {
      invalidatePayments();
      toast.success(paymentSavedMessage(p));
      setPayDialogOpen(false);
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const markPaid = useMutation({
    mutationFn: (paymentId: number) =>
      deals.updatePayment(dealId, paymentId, {
        delayed: false,
        payment_date: new Date().toISOString().slice(0, 10),
      }),
    onSuccess: (p) => {
      invalidatePayments();
      toast.success(paymentSavedMessage(p));
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const removePayment = useMutation({
    mutationFn: (paymentId: number) => deals.removePayment(dealId, paymentId),
    onSuccess: () => {
      invalidatePayments();
      toast.success("Платёж удалён.");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const d = dealQ.data;

  // Collaborators (non-super) can only view orders where they are attached —
  // either as the primary `user` or in the multi-collaborator list.
  const collaboratorIds = new Set<number>([
    ...(d?.collaborators ?? []),
    ...((d?.collaborator_details ?? []).map((u) => u.id)),
  ]);
  if (
    d &&
    isCollaborator &&
    user &&
    userIdOf(d.user) !== user.id &&
    !collaboratorIds.has(user.id)
  ) {
    return (
      <>
        <Topbar eyebrow="Мои проекты" title="Доступ запрещён" />
        <PermissionDenied
          title="Этот проект принадлежит другому клиенту"
          detail="Вы можете видеть только свои проекты."
          cta="К вашим проектам"
          href="/projects"
        />
      </>
    );
  }

  if (!d && !dealQ.isLoading) {
    return (
      <>
        <Topbar eyebrow="Работа" title="Проект не найден" />
        <main className="flex-1 px-4 sm:px-8 py-12 max-w-[1080px] mx-auto w-full">
          <Link
            href="/projects"
            className="inline-flex items-center gap-2 text-ink-3 hover:text-accent"
          >
            <ArrowLeft className="h-4 w-4" />
            К списку проектов
          </Link>
        </main>
      </>
    );
  }

  if (!d) return <Topbar eyebrow="Работа" title="Загрузка…" />;

  const canViewAmount = canViewDealAmount(d);
  const paid = numericAmount(d.paid_to_date);
  const total = numericAmount(d.deal_amount);
  const progressPct =
    canViewAmount && total > 0 ? Math.min((paid / total) * 100, 100) : 0;

  return (
    <>
      <Topbar
        eyebrow={isCollaborator ? "Мои проекты" : "Работа"}
        title={projectName(d)}
        actions={
          isCollaborator ? undefined : (
            <div className="flex items-center gap-2">
              {canManagePayments && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditOpen(true)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Редактировать</span>
                </Button>
              )}
              {canManagePayments && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setPayDialogOpen(true)}
                >
                  <Wallet className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Зафиксировать платёж</span>
                </Button>
              )}
            </div>
          )
        }
      />

      {/* Shared payment dialog for header + Payments tab */}
      <AddPaymentDialog
        open={payDialogOpen}
        onOpenChange={setPayDialogOpen}
        onSubmit={(values) => addPayment.mutate(values)}
        pending={addPayment.isPending}
      />
      <EditDealDialog
        deal={d}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <main className="flex-1 px-4 sm:px-6 lg:px-10 py-10 max-w-[1080px] mx-auto w-full stagger">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-accent transition-colors mb-6"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {isCollaborator ? "Ваши проекты" : "Все проекты"}
        </Link>

        {/* Page header */}
        <header className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <StatusBadge stage={d.stage} />
            <Badge tone="gray">{paymentTypeLabel(d.payment_type)}</Badge>
            {d.payment_completed && <Badge tone="green">оплачено</Badge>}
          </div>
          <h1 className="font-display text-[22px] sm:text-[28px] tracking-tight text-ink text-balance">
            {projectName(d)}
          </h1>
          <p className="mt-2 text-[14px] text-ink-3">
            {[dealClientName(d), d.client_email].filter(Boolean).join(" · ")}
            {dealClientName(d) || d.client_email ? " · " : ""}
            Открыт {formatDate(d.date_start)} · Срок {formatDate(d.date_end)}
          </p>
        </header>

        {/* Money summary */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          <Money
            k="Сумма проекта"
            v={formatProtectedCurrency(d.deal_amount, canViewAmount)}
          />
          <Money
            k="Оплачено"
            v={formatProtectedCurrency(d.paid_to_date, canViewAmount)}
            accent
          />
          <Money
            k="Остаток"
            v={formatProtectedCurrency(d.remaining, canViewAmount)}
          />
        </section>

        <Panel className="mb-8">
          <PanelBody>
            <div className="flex items-center justify-between mb-2 text-[13px]">
              <span className="text-ink-2 font-medium">Прогресс оплаты</span>
              <span className="text-ink-3 tabular-nums">
                {canViewAmount ? `${progressPct.toFixed(0)}%` : MASKED_AMOUNT}
              </span>
            </div>
            <div className="h-2 bg-surface-3 rounded-full relative overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-accent rounded-full transition-all duration-700"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </PanelBody>
        </Panel>

        {/* Tabs */}
        <div className="mb-6 border-b border-hairline flex items-center gap-1 overflow-x-auto scrollbar-thin">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
            Обзор
          </TabButton>
          <TabButton active={tab === "stages"} onClick={() => setTab("stages")}>
            Этапы
          </TabButton>
          <TabButton active={tab === "tasks"} onClick={() => setTab("tasks")}>
            Задачи
          </TabButton>
          <TabButton active={tab === "links"} onClick={() => setTab("links")}>
            Ссылки
          </TabButton>
          <TabButton active={tab === "payments"} onClick={() => setTab("payments")}>
            Платежи
          </TabButton>
          <TabButton active={tab === "files"} onClick={() => setTab("files")}>
            Файлы
          </TabButton>
        </div>

        {tab === "overview" && (
          <OverviewTab dealId={dealId} isCollaborator={isCollaborator} d={d} />
        )}
        {tab === "stages" && (
          <StagesTab
            dealId={dealId}
            stages={d.stages ?? []}
            canEdit={!isCollaborator && canManagePayments}
          />
        )}
        {tab === "tasks" && (
          <TasksTab dealId={dealId} isCollaborator={isCollaborator} />
        )}
        {tab === "links" && (
          <LinksTab
            dealId={dealId}
            links={d.links ?? []}
            canEdit={!isCollaborator && canManagePayments}
          />
        )}
        {tab === "payments" && (
          <PaymentsTab
            dealId={dealId}
            isCollaborator={isCollaborator}
            canManagePayments={canManagePayments}
            payments={d.payments ?? []}
            busy={markPaid.isPending || removePayment.isPending}
            onMarkPaid={(pid) => markPaid.mutate(pid)}
            onRemovePayment={(pid) => {
              const p = d.payments?.find((x) => x.id === pid);
              const msg = p?.is_paid
                ? "Удалить платёж? Он пропадёт и из «Доходов»."
                : "Удалить платёж?";
              if (confirm(msg)) removePayment.mutate(pid);
            }}
            onOpenAdd={() => setPayDialogOpen(true)}
          />
        )}
        {tab === "files" && (
          <FilesTab
            dealId={dealId}
            files={d.files ?? []}
            canEdit={!isCollaborator && canManagePayments}
          />
        )}
      </main>
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative h-9 px-3 text-[13px] transition-colors",
        active ? "text-ink font-medium" : "text-ink-3 hover:text-ink"
      )}
    >
      {children}
      {active && (
        <span className="absolute -bottom-px left-0 right-0 h-0.5 bg-accent rounded-full" />
      )}
    </button>
  );
}

/* ------- Overview tab ------- */

function OverviewTab({
  dealId,
  isCollaborator,
  d,
}: {
  dealId: number;
  isCollaborator: boolean;
  d: Deal;
}) {
  const onboardsQ = useQuery({
    queryKey: ["onboards-for-deal", dealId],
    queryFn: () => onboards.forDeal(dealId),
  });
  const dealOnboards = onboardsQ.data ?? [];
  const primary = dealOnboards[0];

  // Pull full nested onboard so we can compute progress on the client.
  const fullOnboardQ = useQuery({
    queryKey: ["onboard", primary?.id],
    queryFn: () => onboards.retrieve(primary!.id),
    enabled: !!primary,
  });
  const onboard = fullOnboardQ.data;
  const progress = computeOnboardProgress(onboard);

  const canViewAmount = canViewDealAmount(d);
  const paid = numericAmount(d.paid_to_date);
  const remaining =
    d.remaining == null
      ? Math.max(0, numericAmount(d.deal_amount) - paid)
      : numericAmount(d.remaining);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-4">
      <Panel className="anim-fade">
        <PanelHeader>
          <PanelTitle>Детали проекта</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-3 text-[14px]">
          <Row k="Проект" v={projectName(d)} />
          <Row k="Клиент" v={dealClientName(d) || userDisplayName(d.user)} />
          <Row k="Контактный email" v={d.client_email ?? "—"} />
          <CollaboratorsRow deal={d} />
          <ResponsiblesRow deal={d} />
          <Row k="Статус" v={<StatusBadge stage={d.stage} />} />
          <Row k="Способ оплаты" v={<Badge tone="gray">{paymentTypeLabel(d.payment_type)}</Badge>} />
          <Row k="Открыт" v={formatDate(d.date_start)} />
          <Row k="Срок" v={formatDate(d.date_end)} />
          <Row
            k="Сумма проекта"
            v={formatProtectedCurrency(d.deal_amount, canViewAmount)}
          />
          <Row
            k="Оплачено"
            v={formatProtectedCurrency(paid, canViewAmount)}
          />
          <Row
            k="Остаток"
            v={formatProtectedCurrency(remaining, canViewAmount)}
          />
        </PanelBody>
      </Panel>

      <Panel className="anim-fade">
        <PanelHeader>
          <PanelTitle>План задач</PanelTitle>
          {primary && (
            <span className="text-[12px] text-ink-3">
              {progress}% готово
            </span>
          )}
        </PanelHeader>
        <PanelBody>
          {!primary ? (
              <p className="text-[13px] text-ink-3">
                {isCollaborator
                  ? "План задач пока не опубликован — мы скоро его составим."
                : "Плана задач пока нет. Создайте план для этого проекта."}
              </p>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2 text-[13px]">
                <span className="text-ink-2 font-medium">Общий прогресс</span>
                <span className="text-ink-3 tabular-nums">{progress}%</span>
              </div>
              <div className="h-2 bg-surface-3 rounded-full relative overflow-hidden mb-4">
                <div
                  className="absolute inset-y-0 left-0 bg-accent rounded-full transition-all duration-700"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-[13px] text-ink-3 mb-3">
                Срок сдачи: {formatDate(primary.term_of_end)}
              </p>
              <Link
                href={`/projects/${dealId}` as never}
                className="text-[13px] text-accent hover:text-accent-ink"
              >
                Открыть план задач →
              </Link>
            </>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

/** Progress percentage based on done tasks ratio inside an onboard. */
function computeOnboardProgress(o: Onboard | undefined): number {
  if (!o?.categories) return 0;
  let total = 0;
  let done = 0;
  for (const c of o.categories) {
    for (const t of c.tasks ?? []) {
      total += 1;
      if (!t.is_active) done += 1;
    }
  }
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-hairline py-2.5 last:border-0">
      <span className="text-ink-3 w-[40%] shrink-0">{k}</span>
      <span className="text-ink-2 text-right">{v}</span>
    </div>
  );
}

function CollaboratorsRow({ deal }: { deal: Deal }) {
  const list = deal.collaborator_details ?? [];
  if (list.length === 0) return null;

  const primaryId = userIdOf(deal.user);
  const extras = list.filter((u) => u.id !== primaryId);
  if (extras.length === 0) return null;

  return (
    <div className="flex flex-col sm:flex-row items-start sm:justify-between gap-4 border-b border-hairline py-2.5 last:border-0">
      <span className="text-ink-3 w-full sm:w-[40%] shrink-0">Совместный доступ</span>
      <div className="flex-1 flex flex-wrap justify-end gap-1.5">
        {extras.map((u) => {
          const name =
            `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() ||
            u.username ||
            u.email;
          return (
            <span
              key={u.id}
              className="inline-flex items-center gap-1.5 h-7 pl-1 pr-2 rounded-full bg-surface-2 border border-hairline text-[12px] text-ink-2"
              title={u.email}
            >
              <Avatar
                name={name}
                size={20}
                className="text-[10px] ring-1 ring-canvas"
              />
              <span className="max-w-[160px] truncate">{name}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ResponsiblesRow({ deal }: { deal: Deal }) {
  const list = deal.responsible_details ?? [];
  if (list.length === 0) return <Row k="Ответственные" v="—" />;

  return (
    <div className="flex flex-col sm:flex-row items-start sm:justify-between gap-4 border-b border-hairline py-2.5 last:border-0">
      <span className="text-ink-3 w-full sm:w-[40%] shrink-0">Ответственные</span>
      <div className="flex-1 flex flex-wrap justify-end gap-1.5">
        {list.map((u) => {
          const name =
            `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() ||
            u.username ||
            u.email;
          return (
            <span
              key={u.id}
              className="inline-flex items-center gap-1.5 h-7 pl-1 pr-2 rounded-full bg-tag-green-bg text-tag-green-fg text-[12px]"
              title={u.email}
            >
              <Avatar
                name={name}
                size={20}
                className="text-[10px] ring-1 ring-canvas"
              />
              <span className="max-w-[160px] truncate">{name}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ------- Project stages ------- */

const STAGE_STATUS_OPTIONS: { value: DealStageStatus; label: string }[] = [
  { value: "pending", label: "Ожидает" },
  { value: "in_progress", label: "В процессе" },
  { value: "completed", label: "Выполнено" },
];

type StageTreeNode = DealStage & { children: StageTreeNode[] };

function compareProjectStages(a: DealStage, b: DealStage) {
  return a.order - b.order || a.id - b.id;
}

function buildStageTree(stages: DealStage[]) {
  const sorted = [...stages].sort(compareProjectStages);
  const nodes = new Map<number, StageTreeNode>();
  const roots: StageTreeNode[] = [];

  for (const stage of sorted) {
    nodes.set(stage.id, { ...stage, children: [] });
  }

  for (const stage of sorted) {
    const node = nodes.get(stage.id)!;
    const parent = stage.parent_stage ? nodes.get(stage.parent_stage) : null;

    if (parent && parent.id !== node.id) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return { sorted, roots };
}

function nextStageOrder(stages: DealStage[], parentStageId: number | null) {
  const siblingOrders = stages
    .filter((stage) => (stage.parent_stage ?? null) === parentStageId)
    .map((stage) => stage.order);

  return siblingOrders.length === 0 ? 1 : Math.max(...siblingOrders) + 1;
}

function countNestedStages(stage: StageTreeNode): number {
  return stage.children.reduce(
    (total, child) => total + 1 + countNestedStages(child),
    0
  );
}

function StagesTab({
  dealId,
  stages,
  canEdit,
}: {
  dealId: number;
  stages: DealStage[];
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [addParentStage, setAddParentStage] = useState<DealStage | null>(null);
  const { sorted, roots } = useMemo(() => buildStageTree(stages), [stages]);
  const progress =
    sorted.length === 0
      ? 0
      : Math.round(
          (sorted.filter((s) => s.status === "completed").length /
            sorted.length) *
            100
        );

  const add = useMutation({
    mutationFn: (payload: DealStageCreate) => deals.addStage(dealId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal", dealId] });
      toast.success("Этап добавлен.");
      setOpen(false);
      setAddParentStage(null);
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const update = useMutation({
    mutationFn: ({
      stageId,
      payload,
    }: {
      stageId: number;
      payload: Partial<DealStageCreate>;
    }) => deals.updateStage(dealId, stageId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal", dealId] });
      toast.success("Этап обновлён.");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const remove = useMutation({
    mutationFn: (stageId: number) => deals.removeStage(dealId, stageId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal", dealId] });
      toast.success("Этап удалён.");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  function openAddStage(parentStage: DealStage | null = null) {
    setAddParentStage(parentStage);
    setOpen(true);
  }

  return (
    <Panel className="anim-fade">
      <PanelHeader>
        <PanelTitle>Этапы проекта</PanelTitle>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-ink-3 tabular-nums">
            {progress}%
          </span>
          {canEdit && (
            <Button variant="primary" size="sm" onClick={() => openAddStage()}>
              <Plus className="h-3.5 w-3.5" />
              Добавить этап
            </Button>
          )}
        </div>
      </PanelHeader>
      <PanelBody>
        {sorted.length === 0 ? (
          <div className="text-[13px] text-ink-4 py-10 text-center">
            Этапов пока нет.
          </div>
        ) : (
          <div className="overflow-x-auto pb-1">
            <div className="space-y-4 md:min-w-[720px]">
              {roots.map((stage, idx) => (
                <StageBranch
                  key={stage.id}
                  stage={stage}
                  indexLabel={String(idx + 1)}
                  depth={0}
                  canEdit={canEdit}
                  removePending={remove.isPending}
                  onAddSubStage={openAddStage}
                  onUpdateStatus={(stageId, status) =>
                    update.mutate({
                      stageId,
                      payload: { status },
                    })
                  }
                  onRemove={(stageId) => remove.mutate(stageId)}
                />
              ))}
            </div>
          </div>
        )}
        <AddStageDialog
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (!v) setAddParentStage(null);
          }}
          employeesQEnabled={open}
          parentStage={addParentStage}
          nextOrder={nextStageOrder(sorted, addParentStage?.id ?? null)}
          onSubmit={(values) => add.mutate(values)}
          pending={add.isPending}
        />
      </PanelBody>
    </Panel>
  );
}

function StageBranch({
  stage,
  indexLabel,
  depth,
  canEdit,
  removePending,
  onAddSubStage,
  onUpdateStatus,
  onRemove,
}: {
  stage: StageTreeNode;
  indexLabel: string;
  depth: number;
  canEdit: boolean;
  removePending: boolean;
  onAddSubStage: (stage: DealStage) => void;
  onUpdateStatus: (stageId: number, status: DealStageStatus) => void;
  onRemove: (stageId: number) => void;
}) {
  return (
    <div className="relative flex flex-col gap-3 md:flex-row md:items-start">
      <StageNodeCard
        stage={stage}
        indexLabel={indexLabel}
        depth={depth}
        canEdit={canEdit}
        removePending={removePending}
        onAddSubStage={onAddSubStage}
        onUpdateStatus={onUpdateStatus}
        onRemove={onRemove}
      />
      {stage.children.length > 0 && (
        <div className="relative ml-4 border-l border-hairline-strong pl-6 md:ml-0 md:min-w-[300px] md:flex-1 md:border-l-0 md:pl-8">
          <span className="hidden md:block absolute left-0 top-5 h-px w-8 bg-hairline-strong" />
          {stage.children.length > 1 && (
            <span className="hidden md:block absolute left-8 top-5 bottom-5 w-px bg-hairline-strong" />
          )}
          <div className="space-y-3">
            {stage.children.map((child, idx) => (
              <div key={child.id} className="relative pl-5 md:pl-6">
                <span className="absolute left-[-25px] top-5 h-px w-[25px] bg-hairline-strong md:left-0 md:w-6" />
                <StageBranch
                  stage={child}
                  indexLabel={`${indexLabel}.${idx + 1}`}
                  depth={depth + 1}
                  canEdit={canEdit}
                  removePending={removePending}
                  onAddSubStage={onAddSubStage}
                  onUpdateStatus={onUpdateStatus}
                  onRemove={onRemove}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StageNodeCard({
  stage,
  indexLabel,
  depth,
  canEdit,
  removePending,
  onAddSubStage,
  onUpdateStatus,
  onRemove,
}: {
  stage: StageTreeNode;
  indexLabel: string;
  depth: number;
  canEdit: boolean;
  removePending: boolean;
  onAddSubStage: (stage: DealStage) => void;
  onUpdateStatus: (stageId: number, status: DealStageStatus) => void;
  onRemove: (stageId: number) => void;
}) {
  const label = projectStageStatusLabel(stage.status);
  const nestedCount = countNestedStages(stage);
  const indexTextSize = indexLabel.length > 3 ? "text-[10px]" : "text-[12px]";

  return (
    <div
      className={cn(
        "group w-full rounded-md border border-hairline-strong bg-canvas px-3 py-3 transition-colors hover:border-ink-5",
        depth === 0 ? "md:w-[360px]" : "md:w-[300px]"
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "h-8 w-8 rounded-full grid place-items-center border font-medium shrink-0",
            stage.status === "completed"
              ? "bg-success text-white border-success"
              : stage.status === "in_progress"
              ? "bg-accent-soft text-accent-ink border-accent/40"
              : "bg-surface-2 text-ink-3 border-hairline-strong",
            indexTextSize
          )}
          title={indexLabel}
        >
          {stage.status === "completed" ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : stage.status === "in_progress" ? (
            <Clock className="h-4 w-4" />
          ) : (
            indexLabel
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-[15px] font-medium text-ink">
              {stage.name}
            </h3>
            <Badge tone={label.tone} dot>
              {label.label}
            </Badge>
          </div>
          <div className="mt-1 text-[13px] text-ink-3">
            {stage.responsible_detail
              ? userDisplayName(stage.responsible_detail)
              : "Ответственный не назначен"}
            {stage.due_date ? ` · до ${formatDate(stage.due_date)}` : ""}
          </div>
          {nestedCount > 0 && (
            <div className="mt-2 text-[12px] text-ink-4">
              {nestedCount}{" "}
              {plural(nestedCount, "подэтап", "подэтапа", "подэтапов")}
            </div>
          )}
        </div>
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
          <button
            type="button"
            onClick={() => onAddSubStage(stage)}
            className="h-8 w-8 grid place-items-center rounded-md border border-hairline-strong text-ink-3 hover:text-accent hover:border-accent/40 hover:bg-accent-soft transition-colors"
            title="Добавить подэтап"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <select
            value={stage.status}
            onChange={(e) =>
              onUpdateStatus(stage.id, e.target.value as DealStageStatus)
            }
            className="h-8 min-w-[132px] bg-canvas border border-hairline-strong rounded-md px-2 text-[13px] text-ink-2 hover:border-ink-5 transition-colors cursor-pointer"
          >
            {STAGE_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onRemove(stage.id)}
            disabled={removePending}
            className="h-8 w-8 grid place-items-center rounded-md text-ink-3 hover:text-danger hover:bg-tag-red-bg/30 transition-colors disabled:opacity-50"
            title="Удалить этап"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function AddStageDialog({
  open,
  onOpenChange,
  employeesQEnabled,
  parentStage,
  nextOrder,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employeesQEnabled: boolean;
  parentStage: DealStage | null;
  nextOrder: number;
  onSubmit: (values: DealStageCreate) => void;
  pending: boolean;
}) {
  const employeesQ = useQuery({
    queryKey: ["users", "employee"],
    queryFn: () => users.list("employee"),
    enabled: employeesQEnabled,
  });
  const [name, setName] = useState("");
  const [status, setStatus] = useState<DealStageStatus>("pending");
  const [responsible, setResponsible] = useState<number | "">("");
  const [dueDate, setDueDate] = useState("");

  function reset() {
    setName("");
    setStatus("pending");
    setResponsible("");
    setDueDate("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader
          eyebrow={parentStage ? "Проект · Подэтап" : "Проект · Этап"}
          title={parentStage ? "Добавить подэтап" : "Добавить этап"}
          description={
            parentStage
              ? "Подэтап появится веткой внутри выбранного этапа и будет участвовать в общем прогрессе."
              : "Этап появится в карте проекта и будет участвовать в общем прогрессе."
          }
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({
              name,
              parent_stage: parentStage?.id ?? null,
              status,
              order: nextOrder,
              responsible: responsible === "" ? null : responsible,
              due_date: dueDate || null,
            });
            reset();
          }}
          className="flex flex-col gap-4"
        >
          {parentStage && (
            <div className="rounded-md border border-hairline bg-surface-2 px-3 py-2">
              <div className="text-[11px] uppercase tracking-[0.04em] text-ink-4">
                Родительский этап
              </div>
              <div className="mt-1 truncate text-[13px] font-medium text-ink">
                {parentStage.name}
              </div>
            </div>
          )}
          <Field label={parentStage ? "Название подэтапа" : "Название этапа"}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={parentStage ? "Проверка договора" : "Разработка"}
              autoFocus
              required
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Статус">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as DealStageStatus)}
                className="h-9 w-full bg-canvas border border-hairline-strong rounded-md px-3 text-[14px] text-ink hover:border-ink-5 focus:border-accent focus:shadow-[0_0_0_3px_rgba(35,131,226,0.18)] outline-none transition-all cursor-pointer"
              >
                {STAGE_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Срок">
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Ответственный">
            <select
              value={responsible === "" ? "" : String(responsible)}
              onChange={(e) =>
                setResponsible(e.target.value ? Number(e.target.value) : "")
              }
              className="h-9 w-full bg-canvas border border-hairline-strong rounded-md px-3 text-[14px] text-ink hover:border-ink-5 focus:border-accent focus:shadow-[0_0_0_3px_rgba(35,131,226,0.18)] outline-none transition-all cursor-pointer"
            >
              <option value="">Не назначен</option>
              {(employeesQ.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {userDisplayName(u)}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button type="button" variant="ghost" size="md" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={pending || !name.trim()}>
              {pending ? "Сохраняем…" : "Добавить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------- Tasks tab (Jira-style) ------- */

type TaskView = "board" | "list";

function TasksTab({
  dealId,
  isCollaborator,
}: {
  dealId: number;
  isCollaborator: boolean;
}) {
  const qc = useQueryClient();

  // 1. Deal (for default term when auto-creating an onboard).
  const dealQ = useQuery({
    queryKey: ["deal", dealId],
    queryFn: () => deals.retrieve(dealId),
  });

  // 2. All onboards (KPI plans) for this deal.
  const dealOnboardsQ = useQuery({
    queryKey: ["onboards-for-deal", dealId],
    queryFn: () => onboards.forDeal(dealId),
  });
  const dealOnboards = useMemo(
    () => dealOnboardsQ.data ?? [],
    [dealOnboardsQ.data]
  );

  // 3. Which onboard is currently displayed. User can switch between them.
  const [selectedOnboardId, setSelectedOnboardId] = useState<number | null>(
    null
  );
  // Default-select the first onboard once data arrives, or if the chosen one
  // disappears (e.g. was deleted in another tab).
  const effectiveOnboardId = useMemo(() => {
    if (selectedOnboardId &&
        dealOnboards.some((o) => o.id === selectedOnboardId)) {
      return selectedOnboardId;
    }
    return dealOnboards[0]?.id ?? null;
  }, [selectedOnboardId, dealOnboards]);

  // Lazy-create an onboard the first time someone tries to add a task. We
  // default term_of_end to the deal's own deadline — sensible and editable
  // later from the Onboard detail page.
  const ensureOnboard = useMutation({
    mutationFn: async (): Promise<number> => {
      if (effectiveOnboardId) return effectiveOnboardId;
      const created = await onboards.create({
        deal: dealId,
        term_of_end:
          dealQ.data?.date_end ?? new Date().toISOString().slice(0, 10),
      });
      return created.id;
    },
    onSuccess: (id) => {
      // Switch to the newly-created onboard.
      setSelectedOnboardId(id);
      qc.invalidateQueries({ queryKey: ["onboards-for-deal", dealId] });
      qc.invalidateQueries({ queryKey: ["onboards"] });
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  // 4. Pull the full nested representation of the selected onboard.
  const onboardQ = useQuery({
    queryKey: ["onboard", effectiveOnboardId],
    queryFn: () => onboards.retrieve(effectiveOnboardId!),
    enabled: !!effectiveOnboardId,
  });
  const onboard = onboardQ.data;
  const cats = useMemo(() => onboard?.categories ?? [], [onboard?.categories]);
  const tasks = useMemo(() => cats.flatMap((c) => c.tasks ?? []), [cats]);

  const [view, setView] = useState<TaskView>("board");
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<number | "all">("all");
  const [approvalFilter, setApprovalFilter] =
    useState<"all" | "pending" | "approved" | "rejected" | "cancelled">("all");

  // Add-task dialog state.
  const [addOpen, setAddOpen] = useState(false);
  const [addCategoryId, setAddCategoryId] = useState<number | undefined>();
  const [pendingOnboardId, setPendingOnboardId] = useState<number | null>(null);

  async function openAdd(categoryId?: number) {
    setAddCategoryId(categoryId);
    try {
      const onboardId = await ensureOnboard.mutateAsync();
      setPendingOnboardId(onboardId);
      setAddOpen(true);
    } catch {
      /* toast already shown by mutation onError */
    }
  }

  const approvalCounts = useMemo(() => {
    const counts = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const t of tasks) {
      const a = resolveApprovalStatus(t);
      if (a && a in counts) counts[a] += 1;
    }
    return counts;
  }, [tasks]);

  const filtered = useMemo(() => {
    let list = tasks;
    if (categoryFilter !== "all") {
      list = list.filter((t) => t.category === categoryFilter);
    }
    if (approvalFilter !== "all") {
      list = list.filter((t) => resolveApprovalStatus(t) === approvalFilter);
    }
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(term) ||
          t.description.toLowerCase().includes(term) ||
          ticketKey(t).toLowerCase().includes(term)
      );
    }
    return list;
  }, [tasks, q, categoryFilter, approvalFilter]);

  return (
    <div className="anim-fade space-y-4">
      {/* Onboard selector — one chip per KPI plan */}
      {dealOnboards.length > 0 && (
        <OnboardSelector
          dealId={dealId}
          onboardsList={dealOnboards}
          selectedId={effectiveOnboardId}
          onSelect={setSelectedOnboardId}
          readOnly={isCollaborator}
        />
      )}

      {/* Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-md relative">
          <Search className="absolute left-3 h-4 w-4 text-ink-4 pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск QOI-001, названия или описания"
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <CategoryFilter
            categories={cats}
            value={categoryFilter}
            onChange={setCategoryFilter}
          />
          <ApprovalFilter
            value={approvalFilter}
            onChange={setApprovalFilter}
            counts={approvalCounts}
          />
          <Button variant="outline" size="sm">
            <Filter className="h-3.5 w-3.5" />
            Фильтр
          </Button>
          <div className="flex bg-surface-2 border border-hairline rounded-md p-0.5">
            <button
              onClick={() => setView("board")}
              className={cn(
                "h-7 px-2.5 inline-flex items-center gap-1.5 text-[13px] rounded transition-colors",
                view === "board"
                  ? "bg-canvas text-ink shadow-sm font-medium"
                  : "text-ink-3 hover:text-ink"
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              Доска
            </button>
            <button
              onClick={() => setView("list")}
              className={cn(
                "h-7 px-2.5 inline-flex items-center gap-1.5 text-[13px] rounded transition-colors",
                view === "list"
                  ? "bg-canvas text-ink shadow-sm font-medium"
                  : "text-ink-3 hover:text-ink"
              )}
            >
              <ListIcon className="h-3.5 w-3.5" />
              Список
            </button>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => openAdd()}
            disabled={ensureOnboard.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
            {ensureOnboard.isPending ? "Готовим…" : "Создать"}
          </Button>
        </div>
      </div>

      {view === "board" ? (
        effectiveOnboardId ? (
          <TasksBoard
            onboardId={effectiveOnboardId}
            categories={filterCategories(cats, filtered)}
            lockColumns={isCollaborator}
            onAddCard={(categoryId) => openAdd(categoryId)}
          />
        ) : (
          <EmptyBoardCTA
            onCreate={() => openAdd()}
            pending={ensureOnboard.isPending}
          />
        )
      ) : (
        <TasksList tasks={filtered} categories={cats} />
      )}

      {pendingOnboardId && (
        <AddTaskDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onboardId={pendingOnboardId}
          categories={cats}
          defaultCategoryId={addCategoryId}
        />
      )}
    </div>
  );
}

function EmptyBoardCTA({
  onCreate,
  pending,
}: {
  onCreate: () => void;
  pending: boolean;
}) {
  return (
    <Panel className="p-12 text-center anim-fade">
      <h3 className="font-display text-[20px] text-ink">
        Плана задач пока нет
      </h3>
      <p className="text-[14px] text-ink-3 mt-1 mb-5">
        Нажмите «Создать задачу» — онбординг и первая категория добавятся
        автоматически.
      </p>
      <Button
        variant="primary"
        size="md"
        onClick={onCreate}
        disabled={pending}
      >
        <Plus className="h-3.5 w-3.5" />
        {pending ? "Готовим…" : "Создать задачу"}
      </Button>
    </Panel>
  );
}

/** Keep all categories, but slice each category's tasks to the filtered set. */
function filterCategories(
  cats: TaskCategory[],
  filteredTasks: OnboardTask[]
): TaskCategory[] {
  const allowed = new Set(filteredTasks.map((t) => t.id));
  return cats.map((c) => ({
    ...c,
    tasks: (c.tasks ?? []).filter((t) => allowed.has(t.id)),
  }));
}

/* ------- Onboard selector (KPI plans for this deal) ------- */

function OnboardSelector({
  dealId,
  onboardsList,
  selectedId,
  onSelect,
  readOnly,
}: {
  dealId: number;
  onboardsList: Onboard[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const removeOnboard = useMutation({
    mutationFn: (id: number) => onboards.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["onboards-for-deal", dealId] });
      qc.invalidateQueries({ queryKey: ["onboards"] });
      toast.success("Онбординг удалён.");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[12px] text-ink-3 mr-1">Онбординг:</span>
      {onboardsList.map((o, idx) => (
        <OnboardChip
          key={o.id}
          o={o}
          fallbackIdx={idx}
          active={o.id === selectedId}
          dealId={dealId}
          onSelect={() => onSelect(o.id)}
          readOnly={readOnly}
          canDelete={onboardsList.length > 1}
          onDelete={() => {
            if (
              confirm(
                `Удалить онбординг «${displayOnboardName(o, idx)}»? Все его задачи и категории удалятся.`
              )
            ) {
              removeOnboard.mutate(o.id);
            }
          }}
        />
      ))}

      {!readOnly && <NewOnboardChip dealId={dealId} onCreated={onSelect} />}
    </div>
  );
}

function displayOnboardName(o: Onboard, idx: number): string {
  if (o.name && o.name.trim()) return o.name;
  if (o.client_name) return o.client_name;
  return `План #${idx + 1}`;
}

function OnboardChip({
  o,
  fallbackIdx,
  active,
  dealId,
  onSelect,
  readOnly,
  canDelete,
  onDelete,
}: {
  o: Onboard;
  fallbackIdx: number;
  active: boolean;
  dealId: number;
  onSelect: () => void;
  readOnly?: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(displayOnboardName(o, fallbackIdx));

  const rename = useMutation({
    mutationFn: (name: string) => onboards.update(o.id, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["onboards-for-deal", dealId] });
      qc.invalidateQueries({ queryKey: ["onboards"] });
      qc.invalidateQueries({ queryKey: ["onboard", o.id] });
      toast.success("Онбординг переименован.");
      setRenaming(false);
    },
    onError: (err) => {
      toast.error(asApiError(err).message);
      setRenaming(false);
      setDraft(displayOnboardName(o, fallbackIdx));
    },
  });

  if (renaming) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          if (next && next !== displayOnboardName(o, fallbackIdx)) {
            rename.mutate(next);
          } else {
            setRenaming(false);
            setDraft(displayOnboardName(o, fallbackIdx));
          }
        }}
        className="inline-flex items-center gap-1"
      >
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const next = draft.trim();
            if (next && next !== displayOnboardName(o, fallbackIdx)) {
              rename.mutate(next);
            } else {
              setRenaming(false);
              setDraft(displayOnboardName(o, fallbackIdx));
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setRenaming(false);
              setDraft(displayOnboardName(o, fallbackIdx));
            }
          }}
          className="h-7 text-[12px] w-[180px]"
        />
      </form>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-stretch rounded-full overflow-hidden border transition-colors",
        active
          ? "bg-accent-soft border-accent/40 text-accent-ink"
          : "bg-canvas border-hairline-strong text-ink-2 hover:border-ink-5 hover:bg-surface-2"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => !readOnly && setRenaming(true)}
        className={cn(
          "inline-flex items-center gap-2 h-7 pl-2.5 pr-2 text-[12px]",
          active && "font-medium"
        )}
        title={readOnly ? undefined : "Двойной клик — переименовать"}
      >
        <span>{displayOnboardName(o, fallbackIdx)}</span>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            active ? "text-accent-ink/70" : "text-ink-3"
          )}
        >
          до {formatDate(o.term_of_end, { month: "short", day: "2-digit" })}
        </span>
        {o.is_completed && (
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
        )}
      </button>
      {!readOnly && active && (
        <>
          <button
            type="button"
            onClick={() => setRenaming(true)}
            className="px-1.5 grid place-items-center text-accent-ink/60 hover:text-accent-ink hover:bg-accent-soft/70 transition-colors border-l border-accent/30"
            title="Переименовать"
          >
            <Pencil className="h-3 w-3" />
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="px-1.5 grid place-items-center text-accent-ink/60 hover:text-danger hover:bg-tag-red-bg/40 transition-colors border-l border-accent/30"
              title="Удалить онбординг"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </>
      )}
    </div>
  );
}

function NewOnboardChip({
  dealId,
  onCreated,
}: {
  dealId: number;
  onCreated: (id: number) => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState("");

  const create = useMutation({
    mutationFn: (term: string) =>
      onboards.create({ deal: dealId, term_of_end: term }),
    onSuccess: (o) => {
      qc.invalidateQueries({ queryKey: ["onboards-for-deal", dealId] });
      qc.invalidateQueries({ queryKey: ["onboards"] });
      toast.success("Онбординг создан.");
      onCreated(o.id);
      setAdding(false);
      setDate("");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[12px] border border-dashed border-hairline-strong text-ink-3 hover:border-ink-5 hover:text-ink hover:bg-surface-2 transition-colors"
      >
        <Plus className="h-3 w-3" />
        Новый онбординг
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (date) create.mutate(date);
      }}
      className="inline-flex items-center gap-1.5"
    >
      <Input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        autoFocus
        required
        placeholder="Срок сдачи"
        className="h-7 text-[12px] w-[140px]"
      />
      <Button
        type="submit"
        variant="primary"
        size="icon"
        disabled={!date || create.isPending}
        title="Создать"
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => {
          setAdding(false);
          setDate("");
        }}
        title="Отмена"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}

function CategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: { id: number; name: string }[];
  value: number | "all";
  onChange: (v: number | "all") => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "all" ? "all" : Number(v));
      }}
      className="h-8 bg-canvas border border-hairline-strong rounded-md px-2 text-[13px] text-ink-2 hover:border-ink-5 transition-colors cursor-pointer"
    >
      <option value="all">Все категории</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

const APPROVAL_FILTER_OPTIONS: {
  key: "all" | "pending" | "approved" | "rejected" | "cancelled";
  label: string;
}[] = [
  { key: "all", label: "Все" },
  { key: "pending", label: "Ожидают" },
  { key: "approved", label: "Одобренные" },
  { key: "rejected", label: "Отклонённые" },
  { key: "cancelled", label: "Отменённые" },
];

function ApprovalFilter({
  value,
  onChange,
  counts,
}: {
  value: "all" | "pending" | "approved" | "rejected" | "cancelled";
  onChange: (
    v: "all" | "pending" | "approved" | "rejected" | "cancelled"
  ) => void;
  counts: { pending: number; approved: number; rejected: number; cancelled: number };
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as typeof value)}
      className="h-8 bg-canvas border border-hairline-strong rounded-md px-2 text-[13px] text-ink-2 hover:border-ink-5 transition-colors cursor-pointer"
      title="Фильтр по статусу согласования"
    >
      {APPROVAL_FILTER_OPTIONS.map((o) => {
        const n = o.key === "all" ? null : counts[o.key];
        return (
          <option key={o.key} value={o.key}>
            {o.label}
            {n != null ? ` (${n})` : ""}
          </option>
        );
      })}
    </select>
  );
}

/* Board view is provided by the shared TasksBoard component (Trello-style).
 * Old per-status board has been replaced — see src/components/tasks-board.tsx.
 */

/* ----- List view ----- */

function TasksList({
  tasks,
  categories,
}: {
  tasks: OnboardTask[];
  categories: { id: number; name: string }[];
}) {
  const catName = (id: number) =>
    categories.find((c) => c.id === id)?.name ?? "—";

  return (
    <Panel>
      <Table>
        <THead>
          <TR>
            <TH className="w-[90px]">Ключ</TH>
            <TH>Название</TH>
            <TH>Статус</TH>
            <TH className="hidden lg:table-cell">Согласование</TH>
            <TH className="hidden lg:table-cell">Приоритет</TH>
            <TH className="hidden lg:table-cell">Категория</TH>
            <TH className="hidden lg:table-cell">Исполнитель</TH>
            <TH>Срок</TH>
          </TR>
        </THead>
        <tbody>
          {tasks.map((t) => {
            const tm = typeMeta(t.type);
            const status = resolveStatus(t);
            const priority = resolvePriority(t);
            const chip = approvalChip(t);
            const isDone = status === "done";
            return (
              <TR key={t.id} className="cursor-pointer">
                <TD className="font-mono text-[12px] text-ink-3 tabular-nums">
                  {ticketKey(t)}
                </TD>
                <TD>
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="text-[14px] shrink-0"
                      aria-hidden
                      title={tm.label}
                    >
                      {tm.emoji}
                    </span>
                    <span
                      className={cn(
                        "text-ink truncate",
                        isDone && "line-through text-ink-3"
                      )}
                    >
                      {t.name}
                    </span>
                  </div>
                </TD>
                <TD>
                  <Badge tone={STATUS_TONE[status]} dot>
                    {TASK_COLUMNS.find((c) => c.key === status)?.label ?? status}
                  </Badge>
                </TD>
                <TD className="hidden lg:table-cell">
                  {chip ? (
                    <Badge tone={chip.tone} dot>
                      {chip.short}
                    </Badge>
                  ) : (
                    <span className="text-ink-4 text-[12px]">—</span>
                  )}
                </TD>
                <TD className="hidden lg:table-cell">
                  <Badge tone={PRIORITY_TONE[priority]}>
                    {PRIORITY_LABEL[priority]}
                  </Badge>
                </TD>
                <TD className="hidden lg:table-cell text-ink-3 text-[13px]">{catName(t.category)}</TD>
                <TD className="hidden lg:table-cell">
                  {t.assignee ? (
                    <div className="flex items-center gap-2">
                      <Avatar
                        name={t.assignee.name}
                        size={22}
                        className="text-[10px]"
                      />
                      <span className="text-[13px] text-ink-2 truncate max-w-[14ch]">
                        {t.assignee.name}
                      </span>
                    </div>
                  ) : (
                    <span className="text-ink-4 text-[13px]">Не назначен</span>
                  )}
                </TD>
                <TD className="text-ink-3 tabular-nums text-[13px]">
                  {formatDate(t.date_end, { month: "short", day: "2-digit" })}
                </TD>
              </TR>
            );
          })}
          {tasks.length === 0 && (
            <TR>
              <TD colSpan={8} className="text-center text-ink-4 py-12">
                Задачи по фильтрам не найдены.
                <span className="ml-1 text-accent hover:text-accent-ink cursor-pointer">
                  Создать новую →
                </span>
              </TD>
            </TR>
          )}
        </tbody>
      </Table>
    </Panel>
  );
}

/* ------- Useful links ------- */

function LinksTab({
  dealId,
  links,
  canEdit,
}: {
  dealId: number;
  links: DealLink[];
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const add = useMutation({
    mutationFn: (payload: DealLinkCreate) => deals.addLink(dealId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal", dealId] });
      toast.success("Ссылка добавлена.");
      setOpen(false);
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const remove = useMutation({
    mutationFn: (linkId: number) => deals.removeLink(dealId, linkId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal", dealId] });
      toast.success("Ссылка удалена.");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  return (
    <Panel className="anim-fade">
      <PanelHeader>
        <PanelTitle>Полезные ссылки</PanelTitle>
        {canEdit && (
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            Добавить
          </Button>
        )}
      </PanelHeader>
      <PanelBody>
        {links.length === 0 ? (
          <div className="text-[13px] text-ink-4 py-10 text-center">
            Ссылок пока нет.
          </div>
        ) : (
          <div className="space-y-2">
            {links.map((link) => (
              <div
                key={link.id}
                className="group flex items-start gap-3 p-3 border border-hairline rounded-md hover:border-hairline-strong transition-colors"
              >
                <div className="h-9 w-9 grid place-items-center bg-surface-2 rounded-md shrink-0">
                  <FileText className="h-4 w-4 text-ink-3" />
                </div>
                <div className="flex-1 min-w-0">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[14px] text-ink truncate group-hover:text-accent transition-colors block"
                  >
                    {link.title}
                  </a>
                  <div className="text-[12px] text-ink-3 truncate">
                    {link.description || link.url}
                  </div>
                </div>
                {canEdit && (
                  <button
                    onClick={() => remove.mutate(link.id)}
                    disabled={remove.isPending}
                    className="h-7 w-7 grid place-items-center rounded text-ink-3 hover:text-danger hover:bg-tag-red-bg/30 transition-colors"
                    title="Удалить"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <AddLinkDialog
          open={open}
          onOpenChange={setOpen}
          onSubmit={(values) => add.mutate(values)}
          pending={add.isPending}
        />
      </PanelBody>
    </Panel>
  );
}

function AddLinkDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (values: DealLinkCreate) => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");

  function reset() {
    setTitle("");
    setUrl("");
    setDescription("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader
          eyebrow="Проект · Ссылка"
          title="Добавить ссылку"
          description="Добавьте документ, макет, доску, репозиторий или другой полезный ресурс."
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({
              title,
              url,
              description: description || undefined,
            });
            reset();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Название">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Figma макеты"
              autoFocus
              required
            />
          </Field>
          <Field label="URL">
            <Input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              required
            />
          </Field>
          <Field label="Описание">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Необязательно"
            />
          </Field>
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button type="button" variant="ghost" size="md" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={pending || !title.trim() || !url.trim()}>
              {pending ? "Сохраняем…" : "Добавить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------- Payments tab ------- *
 *
 * Payments come with the project. A received payment (not delayed, date not
 * in the future) is also an income in «Доходы» and counts as «Оплачено»;
 * planned and delayed ones wait for «Оплачен».
 */

function paymentSavedMessage(p: DealPayment) {
  if (p.linked_existing) {
    return "Платёж связан с доходом, который уже был записан вручную.";
  }
  return p.is_paid
    ? "Платёж зафиксирован и добавлен в доходы."
    : "Платёж запланирован — в доходы попадёт, когда отметите его оплаченным.";
}

function PaymentsTab({
  isCollaborator,
  canManagePayments,
  payments,
  busy,
  onMarkPaid,
  onRemovePayment,
  onOpenAdd,
}: {
  dealId: number;
  isCollaborator: boolean;
  canManagePayments: boolean;
  payments: DealPayment[];
  busy: boolean;
  onMarkPaid: (paymentId: number) => void;
  onRemovePayment: (paymentId: number) => void;
  onOpenAdd: () => void;
}) {
  const canManage = !isCollaborator && canManagePayments;
  const sorted = [...payments].sort(
    (a, b) => b.payment_date.localeCompare(a.payment_date) || b.id - a.id
  );

  return (
    <Panel className="anim-fade">
      <PanelHeader>
        <PanelTitle>Платежи</PanelTitle>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-ink-3">
            {payments.length}{" "}
            {plural(payments.length, "платёж", "платежа", "платежей")}
          </span>
          {canManage && (
            <Button variant="primary" size="sm" onClick={onOpenAdd}>
              <Plus className="h-3.5 w-3.5" />
              Добавить
            </Button>
          )}
        </div>
      </PanelHeader>
      <PanelBody>
        {sorted.length === 0 ? (
          <div className="text-[13px] text-ink-4 py-8 text-center">
            Платежей пока нет.
          </div>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Дата</TH>
                <TH className="text-right">Сумма</TH>
                <TH>Статус</TH>
                <TH className="w-[120px]"></TH>
              </TR>
            </THead>
            <tbody>
              {sorted.map((p) => {
                const status: {
                  tone: "green" | "yellow" | "gray";
                  label: string;
                } = p.is_paid
                  ? { tone: "green", label: "оплачен · в доходах" }
                  : p.delayed
                  ? { tone: "yellow", label: "задержан" }
                  : { tone: "gray", label: "запланирован" };
                return (
                  <TR key={p.id}>
                    <TD className="text-ink-2 tabular-nums">
                      {formatDate(p.payment_date)}
                    </TD>
                    <TD className="text-right font-medium tabular-nums">
                      {formatProtectedCurrency(
                        p.amount,
                        p.can_view_amount !== false
                      )}
                    </TD>
                    <TD>
                      <Badge tone={status.tone} dot>
                        {status.tone === "green" ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : (
                          <Clock className="h-3 w-3" />
                        )}
                        {status.label}
                      </Badge>
                    </TD>
                    <TD>
                      {canManage && (
                        <div className="flex items-center justify-end gap-1">
                          {!p.is_paid && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => onMarkPaid(p.id)}
                              title="Платёж получен сегодня — добавить в доходы"
                            >
                              <Check className="h-3.5 w-3.5" />
                              Оплачен
                            </Button>
                          )}
                          <button
                            onClick={() => onRemovePayment(p.id)}
                            disabled={busy}
                            className="h-7 w-7 grid place-items-center rounded text-ink-3 hover:text-danger hover:bg-tag-red-bg/30 transition-colors"
                            title="Удалить"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </PanelBody>
    </Panel>
  );
}

// AddPaymentDialog is now defined in ./payment-dialog.tsx and imported above.

/* ------- Files tab ------- */

function FilesTab({
  dealId,
  files,
  canEdit,
}: {
  dealId: number;
  files: DealFile[];
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const add = useMutation({
    mutationFn: (payload: DealFileCreate) => deals.addFile(dealId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal", dealId] });
      toast.success("Файл прикреплён.");
      setOpen(false);
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const remove = useMutation({
    mutationFn: (fileId: number) => deals.removeFile(dealId, fileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal", dealId] });
      toast.success("Файл удалён.");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  return (
    <Panel className="anim-fade">
      <PanelHeader>
        <PanelTitle>Файлы</PanelTitle>
        {canEdit && (
          <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            Прикрепить
          </Button>
        )}
      </PanelHeader>
      <PanelBody>
        {files.length === 0 ? (
          <div className="text-[13px] text-ink-4 py-8 text-center">
            Файлов пока нет.
          </div>
        ) : (
          <div className="space-y-2">
            {files.map((f) => {
              const fileHref = f.file_url || f.file;
              return (
              <div
                key={f.id}
                className="group flex items-start gap-3 p-3 border border-hairline rounded-md hover:border-hairline-strong transition-colors"
              >
                <div className="h-9 w-9 grid place-items-center bg-surface-2 rounded-md shrink-0">
                  <FileText className="h-4 w-4 text-ink-3" />
                </div>
                <div className="flex-1 min-w-0">
                  <a
                    href={fileHref}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[14px] text-ink truncate group-hover:text-accent transition-colors block"
                  >
                    {f.file_name}
                  </a>
                  {f.description && (
                    <div className="text-[12px] text-ink-3 truncate">
                      {f.description}
                    </div>
                  )}
                </div>
                <a
                  href={fileHref}
                  target="_blank"
                  rel="noreferrer"
                  className="h-7 w-7 grid place-items-center rounded text-ink-3 hover:text-accent transition-colors"
                  title="Скачать"
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
                {canEdit && (
                  <button
                    onClick={() => remove.mutate(f.id)}
                    disabled={remove.isPending}
                    className="h-7 w-7 grid place-items-center rounded text-ink-3 hover:text-danger hover:bg-tag-red-bg/30 transition-colors"
                    title="Удалить"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              );
            })}
          </div>
        )}
        <AddFileDialog
          open={open}
          onOpenChange={setOpen}
          onSubmit={(values) => add.mutate(values)}
          pending={add.isPending}
        />
      </PanelBody>
    </Panel>
  );
}

function AddFileDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (values: DealFileCreate) => void;
  pending: boolean;
}) {
  const [fileName, setFileName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");

  function reset() {
    setFileName("");
    setFile(null);
    setDescription("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader
          eyebrow="Проект · Файл"
          title="Прикрепить файл"
          description="Выберите файл с компьютера. Он будет загружен в проект как вложение."
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!file) return;
            onSubmit({
              file_name: fileName || file.name,
              file,
              description: description || undefined,
            });
            reset();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Название файла">
            <Input
              placeholder="например, договор-v2.pdf"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
            />
          </Field>
          <Field label="Файл">
            <Input
              type="file"
              onChange={(e) => {
                const next = e.target.files?.[0] ?? null;
                setFile(next);
                if (next && !fileName) setFileName(next.name);
              }}
              autoFocus
              required
            />
          </Field>
          <Field label="Описание">
            <Input
              placeholder="Необязательно"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
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
              disabled={pending || !file}
            >
              {pending ? "Сохраняем…" : "Прикрепить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------- Shared ------- */

function Money({
  k,
  v,
  accent,
}: {
  k: string;
  v: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "bg-canvas border border-hairline rounded-lg px-4 sm:px-5 py-4",
        accent && "bg-accent-soft border-accent/20"
      )}
    >
      <div className="text-[12px] text-ink-3 mb-1">{k}</div>
      <div
        className={cn(
          "font-display text-[24px] tabular-nums",
          accent ? "text-accent-ink" : "text-ink"
        )}
      >
        {v}
      </div>
    </div>
  );
}

function StatusBadge({ stage }: { stage: string }) {
  const m = stageLabel(stage);
  return (
    <Badge tone={m.tone} dot>
      {m.label}
    </Badge>
  );
}
