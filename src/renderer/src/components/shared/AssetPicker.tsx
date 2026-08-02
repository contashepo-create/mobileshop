import { useEffect, useState } from 'react';
import { Select } from '../ui/Input';

/**
 * ONE dropdown listing every asset money can arrive in or leave from.
 *
 * WHAT WAS WRONG
 * --------------
 * Screens that move money offered TWO separate fields: "الخزنة/البنك" and,
 * beside it, "طريقة الدفع (اختياري)". They are not two different questions —
 * both name an asset with a balance, and the money lands in exactly one of
 * them. Presenting them as separate fields produced three bad outcomes, all
 * reachable from the ordinary form:
 *
 *   chose a safe only          -> the safe moves                    (correct)
 *   chose a wallet only        -> the wallet moves, and the safe
 *                                 field sits there looking relevant
 *   chose BOTH                 -> the WALLET moves and the safe is
 *                                 silently ignored; the document names
 *                                 two assets and only one of them moved
 *   chose NEITHER              -> the voucher is accepted and NO asset
 *                                 changes. The money leaves the books
 *                                 entirely.
 *
 * The last one is the worst: a payment voucher with no destination was
 * accepted, so the expense was recorded while no asset was reduced.
 *
 * WHAT THIS DOES
 * --------------
 * Asks the question once: WHERE did the money go, or come from? The list is
 * built from the live tables, so a new safe, bank or wallet appears without
 * anyone editing this component — which is what "قابلة للزيادة" requires.
 *
 * The value is a single string, `"cash:3"` or `"method:7"`, so the caller
 * cannot end up holding two ids at once. `splitAssetValue` turns it back into
 * the pair the IPC handlers already expect, which means no handler signature
 * has to change.
 */

export interface AssetOption {
  value: string;
  label: string;
  balance: number;
  kind: 'cash' | 'method';
  id: number;
}

/** `"cash:3"` -> `{ CashAccountID: 3 }`, `"method:7"` -> `{ PaymentMethodID: 7 }`. */
export function splitAssetValue(value: string): {
  CashAccountID?: number; PaymentMethodID?: number;
} {
  const [kind, raw] = String(value ?? '').split(':');
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) return {};
  if (kind === 'cash') return { CashAccountID: id };
  if (kind === 'method') return { PaymentMethodID: id };
  return {};
}

/** The reverse, for editing a record that already names one of the two. */
export function toAssetValue(
  cashAccountId?: number | null, paymentMethodId?: number | null,
): string {
  // A stored row can name both, because the old form allowed it. The wallet
  // is preferred here because that is the one the handler actually moved —
  // showing the safe would tell the user something untrue about their books.
  if (paymentMethodId) return `method:${paymentMethodId}`;
  if (cashAccountId) return `cash:${cashAccountId}`;
  return '';
}

/**
 * Loads every asset, once, and keeps them grouped.
 *
 * Exported separately so a screen can render its own control while still
 * using the same list and the same labels.
 */
export function useAssets(): { assets: AssetOption[]; loading: boolean; reload: () => void } {
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [cash, methods] = await Promise.all([
      window.api.invoke('cashAccounts:list'),
      window.api.invoke('paymentMethods:list'),
    ]);
    const out: AssetOption[] = [];
    if (Array.isArray(cash)) {
      for (const c of cash) {
        out.push({
          value: `cash:${c.CashAccountID}`,
          label: c.AccountName,
          balance: Number(c.Balance) || 0,
          kind: 'cash',
          id: c.CashAccountID,
        });
      }
    }
    if (Array.isArray(methods)) {
      for (const m of methods) {
        // Inactive wallets stay out: naming one on a new document would move
        // money into an asset the shop has retired.
        if (m.IsActive === 0) continue;
        out.push({
          value: `method:${m.PaymentMethodID}`,
          label: m.MethodName,
          balance: Number(m.Balance) || 0,
          kind: 'method',
          id: m.PaymentMethodID,
        });
      }
    }
    setAssets(out);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);
  return { assets, loading, reload: load };
}

export interface AssetPickerProps {
  value: string;
  onChange: (value: string) => void;
  /** Overrides the default label, e.g. "المستلم في" versus "المصروف من". */
  label?: string;
  /** Pre-loaded list, when the screen already holds one. */
  assets?: AssetOption[];
  /** Shows the balance beside each name. On by default. */
  showBalance?: boolean;
  disabled?: boolean;
  className?: string;
}

export function AssetPicker({
  value, onChange, label = 'الأصل (الخزنة / البنك / المحفظة)',
  assets: provided, showBalance = true, disabled, className,
}: AssetPickerProps) {
  const own = useAssets();
  const assets = provided ?? own.assets;

  const cash = assets.filter(a => a.kind === 'cash');
  const methods = assets.filter(a => a.kind === 'method');
  const fmt = (a: AssetOption) =>
    showBalance ? `${a.label} (${a.balance.toFixed(2)})` : a.label;

  return (
    <Select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className}
    >
      <option value="">— اختر —</option>
      {/* Grouped so a long list stays readable, but it is ONE field: the user
          picks a single destination and cannot accidentally name two. */}
      {cash.length > 0 && (
        <optgroup label="الخزائن والبنوك">
          {cash.map(a => <option key={a.value} value={a.value}>{fmt(a)}</option>)}
        </optgroup>
      )}
      {methods.length > 0 && (
        <optgroup label="المحافظ وطرق الدفع">
          {methods.map(a => <option key={a.value} value={a.value}>{fmt(a)}</option>)}
        </optgroup>
      )}
    </Select>
  );
}
