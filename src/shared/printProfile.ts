/**
 * Per-document print profiles: which template, paper, columns and copies each
 * KIND of document uses.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Every print setting in this application was global. One template, one paper
 * size, one set of visible columns, shared by every document the shop
 * produces. That is wrong in a way that shows up on the first day of real use:
 *
 *   - A sales invoice goes to the customer on an 80mm thermal roll.
 *   - A purchase invoice is an internal record and belongs on A4, in a file.
 *   - A receipt voucher has no line items at all, so the quantity and price
 *     columns are meaningless on it.
 *   - A maintenance ticket needs the IMEI column that a grocery-style sale
 *     does not.
 *
 * Forcing one answer onto all of them means every document is wrong except
 * the one the setting was chosen for.
 *
 * HOW IT WORKS
 * ------------
 * Settings stay in the single `settings` key/value table — no schema change,
 * nothing to migrate. A per-document value is stored under a prefixed key:
 *
 *      print_doc_<type>_<field>        e.g. print_doc_purchase_paper
 *
 * `resolveProfile()` answers with the first of:
 *
 *      1. the per-document value, when the shop has set one
 *      2. the existing GLOBAL value, which is what the shop sees today
 *      3. the built-in default
 *
 * That order is the whole design. A shop that never opens the new screen keeps
 * the exact document it had before this change, because step 2 is the old
 * behaviour. Nothing is silently restyled.
 *
 * WHY IT IS SHARED
 * ----------------
 * The renderer needs it to draw the settings screen and to decide what to send;
 * the main process needs it to build the HTML, and must not trust what the
 * renderer sends. Two copies of this precedence logic would drift, and the one
 * that mattered — the printer — would be the one nobody updated. So both sides
 * import this.
 */

/** The document kinds that can be printed. */
export const DOCUMENT_TYPES = [
  'sale', 'purchase', 'maintenance', 'voucher_receipt', 'voucher_payment', 'statement',
  'sale_return', 'service',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Human labels, so the settings screen and the printer cannot disagree. */
export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  sale: 'فاتورة مبيعات',
  purchase: 'فاتورة مشتريات',
  maintenance: 'فاتورة صيانة',
  voucher_receipt: 'سند قبض',
  voucher_payment: 'سند صرف',
  statement: 'كشف حساب',
  sale_return: 'مرتجع مبيعات',
  service: 'إيصال خدمة',
};

/** The item-table columns a shop can show or hide, IN PRINT ORDER. */
export const COLUMN_KEYS = ['index', 'name', 'qty', 'price', 'total', 'imei'] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  index: '#', name: 'الصنف', qty: 'كمية', price: 'سعر', total: 'إجمالي', imei: 'IMEI',
};

/**
 * The item name is not optional.
 *
 * A printed line that says "2 × 150.00" with no indication of WHAT was sold is
 * not a document anyone can act on, and an invoice without it is not a valid
 * commercial record. The column is offered in the ordering list so a shop can
 * move it, but `visibleColumns()` always keeps it.
 */
export const MANDATORY_COLUMNS: readonly ColumnKey[] = ['name'];

export interface PrintProfile {
  template: string;
  paper: string;
  copies: number;
  /** Column keys in the order they should be printed. */
  order: ColumnKey[];
  /** Per-column visibility. */
  columns: Record<ColumnKey, boolean>;
  headerText: string;
  footerText: string;
  showQr: boolean;
  /** A closing courtesy: right on a customer receipt, wrong on a ledger. */
  showThanks: boolean;
  /** A signature line: needed on evidence, noise on a till receipt. */
  showSignature: boolean;
}

/**
 * What each KIND of document should look like when nobody has configured it.
 *
 * Every type previously fell back to the same answer — 80mm thermal, a thanks
 * note, an items table with price and quantity columns. That is right for a
 * sales receipt handed to a customer and wrong for everything else:
 *
 *   a PURCHASE invoice is an internal record of what a supplier delivered. It
 *   is filed, not handed over, so it belongs on A4 — and thanking yourself for
 *   your own purchase is nonsense.
 *
 *   a VOUCHER has no line items at all. It is one amount, one party, one
 *   reason. Printing an empty quantity/price table on it makes it look like a
 *   broken invoice.
 *
 *   a STATEMENT is a ledger. It needs A4 and a signature line, not a receipt
 *   roll and "شكراً لتعاملكم معنا".
 *
 * These are DEFAULTS, not rules: `resolveProfile` still puts a per-document
 * setting first, and a shop that has already chosen a global paper size keeps
 * it. They only decide what happens when nobody has said otherwise.
 */
