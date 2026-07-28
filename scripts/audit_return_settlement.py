#!/usr/bin/env python3
"""
Return settlement audit — how the value of a return is paid out.

The rule under test:

    TotalAmount = AccountCredit + CashRefund + TransferRefund

The split is CHOSEN by the user, not computed by a formula. The earlier version
always cancelled the outstanding debt and forced the rest out as cash, which
cannot express the situations a real shop meets:

  * a walk-in has no account, so must be paid out — possibly part cash, part
    wallet;
  * a registered customer who already paid may want the value left on account;
  * money may be settled partly now, partly later, or not at all;
  * a wallet refund carries a provider fee.

Usage:  python3 scripts/audit_return_settlement.py
"""
import os
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
R = lambda f: open(os.path.join(ROOT, f), encoding='utf-8').read()

PASSES, FINDINGS = [], []


def report(ok, name, detail=''):
    (PASSES if ok else FINDINGS).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if detail:
        for line in detail.strip().split('\n'):
            print(f"          {line}")


# The validator is TypeScript; exercise the real module through node.
HARNESS = r'''
import { validateSettlement, suggestSettlement, money } from './src/shared/returnSettlement.ts';
const out = [];
const t = (name, fn) => { try { out.push([name, fn()]); } catch (e) { out.push([name, 'THREW ' + e.message]); } };

// --- walk-in customer
t('walkin_all_cash', () => validateSettlement({ total: 1000, cashRefund: 1000, hasAccount: false, cashAccountId: 1 }).ok);
t('walkin_split_cash_transfer', () => validateSettlement({ total: 1000, cashRefund: 600, transferRefund: 400, hasAccount: false, cashAccountId: 1, paymentMethodId: 1 }).ok);
t('walkin_account_credit_rejected', () => validateSettlement({ total: 1000, accountCredit: 1000, hasAccount: false }).ok);
t('walkin_partial_rejected', () => validateSettlement({ total: 1000, cashRefund: 600, hasAccount: false, cashAccountId: 1 }).ok);

// --- registered customer
t('reg_all_on_account', () => validateSettlement({ total: 1000, accountCredit: 1000, hasAccount: true }).ok);
t('reg_offset_plus_cash', () => validateSettlement({ total: 1000, accountCredit: 600, cashRefund: 400, hasAccount: true, cashAccountId: 1 }).ok);
t('reg_all_three', () => validateSettlement({ total: 1000, accountCredit: 500, cashRefund: 300, transferRefund: 200, hasAccount: true, cashAccountId: 1, paymentMethodId: 1 }).ok);
t('reg_nothing_paid_now', () => validateSettlement({ total: 1000, accountCredit: 1000, hasAccount: true }).accountCredit);

// --- must balance
t('over_allocated_rejected', () => validateSettlement({ total: 1000, accountCredit: 700, cashRefund: 500, hasAccount: true, cashAccountId: 1 }).ok);
t('under_allocated_rejected', () => validateSettlement({ total: 1000, accountCredit: 300, hasAccount: true }).ok);
t('under_message', () => validateSettlement({ total: 1000, accountCredit: 300, hasAccount: true }).message);

// --- destinations required
t('cash_without_account_rejected', () => validateSettlement({ total: 100, cashRefund: 100, hasAccount: false }).ok);
t('transfer_without_method_rejected', () => validateSettlement({ total: 100, transferRefund: 100, hasAccount: false }).ok);

// --- transfer fee
t('fee_shop_outflow', () => validateSettlement({ total: 500, transferRefund: 500, hasAccount: false, paymentMethodId: 1, transferCost: 10, transferCostBearer: 'shop' }).transferOutflow);
t('fee_shop_received', () => validateSettlement({ total: 500, transferRefund: 500, hasAccount: false, paymentMethodId: 1, transferCost: 10, transferCostBearer: 'shop' }).transferReceived);
t('fee_party_outflow', () => validateSettlement({ total: 500, transferRefund: 500, hasAccount: false, paymentMethodId: 1, transferCost: 10, transferCostBearer: 'party' }).transferOutflow);
t('fee_party_received', () => validateSettlement({ total: 500, transferRefund: 500, hasAccount: false, paymentMethodId: 1, transferCost: 10, transferCostBearer: 'party' }).transferReceived);
t('fee_without_transfer_rejected', () => validateSettlement({ total: 500, cashRefund: 500, hasAccount: false, cashAccountId: 1, transferCost: 10 }).ok);
t('fee_exceeds_transfer_rejected', () => validateSettlement({ total: 100, transferRefund: 100, hasAccount: false, paymentMethodId: 1, transferCost: 150, transferCostBearer: 'party' }).ok);

// --- bad input
t('negative_rejected', () => validateSettlement({ total: 1000, accountCredit: -100, cashRefund: 1100, hasAccount: true, cashAccountId: 1 }).ok);
t('nan_rejected', () => validateSettlement({ total: 1000, cashRefund: NaN, hasAccount: false, cashAccountId: 1 }).ok);
t('zero_total_rejected', () => validateSettlement({ total: 0, hasAccount: true }).ok);

// --- rounding
t('thirds_balance', () => validateSettlement({ total: 100, accountCredit: 33.33, cashRefund: 33.33, transferRefund: 33.34, hasAccount: true, cashAccountId: 1, paymentMethodId: 1 }).ok);
t('money_rounds', () => money(0.1 + 0.2));

// --- suggestion
t('suggest_walkin', () => JSON.stringify(suggestSettlement(1000, 0, false)));
t('suggest_reg_partial', () => JSON.stringify(suggestSettlement(1000, 600, true)));
t('suggest_reg_paid', () => JSON.stringify(suggestSettlement(1000, 0, true)));

console.log(JSON.stringify(out));
'''

