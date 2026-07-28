/**
 * How the value of a return is settled.
 *
 * THE RULE
 * --------
 * A return creates a VALUE owed to the other party. That value must be settled
 * in full, but HOW it is settled is the user's decision, not a formula:
 *
 *     TotalAmount = AccountCredit + CashRefund + TransferRefund
 *
 *   AccountCredit   left on the party's running balance — reduces what they
 *                   owe us, or becomes money we owe them if they owed nothing.
 *   CashRefund      handed over from a cash drawer.
 *   TransferRefund  sent through a wallet or card machine.
 *
 * WHY IT IS A CHOICE
 * ------------------
 * The previous version computed the split automatically — cancel the debt,
 * pay out the rest in cash — which only covers one real situation:
 *
 *   * a WALK-IN customer has no account, so nothing can be left on one; they
 *     must be paid out, possibly part cash and part transfer;
 *   * a REGISTERED customer who already paid may prefer the value left on
 *     their account for next time rather than cash out of the drawer;
 *   * the shop may settle part now and part later, or nothing at all today;
 *   * a wallet transfer costs a fee, which the old model could not express.
 *
 * WALK-IN CONSTRAINT
 * ------------------
 * With no account there is nowhere to hold a credit, so AccountCredit must be
 * zero and the whole value must be paid out now. That is enforced here rather
 * than trusted to the screen.
 *
 * Pure functions with no database and no Electron, so every rule below is
 * directly testable.
 */

export type FeeBearer = 'shop' | 'party';

export interface SettlementInput {
  /** The value of the goods coming back. */
  total: number;
  accountCredit?: number;
  cashRefund?: number;
  transferRefund?: number;
  /** True when the party has a real account (registered customer/supplier). */
  hasAccount: boolean;
  /** Required when cashRefund > 0. */
  cashAccountId?: number | null;
  /** Required when transferRefund > 0. */
  paymentMethodId?: number | null;
  /** Fee charged by the provider on the transfer leg. */
  transferCost?: number;
  /** Who absorbs that fee. */
  transferCostBearer?: FeeBearer;
  /**
   * How much the party has actually PAID on this document, net of refunds
   * already given. Cash and transfer legs may not exceed it.
   *
   * Omitted means "unknown" and the limit is not applied — kept optional so an
   * older caller still works, but every caller in this codebase supplies it.
   */
  paidSoFar?: number;
}

export interface SettlementResult {
  ok: boolean;
  message?: string;
  accountCredit: number;
  cashRefund: number;
  transferRefund: number;
  transferCost: number;
  transferCostBearer: FeeBearer;
  /** What actually leaves the wallet/machine balance. */
  transferOutflow: number;
  /** What the party actually receives through the transfer. */
  transferReceived: number;
}

/** Rounds to 2 decimals, avoiding the classic 0.1 + 0.2 drift. */
export const money = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** Tolerance for comparing two money figures (half a piastre). */
export const EPSILON = 0.005;

const finite = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Validates and normalises a settlement.
 *
 * Returns a structured failure instead of throwing so every caller surfaces
 * the same Arabic message to the user.
 */