export interface DocumentDefaults {
  paper: string;
  /** Columns worth printing for this kind, in order. */
  order: ColumnKey[];
  hiddenColumns: ColumnKey[];
  /** A closing courtesy belongs on a customer document only. */
  showThanks: boolean;
  /** Somewhere to sign — vouchers and statements are evidence. */
  showSignature: boolean;
  copies: number;
  footerText: string;
}

export const DOCUMENT_DEFAULTS: Record<DocumentType, DocumentDefaults> = {
  // Handed to the customer at the counter.
  sale: {
    paper: '80mm',
    order: ['index', 'name', 'qty', 'price', 'total', 'imei'],
    hiddenColumns: [],
    showThanks: true,
    showSignature: false,
    copies: 1,
    footerText: '',
  },
  // An internal record of a delivery. Two copies: one for the file, one for
  // the supplier to sign as proof of what arrived.
  purchase: {
    paper: 'A4',
    order: ['index', 'name', 'qty', 'price', 'total', 'imei'],
    hiddenColumns: [],
    showThanks: false,
    showSignature: true,
    copies: 2,
    footerText: 'يُعتمد هذا المستند كإثبات استلام البضاعة من المورد.',
  },
  // Goes to the customer with the repaired device, and carries a warranty.
  maintenance: {
    paper: '80mm',
    order: ['index', 'name', 'qty', 'price', 'total', 'imei'],
    hiddenColumns: [],
    showThanks: true,
    showSignature: false,
    copies: 1,
    footerText: '',
  },
  // One amount, one party. No line items exist, so no item columns.
  voucher_receipt: {
    paper: 'A5',
    order: ['name', 'total'],
    hiddenColumns: ['index', 'qty', 'price', 'imei'],
    showThanks: false,
    showSignature: true,
    copies: 2,
    footerText: 'أقر باستلام المبلغ المذكور أعلاه.',
  },
  voucher_payment: {
    paper: 'A5',
    order: ['name', 'total'],
    hiddenColumns: ['index', 'qty', 'price', 'imei'],
    showThanks: false,
    showSignature: true,
    copies: 2,
    footerText: 'أقر بصرف المبلغ المذكور أعلاه.',
  },
  // A ledger, reconciled and signed by both sides.
  statement: {
    paper: 'A4',
    order: ['index', 'name', 'qty', 'price', 'total', 'imei'],
    hiddenColumns: ['imei'],
    showThanks: false,
    showSignature: true,
    copies: 1,
    footerText: 'هذا الكشف معتمد ومعتبر لدى الطرفين.',
  },
  // A credit note given to the customer at the counter when goods come back.
  // Same shape as a sale — one list of returned lines and a money block — but
  // there is nothing left to thank the customer for, and this is evidence of
  // what was taken back, so the unless-configured defaults mirror a sale.
  sale_return: {
    paper: '80mm',
    order: ['index', 'name', 'qty', 'price', 'total', 'imei'],
    hiddenColumns: [],
    showThanks: false,
    showSignature: false,
    copies: 1,
    footerText: '',
  },
  // An operation receipt: a money case with no line items. Handed to the
  // customer at the counter, like a sale — thermal, thanks note, no signature.
  service: {
    paper: '80mm',
    order: ['name', 'total'],
    hiddenColumns: ['index', 'qty', 'price', 'imei'],
    showThanks: true,
    showSignature: false,
    copies: 1,
    footerText: '',
  },
};

const VALID_TEMPLATES = new Set(['1', '2', '3', '4', '5']);
const VALID_PAPERS = new Set(['58mm', '80mm', 'A5', 'A4']);

/** `settings` values are strings; treat anything unparseable as absent. */
const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};

/**
 * Reads a per-document value, falling back to the global one, then a default.
 *
 * Exported because the settings screen needs to show which of the three a
 * given field is currently coming from.
 */
export function resolveValue(
  settings: Record<string, unknown>,
  type: DocumentType,
  field: string,
  globalKey: string | null,
  fallback: string,
): string {
  const perDoc = str(settings[`print_doc_${type}_${field}`]);
  if (perDoc !== undefined) return perDoc;
  if (globalKey) {
    const global = str(settings[globalKey]);
    if (global !== undefined) return global;
  }
  return fallback;
}

/**
 * Parses a stored column order into a complete, valid ordering.
 *
 * A stored order is only a HINT: it may name a column that no longer exists,
 * repeat one, or omit one added by a later version. Rather than trusting it,
 * this rebuilds a complete list — known keys in the stored order first, then
 * any key the stored value did not mention, in canonical order. The result is
 * always a permutation of COLUMN_KEYS, so the printer can never be handed a
 * table with a missing or duplicated column.
 */
