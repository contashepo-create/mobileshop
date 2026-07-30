/**
 * Validation for amounts of money arriving from the renderer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several handlers took an `Amount` straight from the caller and applied it to
 * a balance with `Balance = Balance + ?`. A NEGATIVE amount then runs the
 * operation backwards, and because every handler writes its own arithmetic the
 * result is money appearing out of nowhere rather than an error:
 *
 *   - `advances:create` with Amount = -5000 ADDED 5000 to the cash box while
 *     recording an advance to an employee. Measured: 100,000 -> 105,000.
 *   - `vouchers:create` with a receipt of -9999 took 9,999 OUT of the till and
 *     recorded it as money coming in.
 *   - `deductions:create` with -500 turned a deduction into a bonus.
 *
 * None of these needs an attacker. A minus sign typed into a number field, or
 * a paste of "-500", is enough — and the shop's own reports would then agree
 * with the wrong figure, because the document and the balance were written
 * from the same bad number.
 *
 * The guard belongs here rather than in each handler because "an amount of
 * money is a finite, non-negative number" is one rule, and the project has
 * already shown what happens when one rule is re-implemented in eighteen
 * places with slightly different arithmetic.
 */

/** Upper bound: any single amount larger than this is a typo, not a trade. */
const MAX_AMOUNT = 1e12;

export interface AmountCheck {
  ok: boolean;
  /** Arabic message, ready to return straight to the renderer. */
  message?: string;
  /** The value, normalised to a number, when valid. */
  value: number;
}

/**
 * Validates one amount.
 *
 * `allowZero` defaults to true because a zero-value document is legitimate in
 * this application (a warranty repair, a fully discounted line). What is never
 * legitimate is a negative one: a refund, a reversal or a deduction is
 * expressed by the DIRECTION of the operation, never by the sign of the money.
 */
export function checkAmount(
  raw: unknown,
  label: string,
  { allowZero = true }: { allowZero?: boolean } = {},
): AmountCheck {
  const value = typeof raw === 'number' ? raw : Number(raw);

  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: false, message: `${label} مطلوب`, value: 0 };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, message: `${label} يجب أن يكون رقماً صحيحاً`, value: 0 };
  }
  if (value < 0) {
    return { ok: false, message: `${label} يجب أن يكون رقماً غير سالب`, value };
  }
  if (!allowZero && value === 0) {
    return { ok: false, message: `${label} يجب أن يكون أكبر من صفر`, value };
  }
  if (value > MAX_AMOUNT) {
    return { ok: false, message: `${label} أكبر من الحد المسموح`, value };
  }
  return { ok: true, value };
}

/**
 * Validates several amounts at once, returning the first problem.
 *
 * Returns null when everything is acceptable, so a handler reads:
 *
 *   const bad = checkAmounts([[data.Amount, 'المبلغ', { allowZero: false }]]);
 *   if (bad) return { success: false, message: bad };
 */
export function checkAmounts(
  entries: Array<[unknown, string] | [unknown, string, { allowZero?: boolean }]>,
): string | null {
  for (const [raw, label, opts] of entries) {
    const res = checkAmount(raw, label, opts ?? {});
    if (!res.ok) return res.message ?? `${label} غير صالح`;
  }
  return null;
}
