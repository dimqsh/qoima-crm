"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Topbar } from "@/components/app-shell/topbar";
import { Panel, PanelHeader, PanelTitle, PanelBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, THead, TR, TH, TD } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { incomes, wallets } from "@/lib/endpoints";
import { usePagedList } from "@/lib/use-paged-list";
import { LoadMore } from "@/components/load-more";
import { WalletBreakdown } from "@/components/wallet-breakdown";
import { INCOME_TYPES, typeMetaForIncome } from "@/lib/income-type-meta";
import { formatCurrency, formatDate, cn, plural } from "@/lib/utils";
import { asApiError } from "@/lib/api";
import { useChartColors } from "@/lib/use-chart-colors";
import {
  useHasPermission,
  useIsSuperuser,
  useRole,
} from "@/lib/permissions";
import { PermissionDenied } from "@/components/permission-gate";
import { IncomeFormDialog } from "./income-form-dialog";
import type { Income, IncomeFilters } from "@/lib/types";
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  AlertTriangle,
  X,
  Wallet as WalletIcon,
  FolderKanban,
} from "lucide-react";

function colorFor(t: string) {
  return typeMetaForIncome(t).color;
}
function iconFor(t: string) {
  return typeMetaForIncome(t).icon;
}
function labelFor(t: string) {
  return typeMetaForIncome(t).label;
}