path = os.path.join(ROOT, '.settlement_probe.mts')
open(path, 'w', encoding='utf-8').write(HARNESS)
try:
    raw = subprocess.run(
        ['node', '--experimental-strip-types', path],
        cwd=ROOT, capture_output=True, text=True, timeout=120,
    )
finally:
    os.remove(path)

if raw.returncode != 0:
    print('harness failed:\n', raw.stderr[-2000:])
    sys.exit(1)

import json
res = dict(json.loads([l for l in raw.stdout.strip().split('\n') if l.startswith('[')][-1]))

print('=' * 74)
print('RETURN SETTLEMENT — HOW THE VALUE IS PAID OUT')
print('=' * 74)

# ---------------------------------------------------------------- 1
print('\n[1] Walk-in customer / cash purchase: no account to hold value')
report(res['walkin_all_cash'] is True,
       'the whole value may go out as cash')
report(res['walkin_split_cash_transfer'] is True,
       'it may be split between cash and a wallet transfer',
       '600 cash + 400 wallet = 1000')
report(res['walkin_account_credit_rejected'] is False,
       'leaving value "on account" is refused — there is no account',
       'this is the case the old formula got wrong in the other direction:\n'
       'it forced cash even when an account existed')
report(res['walkin_partial_rejected'] is False,
       'a partial settlement is refused for a walk-in',
       'they are leaving the shop; the value must be handed over in full')

# ---------------------------------------------------------------- 2
print('\n[2] Registered customer / supplier: every combination allowed')
report(res['reg_all_on_account'] is True,
       'the whole value may stay on the account',
       'the old logic FORCED cash out of the drawer when the invoice was\n'
       'already paid — the shop could not simply credit the customer')
report(res['reg_offset_plus_cash'] is True,
       'part against the debt, part in cash')
report(res['reg_all_three'] is True,
       'account + cash + transfer together',
       '500 + 300 + 200 = 1000')
report(res['reg_nothing_paid_now'] == 1000,
       'nothing need be paid today — it can all be carried on the account')

# ---------------------------------------------------------------- 3
print('\n[3] The split must always add up to the return value')
report(res['over_allocated_rejected'] is False,
       'allocating more than the value is refused')
report(res['under_allocated_rejected'] is False,
       'leaving part of the value unallocated is refused')
report('متبقٍ' in str(res['under_message']),
       'the message names the unallocated amount',
       str(res['under_message']))
report(res['thirds_balance'] is True,
       'amounts that do not divide evenly still balance',
       '33.33 + 33.33 + 33.34 = 100.00')
report(res['money_rounds'] == 0.3,
       'money() removes binary floating-point drift',
       '0.1 + 0.2 -> 0.3')

