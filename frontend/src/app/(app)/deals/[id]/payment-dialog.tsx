"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { WalletPicker } from "@/components/wallet-picker";
import type { DealPaymentCreate } from "@/lib/types";

export function AddPaymentDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (values: DealPaymentCreate) => void;
  pending: boolean;
}) {
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [delayed, setDelayed] = useState(false);
  const [wallet, setWallet] = useState<number | null>(null);
  const received = !delayed && date <= new Date().toISOString().slice(0, 10);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader
          eyebrow="Проект · Платёж"
          title="Зафиксировать платёж"
          description="Полученный платёж сразу попадёт в «Доходы». Задержанный или будущий — когда отметите его оплаченным."
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({ amount, payment_date: date, delayed, wallet });
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Сумма (₸)">
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
              required
            />
          </Field>
          <Field label="Дата платежа">
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </Field>
          <label className="flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer">
            <input
              type="checkbox"
              checked={delayed}
              onChange={(e) => setDelayed(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            Платёж задержан
          </label>
          {received && (
            <WalletPicker
              label="Куда зачислить"
              value={wallet}
              onChange={setWallet}
            />
          )}
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
              disabled={pending || !amount}
            >
              {pending ? "Сохраняем…" : "Записать"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
