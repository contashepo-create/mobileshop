# إعداد الخادم وبوت تليجرام

دليل عملي خطوة بخطوة. الوقت المتوقع: ~20 دقيقة.

---

## لماذا Cloudflare؟

| المنصة | التوقف التلقائي |
|---|---|
| **Cloudflare Workers** | ❌ لا يتوقف أبداً |
| Supabase مجاني | ⚠️ يتوقف بعد 7 أيام خمول |
| Render مجاني | ⚠️ يتوقف بعد 15 دقيقة خمول |

خدمة التفعيل تُستدعى **بشكل متقطع** — قد تمر أيام بلا طلب. هذا أسوأ نمط لـ
Supabase وRender: عميل يحتاج تفعيلاً عاجلاً والخادم نائم.

**استهلاكك المتوقع:** 100 عميل × نبضة يومية = 100 طلب/يوم من أصل 100,000 مجاناً
= **0.1%**. لن تدفع شيئاً.

D1 هو SQLite — نفس محرك برنامجك.

---

## الخطوة 1: إنشاء قاعدة البيانات

```bash
cd server
npm install -g wrangler
wrangler login
wrangler d1 create mobileshop
```

انسخ `database_id` من المخرجات وضعه في `wrangler.toml`.

## الخطوة 2: المفاتيح السرية

```bash
# مفتاح إدارتك — لك وحدك (لا يُشحن للعملاء)
wrangler secret put ADMIN_KEY

# مفتاح التطبيقات — يُشحن مع البرنامج
wrangler secret put CLIENT_KEY

# نفس قيمة VERIFIER_SECRET في licenseCrypto.ts — مهم جداً
wrangler secret put LICENSE_SECRET
```

**لتوليد مفاتيح قوية:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> ⚠️ `LICENSE_SECRET` يجب أن يطابق `VERIFIER_SECRET` في التطبيق **حرفياً**،
> وإلا فالأكواد المولَّدة من البوت لن يقبلها التطبيق.

## الخطوة 3: بوت تليجرام