export default function IncomesPage() {
  const role = useRole();
  const isSuper = useIsSuperuser();
  const access = useHasPermission("accounting_can_retrieve");
  const canCreate = useHasPermission("accounting_can_create");
  const canUpdate = useHasPermission("accounting_can_update");
  const canDelete = useHasPermission("accounting_can_delete");
  const allowed = isSuper || (role === "employee" && access.granted);
  const canCreateEntry = isSuper || canCreate.granted;
  const canUpdateEntry = isSuper || canUpdate.granted;
  const canDeleteEntry = isSuper || canDelete.granted;

  const [search, setSearch] = useState("");
  const [activeType, setActiveType] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [activeWallet, setActiveWallet] = useState<number | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const c = useChartColors();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters: IncomeFilters = useMemo(
    () => ({
      type: activeType ?? undefined,
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
      wallet: activeWallet ?? undefined,
      search: debouncedSearch || undefined,
    }),
    [activeType, fromDate, toDate, activeWallet, debouncedSearch]
  );

  const paged = usePagedList({
    queryKey: ["incomes", "paged", filters],
    fetchPage: (page) => incomes.page(filters, page),
    enabled: allowed,
  });
  const listQ = paged.query;

  // Incomes are few and read as one ledger — pull every page right away
  // instead of making the user click "Показать ещё".
  const { hasMore, isLoadingMore, loadAll } = paged;
  useEffect(() => {
    if (hasMore && !isLoadingMore) void loadAll();
  }, [hasMore, isLoadingMore, loadAll]);

  const walletsQ = useQuery({
    queryKey: ["wallets"],
    queryFn: wallets.list,
    enabled: allowed,
  });

  const analyticsQ = useQuery({
    queryKey: ["incomes-analytics", filters],
    queryFn: () => incomes.analytics(filters),
    enabled: allowed,
  });

  // Filters and search run on the server; the list arrives newest first.
  const filtered = paged.items;
  const months = useMemo(() => groupByMonth(filtered), [filtered]);

  const analytics = analyticsQ.data;
  const totalAmount = Number(analytics?.total.total_amount ?? 0);
  const totalCount = analytics?.total.count ?? 0;

  const byType = useMemo(() => {
    return (analytics?.by_type ?? [])
      .map((b) => ({ name: b.type, value: Number(b.total_amount) }))
      .filter((b) => b.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [analytics]);

  const runwayData = useMemo(
    () =>
      (analytics?.by_date ?? [])
        .slice()
        .sort((a, b) => a.date_earned.localeCompare(b.date_earned))
        .map((d) => ({
          d: d.date_earned.slice(5),
          v: Number(d.total_amount),
        })),
    [analytics]
  );

  const typeOptions = useMemo(() => {
    const keys = new Set([...INCOME_TYPES, ...byType.map((b) => b.name)]);
    if (activeType) keys.add(activeType);
    return [...keys].sort((a, b) => labelFor(a).localeCompare(labelFor(b), "ru"));
  }, [byType, activeType]);

  const filtersActive = Boolean(
    activeType || fromDate || toDate || search || activeWallet
  );

  if (!allowed) {
    return (
      <>
        <Topbar eyebrow="Финансы" title="Доходы" />
        <PermissionDenied
          title="Доступ к доходам ограничен"
          detail={
            role === "collaborator"
              ? "Эту страницу видят только сотрудники с правом «accounting_can_retrieve»."
              : "У вашей учётной записи нет права «accounting_can_retrieve». Попросите администратора выдать его."
          }
        />
      </>
    );
  }

  return (
    <>
      <Topbar
        eyebrow="Финансы"
        title="Доходы"
        actions={
          canCreateEntry ? (
            <IncomeFormDialog
              trigger={
                <Button variant="primary" size="sm">
                  <Plus className="h-3.5 w-3.5" />
                  Записать доход
                </Button>
              }
            />
          ) : undefined
        }
      />
      <main className="flex-1 px-4 sm:px-6 lg:px-10 py-6 sm:py-10 max-w-[1280px] mx-auto w-full">
        <header className="mb-8 anim-rise">
          <h1 className="font-display text-[28px] tracking-tight text-ink">
            Доходы
          </h1>
          <p className="mt-2 text-[14px] text-ink-3">
            Все поступления компании: оплаты по проектам, разовые платежи,
            консультации, продажи.
          </p>
        </header>

        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6 stagger">
          <Stat
            label={filtersActive ? "По фильтру" : "Всего заработано"}
            value={formatCurrency(totalAmount)}
            accent
          />
          <Stat label="Записей" value={String(totalCount)} />
          <Stat
            label="Средний чек"
            value={formatCurrency(
              totalCount > 0 ? totalAmount / totalCount : 0
            )}
          />
          <Stat
            label="Самый крупный"
            value={formatCurrency(Number(analytics?.total.max_amount ?? 0))}
          />
        </section>

        <WalletBreakdown
          rows={analytics?.by_wallet ?? []}
          wallets={walletsQ.data ?? []}
          active={activeWallet}
          onSelect={setActiveWallet}
          verb="получено"
        />

        <section className="flex flex-col md:flex-row md:items-end gap-3 mb-6 anim-fade">
          <div className="flex-1 max-w-md relative">
            <Search className="absolute left-3 top-[34px] h-4 w-4 text-ink-4 pointer-events-none" />
            <label className="text-[12px] font-medium text-ink-2 mb-1.5 block">
              Поиск
            </label>
            <Input
              placeholder="Название, категория или заметка"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="w-full md:w-auto">
            <label className="text-[12px] font-medium text-ink-2 mb-1.5 block">
              Категория
            </label>
            <select
              value={activeType ?? ""}
              onChange={(e) => setActiveType(e.target.value || null)}
              className="h-9 w-full md:w-[180px] bg-canvas border border-hairline-strong rounded-md px-3 text-[14px] text-ink hover:border-ink-5 focus:border-accent outline-none transition-colors cursor-pointer"
            >
              <option value="">Все категории</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {iconFor(t)} {labelFor(t)}
                </option>
              ))}
            </select>
          </div>
          <div className="w-full md:w-auto">
            <label className="text-[12px] font-medium text-ink-2 mb-1.5 block">
              С даты
            </label>
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full md:w-[160px]"
            />
          </div>
          <div className="w-full md:w-auto">
            <label className="text-[12px] font-medium text-ink-2 mb-1.5 block">
              По дату
            </label>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full md:w-[160px]"
            />
          </div>
          {filtersActive && (
            <Button
              variant="outline"
              size="md"
              onClick={() => {
                setActiveType(null);
                setFromDate("");
                setToDate("");
                setSearch("");
                setActiveWallet(null);
              }}
            >
              <X className="h-3.5 w-3.5" />
              Сбросить
            </Button>
          )}
        </section>

        {listQ.isError && (
          <Panel className="p-6 mb-6 anim-fade">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 grid place-items-center bg-tag-red-bg text-tag-red-fg rounded-md">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <h3 className="text-[14px] text-ink font-medium">
                  Не удалось загрузить доходы
                </h3>
                <p className="text-[13px] text-ink-3 mt-1">
                  {asApiError(listQ.error).message}
                </p>
                <p className="text-[12px] font-mono text-ink-4 mt-3">
                  GET /api/incomes/ — endpoint, скорее всего, ещё не реализован
                  на бэке.
                </p>
              </div>
            </div>
          </Panel>
        )}

        <Panel className="mb-6">
          <PanelHeader>
            <PanelTitle>Все доходы</PanelTitle>
            <span className="text-[12px] text-ink-3 tabular-nums">
              {listQ.isLoading
                ? "Загрузка…"
                : `${paged.total} ${plural(
                    paged.total,
                    "запись",
                    "записи",
                    "записей"
                  )} · ${formatCurrency(totalAmount)}`}
            </span>
          </PanelHeader>
          <Table>
            <THead>
              <TR>
                <TH className="hidden sm:table-cell w-[88px]">Дата</TH>
                <TH>Название</TH>
                <TH className="hidden sm:table-cell">Категория</TH>
                <TH className="hidden lg:table-cell">Кошелёк</TH>
                <TH className="text-right">Сумма</TH>
                <TH className="w-[72px] pl-0 pr-2 sm:px-4"></TH>
              </TR>
            </THead>
            <tbody>
              {months.map((m) => (
                <MonthGroup
                  key={m.key}
                  month={m}
                  canEdit={canUpdateEntry}
                  canDelete={canDeleteEntry}
                />
              ))}
              {!listQ.isLoading && filtered.length === 0 && (
                <TR>
                  <TD colSpan={6} className="text-center text-ink-4 py-12">
                    Ничего не найдено.
                  </TD>
                </TR>
              )}
            </tbody>
          </Table>
          <LoadMore
            shown={filtered.length}
            total={paged.total}
            hasMore={paged.hasMore}
            onMore={paged.loadMore}
            onAll={paged.loadAll}
            loading={paged.isLoadingMore}
          />
        </Panel>

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.4fr] gap-4">
          <Panel>
            <PanelHeader>
              <PanelTitle>По категориям</PanelTitle>
              <span className="text-[12px] text-ink-3">
                {byType.length}{" "}
                {plural(byType.length, "категория", "категории", "категорий")}
              </span>
            </PanelHeader>
            <PanelBody>
              {byType.length === 0 ? (
                <p className="text-[13px] text-ink-4 text-center py-10">
                  Нет данных для отображения
                </p>
              ) : (
                <div className="flex flex-col xl:flex-row items-center gap-6">
                  <div className="h-[160px] w-[160px] sm:h-[200px] sm:w-[200px] relative shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={byType}
                          innerRadius={64}
                          outerRadius={90}
                          paddingAngle={2}
                          dataKey="value"
                          stroke="none"
                        >
                          {byType.map((d) => (
                            <Cell key={d.name} fill={colorFor(d.name)} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: c.canvas,
                            border: `1px solid ${c.hairlineStrong}`,
                            borderRadius: 8,
                            fontSize: 12,
                            color: c.ink,
                          }}
                          formatter={(v) => formatCurrency(Number(v))}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 grid place-items-center pointer-events-none">
                      <div className="text-center">
                        <div className="text-[11px] text-ink-3">Всего</div>
                        <div className="font-display text-[20px] tabular-nums text-ink mt-1">
                          {totalAmount >= 1000
                            ? `${(totalAmount / 1000).toFixed(1)}k`
                            : formatCurrency(totalAmount)}
                        </div>
                      </div>
                    </div>
                  </div>
                  <ul className="flex-1 w-full space-y-1.5">
                    {byType.map((b) => {
                      const pct =
                        totalAmount > 0 ? (b.value / totalAmount) * 100 : 0;
                      const isActive = activeType === b.name;
                      return (
                        <li key={b.name}>
                          <button
                            onClick={() =>
                              setActiveType(isActive ? null : b.name)
                            }
                            className={cn(
                              "w-full flex items-center justify-between px-3 h-9 text-left transition-colors rounded-md min-w-0",
                              isActive
                                ? "bg-accent-soft text-ink"
                                : "hover:bg-surface-2 text-ink-2"
                            )}
                          >
                            <span className="flex items-center gap-2 text-[13px] min-w-0">
                              <span
                                className="text-[14px] leading-none"
                                aria-hidden
                              >
                                {iconFor(b.name)}
                              </span>
                              <span
                                className="h-1.5 w-1.5 rounded-full shrink-0"
                                style={{ background: colorFor(b.name) }}
                              />
                              <span className="text-ink truncate">
                                {labelFor(b.name)}
                              </span>
                            </span>
                            <span className="flex items-center gap-3 text-[12px] tabular-nums">
                              <span className="text-ink-3">
                                {pct.toFixed(0)}%
                              </span>
                              <span className="text-ink">
                                {formatCurrency(b.value)}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <PanelTitle>Динамика доходов</PanelTitle>
              <span className="text-[12px] text-ink-3">
                {runwayData.length}{" "}
                {plural(runwayData.length, "день", "дня", "дней")}
              </span>
            </PanelHeader>
            <PanelBody>
              {runwayData.length === 0 ? (
                <p className="text-[13px] text-ink-4 text-center py-16">
                  Нет данных для отображения
                </p>
              ) : (
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={runwayData}
                      margin={{ top: 10, right: 4, left: 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient
                          id="incfill"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop offset="0%" stopColor="#3D9C47" stopOpacity={0.22} />
                          <stop offset="100%" stopColor="#3D9C47" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={c.hairline} vertical={false} />
                      <XAxis
                        dataKey="d"
                        stroke={c.ink4}
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        stroke={c.ink4}
                        fontSize={11}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => `${(v / 1000).toFixed(1)}k`}
                      />
                      <Tooltip
                        cursor={{ stroke: "#3D9C47", strokeWidth: 1 }}
                        contentStyle={{
                          background: c.canvas,
                          border: `1px solid ${c.hairlineStrong}`,
                          borderRadius: 8,
                          fontSize: 12,
                          color: c.ink,
                        }}
                        formatter={(v) => formatCurrency(Number(v))}
                      />
                      <Area
                        type="monotone"
                        dataKey="v"
                        stroke="#3D9C47"
                        strokeWidth={2}
                        fill="url(#incfill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </PanelBody>
          </Panel>
        </div>

      </main>
    </>
  );
}

type MonthBucket = {
  key: string;
  label: string;
  total: number;
  items: Income[];
};

/** Split the (date-desc) list into calendar months, keeping order. */
function groupByMonth(list: Income[]): MonthBucket[] {
  const buckets: MonthBucket[] = [];
  for (const s of list) {
    const key = s.date_earned.slice(0, 7);
    let bucket = buckets[buckets.length - 1];
    if (!bucket || bucket.key !== key) {
      const [y, m] = key.split("-").map(Number);
      const month = new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(
        new Date(y, m - 1, 1)
      );
      bucket = {
        key,
        label: `${month.charAt(0).toUpperCase()}${month.slice(1)} ${y}`,
        total: 0,
        items: [],
      };
      buckets.push(bucket);
    }
    bucket.total += Number(s.amount);
    bucket.items.push(s);
  }
  return buckets;
}

function MonthGroup({
  month,
  canEdit,
  canDelete,
}: {
  month: MonthBucket;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const label = (
    <>
      {month.label}
      <span className="text-ink-4 font-normal">
        {" "}
        · {month.items.length}{" "}
        {plural(month.items.length, "запись", "записи", "записей")}
      </span>
    </>
  );

  return (
    <>
      {/* Cells mirror the column visibility so the total sits under «Сумма». */}
      <tr className="text-[12px] [&>td]:h-9 [&>td]:px-3 sm:[&>td]:px-4 [&>td]:bg-surface-2/70 [&>td]:border-b [&>td]:border-hairline">
        <td
          colSpan={2}
          className="hidden sm:table-cell font-medium text-ink-2 whitespace-nowrap"
        >
          {label}
        </td>
        <td className="sm:hidden font-medium text-ink-2">{label}</td>
        <td className="hidden sm:table-cell" />
        <td className="hidden lg:table-cell" />
        <td className="text-right font-medium text-ink tabular-nums whitespace-nowrap">
          {formatCurrency(month.total)}
        </td>
        <td />
      </tr>
      {month.items.map((s) => (
        <IncomeRow key={s.id} s={s} canEdit={canEdit} canDelete={canDelete} />
      ))}
    </>
  );
}

function IncomeRow({
  s,
  canEdit,
  canDelete,
}: {
  s: Income;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => incomes.remove(s.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incomes"] });
      qc.invalidateQueries({ queryKey: ["incomes-analytics"] });
      qc.invalidateQueries({ queryKey: ["wallets"] });
      qc.invalidateQueries({ queryKey: ["wallets-logs"] });
      qc.invalidateQueries({ queryKey: ["wallets-analytics"] });
      qc.invalidateQueries({ queryKey: ["deal"] });
      qc.invalidateQueries({ queryKey: ["deals"] });
      toast.success("Запись удалена.");
    },
    onError: (err) => toast.error(asApiError(err).message),
  });

  const hasActions = canEdit || canDelete;

  return (
    <TR>
      <TD className="hidden sm:table-cell text-ink-3 text-[13px] tabular-nums whitespace-nowrap">
        {formatDate(s.date_earned, { day: "numeric", month: "short" })}
      </TD>
      <TD className="py-2">
        <div className="text-ink leading-snug">{s.name}</div>
        {s.deal && (
          <Link
            href={`/deals/${s.deal}`}
            className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
            title="Платёж записан в проекте"
          >
            <FolderKanban className="h-3 w-3" />
            {s.deal_name}
          </Link>
        )}
        {s.note && (
          <div
            className="text-[12px] text-ink-3 leading-snug mt-0.5 line-clamp-2 max-w-[48ch]"
            title={s.note}
          >
            {s.note}
          </div>
        )}
        {/* Date, category and wallet fold under the name on narrow screens. */}
        <div className="sm:hidden mt-1 flex items-center gap-2 flex-wrap">
          <span className="text-[12px] text-ink-3 tabular-nums">
            {formatDate(s.date_earned, { day: "numeric", month: "short" })}
          </span>
          <Badge tone={typeMetaForIncome(s.type).tone}>
            <span className="text-[12px] leading-none" aria-hidden>
              {iconFor(s.type)}
            </span>
            {labelFor(s.type)}
          </Badge>
        </div>
        {s.wallet_name && (
          <div className="lg:hidden mt-1 inline-flex items-center gap-1 text-[12px] text-ink-3">
            <WalletIcon className="h-3 w-3 text-ink-4" />
            {s.wallet_name}
          </div>
        )}
      </TD>
      <TD className="hidden sm:table-cell">
        <Badge tone={typeMetaForIncome(s.type).tone}>
          <span className="text-[12px] leading-none" aria-hidden>
            {iconFor(s.type)}
          </span>
          {labelFor(s.type)}
        </Badge>
      </TD>
      <TD className="hidden lg:table-cell">
        {s.wallet_name ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2 whitespace-nowrap">
            <WalletIcon className="h-3.5 w-3.5 text-ink-4" />
            {s.wallet_name}
          </span>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </TD>
      <TD className="text-right font-medium tabular-nums whitespace-nowrap">
        {formatCurrency(s.amount)}
      </TD>
      <TD className="pl-0 pr-2 sm:px-4">
        {hasActions && (
        <div className="flex items-center justify-end gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 transition-opacity">
          {canEdit && (
          <IncomeFormDialog
            initial={s}
            trigger={
              <button
                title="Редактировать"
                className="h-7 w-7 grid place-items-center rounded text-ink-3 hover:text-ink hover:bg-surface-2 transition-colors"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            }
          />
          )}
          {canDelete && (
          <button
            title="Удалить"
            onClick={() => {
              const msg = s.deal
                ? `Удалить «${s.name}»? Платёж в проекте «${s.deal_name}» тоже удалится.`
                : `Удалить «${s.name}»?`;
              if (confirm(msg)) del.mutate();
            }}
            disabled={del.isPending}
            className="h-7 w-7 grid place-items-center rounded text-ink-3 hover:text-danger hover:bg-tag-red-bg/30 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          )}
        </div>
        )}
      </TD>
    </TR>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "bg-canvas border border-hairline rounded-lg px-4 py-3",
        accent && "bg-accent-soft border-accent/20"
      )}
    >
      <div className="text-[12px] text-ink-3 mb-1">{label}</div>
      <div
        className={cn(
          "font-display text-[18px] sm:text-[22px] tabular-nums break-words",
          accent ? "text-accent-ink" : "text-ink"
        )}
      >
        {value}
      </div>
    </div>
  );
}
