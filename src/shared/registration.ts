/**
 * Validation for the details a shop enters on first run.
 *
 * WHY THIS IS SHARED
 * ------------------
 * The wizard should tell the owner about a bad email while they are typing;
 * the main process must REFUSE it regardless of what the wizard did. Two
 * copies of the rules would drift, and the one that mattered — the handler —
 * would be the one nobody updated. So the rules live here and both sides call
 * them.
 *
 * WHAT THIS CAN AND CANNOT DO
 * ---------------------------
 * It rejects the shapes that are obviously not real: a one-letter name, a
 * phone that is not an Egyptian mobile, a disposable inbox. It cannot tell
 * whether a genuine-looking name belongs to the person typing it. Claiming
 * otherwise would be dishonest; the only real proof of a phone number is a
 * code sent to it, which is a separate feature.
 *
 * The point is proportionate friction: someone determined to lie still can,
 * but nobody fills the form with "a", "1", "a@a.a" by accident and gets away
 * with it.
 */

/** Providers that exist to be thrown away. Kept short and obvious on purpose. */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com',
  'trashmail.com', 'sharklasers.com', 'getnada.com', 'maildrop.cc',
  'fakeinbox.com', 'dispostable.com', 'mintemail.com', 'mohmal.com',
  'tempail.com', 'emailondeck.com', 'spamgourmet.com', 'mytemp.email',
  'temp-mail.io', 'moakt.com', 'tmpmail.org', 'burnermail.io',
]);

/** The 27 Egyptian governorates, so a free-text field cannot hold nonsense. */
export const EGYPT_GOVERNORATES = [
  'القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية', 'الشرقية', 'الدقهلية',
  'البحيرة', 'المنوفية', 'الغربية', 'كفر الشيخ', 'دمياط', 'بورسعيد',
  'الإسماعيلية', 'السويس', 'شمال سيناء', 'جنوب سيناء', 'بني سويف',
  'الفيوم', 'المنيا', 'أسيوط', 'سوهاج', 'قنا', 'الأقصر', 'أسوان',
  'البحر الأحمر', 'الوادي الجديد', 'مطروح',
] as const;

export interface FieldError {
  field: string;
  message: string;
}

/** Egyptian mobile: 01 followed by 0, 1, 2 or 5, then eight digits. */
export function isValidEgyptianMobile(value: unknown): boolean {
  const digits = String(value ?? '').replace(/\D/g, '');
  const local = digits.startsWith('20') ? `0${digits.slice(2)}` : digits;
  return /^01[0125]\d{8}$/.test(local);
}

/**
 * A real-looking address, not a keyboard mash.
 *
 * Deliberately loose: addresses vary enormously and rejecting an unusual but
 * genuine one is worse than accepting a lazy one.
 */
export function isValidEmail(value: unknown): boolean {
  const email = String(value ?? '').trim().toLowerCase();
  // One @, something either side, a dot in the domain, no spaces.
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return false;
  const domain = email.split('@')[1];
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return false;
  // "a@a.aa" passes the pattern but is not a real inbox.
  if (email.split('@')[0].length < 2) return false;
  return true;
}

export function isDisposableEmail(value: unknown): boolean {
  const domain = String(value ?? '').trim().toLowerCase().split('@')[1] || '';
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/** A person or shop name: at least two characters, and not just digits. */
export function isValidName(value: unknown, min = 3): boolean {
  const name = String(value ?? '').trim();
  if (name.length < min) return false;
  if (/^\d+$/.test(name)) return false;
  // A single repeated character ("aaaa", "1111") is not a name.
  if (new Set(name.replace(/\s/g, '')).size < 2) return false;
  return true;
}

/** Date of birth: a real date, and an adult who is not implausibly old. */
export function isValidBirthDate(value: unknown, now: Date = new Date()): boolean {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const age = (now.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  return age >= 16 && age <= 100;
}

export function isValidGovernorate(value: unknown): boolean {
  return (EGYPT_GOVERNORATES as readonly string[]).includes(String(value ?? '').trim());
}

export interface RegistrationInput {
  companyName?: unknown;
  ownerName?: unknown;
  phone?: unknown;
  email?: unknown;
  governorate?: unknown;
  city?: unknown;
  address?: unknown;
  birthDate?: unknown;
}

/**
 * Validates the whole form and returns EVERY problem at once.
 *
 * Returning all of them matters: a wizard that reveals one error per attempt
 * makes the owner submit five times and teaches them to resent the form.
 */
export function validateRegistration(input: RegistrationInput): FieldError[] {
  const errors: FieldError[] = [];

  if (!isValidName(input.companyName)) {
    errors.push({ field: 'companyName', message: 'اسم المحل مطلوب (٣ أحرف على الأقل)' });
  }
  if (!isValidName(input.ownerName)) {
    errors.push({ field: 'ownerName', message: 'اسم صاحب المحل مطلوب (٣ أحرف على الأقل)' });
  }
  if (!isValidEgyptianMobile(input.phone)) {
    errors.push({ field: 'phone', message: 'رقم هاتف مصري غير صحيح - مثال: 01012345678' });
  }
  if (!isValidEmail(input.email)) {
    errors.push({
      field: 'email',
      message: isDisposableEmail(input.email)
        ? 'البريد المؤقت غير مقبول - استخدم بريداً حقيقياً'
        : 'بريد إلكتروني غير صحيح',
    });
  }
  if (!isValidGovernorate(input.governorate)) {
    errors.push({ field: 'governorate', message: 'اختر المحافظة من القائمة' });
  }
  if (!isValidName(input.city, 2)) {
    errors.push({ field: 'city', message: 'اسم المدينة مطلوب' });
  }
  if (!isValidName(input.address, 5)) {
    errors.push({ field: 'address', message: 'العنوان مطلوب (٥ أحرف على الأقل)' });
  }
  if (!isValidBirthDate(input.birthDate)) {
    errors.push({ field: 'birthDate', message: 'تاريخ ميلاد غير صحيح (العمر بين ١٦ و ١٠٠)' });
  }

  return errors;
}