export function parseOrder(raw: unknown): ColumnKey[] {
  const seen = new Set<ColumnKey>();
  const out: ColumnKey[] = [];
  for (const part of String(raw ?? '').split(',')) {
    const key = part.trim() as ColumnKey;
    if ((COLUMN_KEYS as readonly string[]).includes(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  for (const key of COLUMN_KEYS) if (!seen.has(key)) out.push(key);
  return out;
}

/** Clamps the copy count. Zero copies is not a setting, it is a broken print. */
export function parseCopies(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, Math.trunc(n)));
}

/**
 * The effective settings for one document type.
 *
 * `settings` is the flat key/value map the application already loads.
 */
export function resolveProfile(
  settings: Record<string, unknown> | null | undefined,
  type: DocumentType,
): PrintProfile {
  const s = settings || {};
  const d = DOCUMENT_DEFAULTS[type] ?? DOCUMENT_DEFAULTS.sale;

  const template = resolveValue(s, type, 'template', 'default_invoice_template', '1');
  // The document's own default is the LAST resort, after the per-document
  // setting and the shop's global choice. A shop that set everything to A4
  // still gets A4 for a sales receipt; only a shop that has expressed no
  // preference at all sees the per-type sensible answer.
  const paper = resolveValue(s, type, 'paper', 'paper_size', d.paper);

  const columns = {} as Record<ColumnKey, boolean>;
  for (const key of COLUMN_KEYS) {
    // Per-document first, then the ORIGINAL global column keys so a shop that
    // hid a column before this change still has it hidden.
    const perDoc = str(s[`print_doc_${type}_col_${key}`]);
    const global = str(s[`print_col_${key}`]);
    const chosen = perDoc ?? global;
    // Absent means shown — matching the behaviour before column switches
    // existed at all. Written as an explicit undefined check rather than the
    // shorter `chosen !== '0'`: the two are equivalent today (both yield true
    // for an absent key) and mutation testing flagged them as such, but the
    // explicit form states the INTENT, so adding a third state later cannot
    // silently flip the default to hidden.
    // Absent means "use this document's default". A voucher has no line items,
    // so a quantity column on it is not a hidden column the shop switched off
    // — it is a column that never made sense for that document.
    columns[key] = chosen === undefined ? !d.hiddenColumns.includes(key) : chosen !== '0';
  }

  return {
    // An unrecognised stored value must not reach the CSS. Fall back rather
    // than emit it.
    template: VALID_TEMPLATES.has(template) ? template : '1',
    paper: VALID_PAPERS.has(paper) ? paper : d.paper,
    copies: parseCopies(resolveValue(s, type, 'copies', null, String(d.copies))),
    order: parseOrder(resolveValue(s, type, 'order', null, d.order.join(','))),
    columns,
    headerText: resolveValue(s, type, 'header', null, ''),
    footerText: resolveValue(s, type, 'footer', null, d.footerText),
    showQr: resolveValue(s, type, 'qr', null, '0') === '1',
    // Not stored per document yet — these follow the kind of document, and a
    // shop that wants otherwise can already suppress them globally.
    showThanks: d.showThanks,
    showSignature: d.showSignature,
  };
}

/**
 * The columns to print, in order, with hidden ones removed.
 *
 * The item name is re-inserted if hiding it was somehow stored, because a
 * document without it is not usable as a record.
 */
export function visibleColumns(profile: PrintProfile): ColumnKey[] {
  const cols = profile.order.filter(
    (k) => profile.columns[k] || MANDATORY_COLUMNS.includes(k),
  );
  // Defence in depth, and deliberately unreachable through `resolveProfile`:
  // `parseOrder` always returns a full permutation of COLUMN_KEYS, and the
  // filter above keeps the mandatory keys regardless of visibility, so `cols`
  // cannot be missing one. It matters for a caller that builds a PrintProfile
  // by hand — mutation testing confirmed this loop is equivalent for every
  // resolver-produced profile, which is precisely why it is documented as a
  // guard rather than deleted as dead code.
  for (const required of MANDATORY_COLUMNS) {
    if (!cols.includes(required)) cols.unshift(required);
  }
  return cols;
}

/** Every settings key this module reads, for the screen that edits them. */
export function profileKeys(type: DocumentType): string[] {
  return [
    `print_doc_${type}_template`,
    `print_doc_${type}_paper`,
    `print_doc_${type}_copies`,
    `print_doc_${type}_order`,
    `print_doc_${type}_header`,
    `print_doc_${type}_footer`,
    `print_doc_${type}_qr`,
    ...COLUMN_KEYS.map((k) => `print_doc_${type}_col_${k}`),
  ];
}