export function validateSettlement(input: SettlementInput): SettlementResult {
  const fail = (message: string): SettlementResult => ({
    ok: false, message,
    accountCredit: 0, cashRefund: 0, transferRefund: 0,
    transferCost: 0, transferCostBearer: 'shop',
    transferOutflow: 0, transferReceived: 0,
  });

  const total = finite(input.total);
  if (!Number.isFinite(total) || total <= 0) {
    return fail('قيمة المرتجع يجب أن تكون أكبر من صفر');
  }

  const account = money(finite(input.accountCredit ?? 0));
  const cash = money(finite(input.cashRefund ?? 0));
  const transfer = money(finite(input.transferRefund ?? 0));

  for (const [label, v] of [['الرصيد', account], ['النقدي', cash], ['التحويل', transfer]] as const) {
    if (!Number.isFinite(v)) return fail(`قيمة ${label} غير صالحة`);
    if (v < 0) return fail(`قيمة ${label} لا يمكن أن تكون سالبة`);
  }

  // A walk-in has no account to hold anything.
  if (!input.hasAccount && account > 0) {
    return fail('العميل النقدي ليس له حساب - يجب صرف قيمة المرتجع بالكامل نقداً أو تحويلاً');
  }

  const settled = money(account + cash + transfer);
  const target = money(total);
  if (Math.abs(settled - target) > EPSILON) {
    const diff = money(target - settled);
    return fail(
      diff > 0
        ? `لم يتم توزيع كامل قيمة المرتجع - متبقٍ ${diff.toFixed(2)} غير موزّع`
        : `التوزيع أكبر من قيمة المرتجع بمقدار ${Math.abs(diff).toFixed(2)}`,
    );
  }

  // A destination is required for money that actually moves.
  if (cash > 0 && !input.cashAccountId) return fail('اختر الخزنة التي سيُصرف منها المبلغ النقدي');
  if (transfer > 0 && !input.paymentMethodId) return fail('اختر المحفظة/الماكينة التي سيتم التحويل منها');

  // You cannot hand back money that was never handed to you.
  //
  // Balancing the three parts is not sufficient on its own. On a credit sale
  // where the customer has paid nothing, "refund 200 in cash" balances
  // perfectly against a 200 return — and the shop ends up giving away the
  // goods AND 200 in cash while the customer still owes the original 200.
  //
  // The cash and transfer legs are therefore capped at what the party has
  // actually paid on this document, net of refunds already made. Anything
  // above that has to be settled against the account, which is the only
  // truthful place for it.
  const paidOut = money(cash + transfer);
  if (input.paidSoFar != null) {
    const refundable = money(Math.max(0, finite(input.paidSoFar) || 0));
    if (paidOut > refundable + EPSILON) {
      return fail(
        `لا يمكن رد ${paidOut.toFixed(2)} نقداً/تحويلاً — المدفوع فعلياً على هذه الفاتورة ${refundable.toFixed(2)} فقط. `
        + `الباقي يجب أن يُسجَّل على الحساب.`,
      );
    }
  }

  const fee = money(Math.max(0, finite(input.transferCost ?? 0) || 0));
  if (fee > 0 && transfer <= 0) {
    return fail('لا يمكن تسجيل عمولة تحويل بدون مبلغ محوّل');
  }
  const bearer: FeeBearer = input.transferCostBearer === 'party' ? 'party' : 'shop';

  // When the shop absorbs the fee, MORE leaves the machine than the party
  // receives. When the party absorbs it, the machine pays out the agreed
  // amount and the party simply gets less.
  const transferOutflow = bearer === 'shop' ? money(transfer + fee) : transfer;
  const transferReceived = bearer === 'shop' ? transfer : money(transfer - fee);

  if (transferReceived < 0) {
    return fail('عمولة التحويل أكبر من المبلغ المحوّل');
  }

  return {
    ok: true,
    accountCredit: account,
    cashRefund: cash,
    transferRefund: transfer,
    transferCost: fee,
    transferCostBearer: bearer,
    transferOutflow,
    transferReceived,
  };
}

/**
 * The settlement the app suggests when the screen first opens.
 *
 * Only a STARTING POINT — the user may change every figure. It reproduces the
 * behaviour most shops expect by default: cancel whatever the party still owes
 * on that invoice, and pay out the rest. A walk-in gets the whole value in
 * cash, because there is no account.
 */
export function suggestSettlement(
  total: number,
  outstanding: number,
  hasAccount: boolean,
): { accountCredit: number; cashRefund: number; transferRefund: number } {
  const t = money(total);
  if (!hasAccount) return { accountCredit: 0, cashRefund: t, transferRefund: 0 };
  const credit = money(Math.min(t, Math.max(0, outstanding)));
  return { accountCredit: credit, cashRefund: money(t - credit), transferRefund: 0 };
}