# ---------------------------------------------------------------- 4
print('\n[4] Money that moves needs a real destination')
report(res['cash_without_account_rejected'] is False,
       'a cash refund without a chosen drawer is refused')
report(res['transfer_without_method_rejected'] is False,
       'a transfer without a chosen wallet/machine is refused')

# ---------------------------------------------------------------- 5
print('\n[5] Transfer fees on a refund')
report(res['fee_shop_outflow'] == 510 and res['fee_shop_received'] == 500,
       'shop absorbs the fee: 510 leaves the wallet, the party receives 500',
       'the extra 10 is a real cost to the shop')
report(res['fee_party_outflow'] == 500 and res['fee_party_received'] == 490,
       'party absorbs the fee: 500 leaves the wallet, they receive 490')
report(res['fee_without_transfer_rejected'] is False,
       'a fee with no transfer leg is refused')
report(res['fee_exceeds_transfer_rejected'] is False,
       'a fee larger than the transfer is refused')

# ---------------------------------------------------------------- 6
print('\n[6] Malformed input cannot corrupt a balance')
report(res['negative_rejected'] is False, 'a negative component is refused')
report(res['nan_rejected'] is False,
       'NaN is refused',
       'SQLite stores NaN as NULL, so the row would vanish from every SUM()')
report(res['zero_total_rejected'] is False, 'a zero-value return is refused')

# ---------------------------------------------------------------- 7
print('\n[7] The suggested split is only a starting point')
report(json.loads(res['suggest_walkin'])['cashRefund'] == 1000,
       'a walk-in is offered the full amount in cash')
report(json.loads(res['suggest_reg_partial'])['accountCredit'] == 600
       and json.loads(res['suggest_reg_partial'])['cashRefund'] == 400,
       'a part-paid invoice is offered debt-first, then cash',
       'invoice 1000, outstanding 600 -> 600 on account, 400 cash')
report(json.loads(res['suggest_reg_paid'])['cashRefund'] == 1000,
       'a fully-paid invoice is offered as cash — but may be changed to credit')

# ---------------------------------------------------------------- 8
print('\n[8] Both handlers use the shared validator')
sal = R('src/main/ipc/sales.handlers.ts')
pur = R('src/main/ipc/purchases.handlers.ts')
for name, src in (('sale returns', sal), ('purchase returns', pur)):
    report('validateSettlement({' in src, f'{name} validate the settlement')
    report('suggestSettlement(' in src, f'{name} fall back to the suggestion when none is given')
report("hasAccount = !!originalSale.CustomerID" in sal,
       'a sale return knows whether the customer has an account')
report('hasAccount: true' in pur,
       'a purchase return always has a supplier account')
report('settlement.transferOutflow' in sal,
       'the sale refund removes the fee-inclusive amount from the wallet')
report('settlement.transferReceived' in pur,
       'the purchase refund adds the net amount actually received')
report('const invoiceOffset = money(Math.min(debtRelief, outstanding));' in sal
       and 'const invoiceOffset = money(Math.min(debtRelief, outstanding));' in pur,
       'only credit that offsets THIS invoice changes its outstanding amount',
       'credit beyond it is carried on the account, not written to the invoice')

# ---------------------------------------------------------------- 9
print('\n[9] Reversal undoes every leg')
undo_sale = sal.split("delete:saleReturn")[1]
undo_pur = pur.split("delete:purchaseReturn")[1]
report('Balance = Balance + ? WHERE CashAccountID' in undo_sale,
       'sale return: the cash comes back')
report('Balance = Balance + ? WHERE PaymentMethodID' in undo_sale,
       'sale return: the transfer comes back')
report('transferOutflow' in undo_sale,
       'sale return: the fee is returned with it, so the wallet nets to zero')
report('Balance = Balance - ? WHERE PaymentMethodID' in undo_pur,
       'purchase return: the received transfer goes back out')
report('restoredOnInvoice' in undo_sale,
       'only the invoice-offsetting portion is restored to the invoice')

print('\n' + '=' * 74)
print(f'RESULT: {len(PASSES)} passed, {len(FINDINGS)} findings')
print('=' * 74)
for f in FINDINGS:
    print('  FINDING:', f)
sys.exit(1 if FINDINGS else 0)