1. افتح [@BotFather](https://t.me/BotFather) → `/newbot`
2. احفظ الـ token
3. أرسل رسالة لبوتك، ثم افتح:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   وانسخ `chat.id` (رقمك)

```bash
wrangler secret put TG_BOT_TOKEN
wrangler secret put TG_ADMIN_CHAT
```

4. ولّد كلمة سر للـ webhook واحفظها:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
wrangler secret put TG_WEBHOOK_SECRET
```

> ### ⚠️ لماذا `TG_WEBHOOK_SECRET` إلزامي وليس اختيارياً
>
> مسار `/telegram` لا يمكن حمايته بـ `ADMIN_KEY`، لأن تليجرام لا يرسل
> ترويسة من اختيارنا. كان دفاعه الوحيد هو رقم المحادثة **داخل جسم الطلب** —
> والجسم يكتبه من يرسل الطلب.
>
> **قياس فعلي** على الخادم الحقيقي، بلا أي بيانات اعتماد، من مُرسِل مجهول
> لا يعرف سوى الرابط العام:
>
> ```
> POST /telegram
> {"message":{"chat":{"id":7232305465},"text":"/new deadbeefdeadbeef 3650"}}
>
> ← 200 {"ok":true}
> ← البوت أرسل: «كود التفعيل الخاص بك: 2YN0-0001-CMKM-MVE8-...»
> ```
>
> ترخيص موقَّع صالح **عشر سنوات**، أنشأه مهاجم. رقم المحادثة ليس سراً —
> وهو أصلاً رقم من عشر خانات.
>
> الحل هو آلية تليجرام نفسها: `secret_token` يُسجَّل مع `setWebhook`،
> فيعيده تليجرام في ترويسة `X-Telegram-Bot-Api-Secret-Token` مع كل تسليم.
> الطلب المزوَّر لا يستطيع حملها.
>
> **الخادم يرفض كل شيء إن لم تُضبط هذه الكلمة** (fail closed): بوت صامت
> عطلٌ يبلّغ عنه المالك، أما بوت يصنع تراخيص للغرباء فلا ينتبه له أحد.

## الخطوة 4: النشر

```bash
wrangler deploy
```

اربط البوت بالخادم (مرة واحدة) — **مع كلمة السر**:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -H "content-type: application/json" \
     -d '{"url":"https://mobileshop-licensing.<اسمك>.workers.dev/telegram","secret_token":"<TG_WEBHOOK_SECRET>"}'
```

> الرابط القديم `setWebhook?url=...` بدون `secret_token` يترك الثغرة
> مفتوحة: تليجرام لن يرسل الترويسة، فسيرفض الخادم كل تسليم ويتوقف البوت.
> استخدم الأمر أعلاه بالضبط.

## الخطوة 5: ربط التطبيق

في بيئة البناء:

```bash
MOBILESHOP_API_BASE=https://mobileshop-licensing.<اسمك>.workers.dev
MOBILESHOP_CLIENT_KEY=<نفس CLIENT_KEY>
```

**بدونهما الميزة معطّلة تماماً** والتطبيق يعمل بشكل طبيعي — مفيد للاختبار.

---

## أوامر البوت

| الأمر | الوظيفة |
|---|---|
| `/new <device_id> <days>` | إنشاء كود (0 = غير محدود) |
| `/devices` | آخر 15 جهازاً |
| `/expiring` | اشتراكات تنتهي خلال 14 يوماً |
| `/msg <id\|all> <نص>` | رسالة لعميل أو للجميع |
| `/set <id\|all> <key> <value>` | تعديل إعداد عن بُعد |
| `/help` | القائمة |

**تنبيهات تلقائية تصلك:**
- 🆕 جهاز جديد ثبّت التطبيق
- ⏰ اشتراكات تنتهي خلال أسبوع (يومياً 9 صباحاً UTC)

---

## أمثلة عملية

```
# تفعيل سنة
/new a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 365

# تغيير رقم الدعم لكل العملاء
/set all dev_phone 01012345678

# رسالة لعميل واحد
/msg a1b2c3d4… تم تجديد اشتراكك حتى 2027

# إعلان للجميع
/msg all صيانة مجدولة الجمعة القادمة

# معلومات دفع
/set all payment_info فودافون كاش: 01012345678
```

---

## منع تصادم الأرقام التسلسلية

النظام يقسّم مساحة الأرقام تلقائياً:

| المصدر | النطاق |
|---|---|
| البوت / الخادم | `1 … 8,388,607` |
| الأداة المحلية | `8,388,608 … 16,777,215` |

بدون هذا التقسيم، التوليد من المكانين في نفس اليوم يُنتج نفس الرقم لعميلين
مختلفين — فتفقد القدرة على تتبّع أي كود ذهب لمن.

---

## ما يستطيع `/set` تغييره

الخادم يقترح، **والتطبيق يقرر**. قائمة المفاتيح المسموحة داخل التطبيق
(`src/main/remote/remoteConfig.ts`) لا على الخادم.

**مسموح:** `app_name`, `dev_name`, `dev_phone`, `dev_whatsapp`, `dev_telegram`,
`dev_email`, `dev_website`, `dev_facebook`, `dev_address`, `payment_info`,
`subscription_note`, `support_hours`, `copyright`, `distribution_rights`,
`terms_note`, `custom_content`, `custom_block_title`, `custom_block_body`,
`release_notes`, `latest_version`, `app_edition`, `dev_title`

**مرفوض دائماً:** أي إعداد محاسبي، بيانات المحل، مسار قاعدة البيانات.

لو أرسلت مفتاحاً ممنوعاً، التطبيق **يتجاهله بصمت**. هذا مقصود: حتى لو اختُرق
حسابك، لا يستطيع المهاجم تغيير سلوك محاسبي.

---

## الأمان

| الإجراء | الحماية |
|---|---|
| مفتاحان منفصلان | استخراج `CLIENT_KEY` من التطبيق **لا** يسمح بإصدار أكواد |
| البوت لك وحدك | يتحقق من `chat_id` — غيرك يُتجاهل |
| مقارنة آمنة | `safeEqual` يمنع استنتاج المفتاح تدريجياً |
| لا أسرار في git | كلها عبر `wrangler secret` |

---

## التكلفة

| الخدمة | الحد المجاني | استهلاكك بـ 100 عميل |
|---|---|---|
| Workers | 100,000 طلب/يوم | ~100 (0.1%) |
| D1 | 5 GB | بضعة ميجابايت |
| Cron | 5 مهام | 1 |

**المجموع: 0 جنيه.**

---

## استكشاف الأخطاء

| المشكلة | الحل |
|---|---|
| «الكود غير صحيح» عند العميل | `LICENSE_SECRET` لا يطابق `VERIFIER_SECRET` |
| البوت لا يرد | تحقق من الـ webhook و`TG_ADMIN_CHAT` |
| لا تصل نبضات | تأكد من متغيري البيئة عند البناء |
| `/set` لا يظهر أثره | المفتاح خارج القائمة المسموحة، أو انتظر المزامنة التالية |

**فحص سريع:**
```bash
curl https://mobileshop-licensing.<اسمك>.workers.dev/health
# {"ok":true}
```
