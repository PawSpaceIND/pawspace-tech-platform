/**
 * One stored form for a customer's mobile number, and one way to recognise it however it was written.
 *
 * The same person reached PawSpace as several customers because their number was stored in several forms:
 * the web chat saved "+919876543210", the website form saved whatever the visitor typed ("+91 98765 43210",
 * "09876543210"), and customer OTP sign-in stored and looked up "9876543210" with an exact comparison. A chat
 * enquirer who then signed in was not found, got a second customer (CUS-OTP-...), and booked on it, so the
 * enquiry's lead could never convert, and their next enquiry matched two customers and went to identity review.
 *
 * Every intake now stores canonicalCustomerPhone(), the 10-digit Indian mobile, and every customer lookup by
 * phone uses samePhoneSql(), which treats the forms of one Indian number as that number, so rows already
 * stored in another form still resolve to the same customer.
 */
const digitsOnly = (value: unknown) => String(value ?? "").replace(/\D/g, "");

/** The 10-digit Indian mobile for +91 98765 43210, 919876543210, 09876543210 or 9876543210; null for anything else. */
export function canonicalCustomerPhone(value: unknown): string | null {
  const digits = digitsOnly(value);
  const national = digits.length === 12 && digits.startsWith("91") ? digits.slice(2)
    : digits.length === 11 && digits.startsWith("0") ? digits.slice(1)
    : digits.length === 13 && digits.startsWith("091") ? digits.slice(3)
    : digits.length === 14 && digits.startsWith("0091") ? digits.slice(4)
    : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

/** What an intake stores for a phone: the canonical mobile when it is one, otherwise the text as given. */
export function storedCustomerPhone(value: unknown): string {
  return canonicalCustomerPhone(value) ?? String(value ?? "").trim();
}

/** The column's value with the separators people type removed (+, spaces, dashes, brackets, dots). */
export function phoneDigitsSql(column: string) {
  return `replace(replace(replace(replace(replace(replace(COALESCE(${column},''),'+',''),' ',''),'-',''),'(',''),')',''),'.','')`;
}

/** The written forms of one 10-digit number, digits only: bind these to samePhoneSql(). */
export function samePhoneForms(tenDigits: string) {
  return [tenDigits, `91${tenDigits}`, `0${tenDigits}`, `091${tenDigits}`, `0091${tenDigits}`];
}

/** SQL predicate: the column holds this 10-digit number in any written form. Binds samePhoneForms(number). */
export function samePhoneSql(column: string) {
  return `${phoneDigitsSql(column)} IN (?,?,?,?,?)`;
}

/** The last 10 digits of a number with at least 10: the key sign-in and phone matching compare on. */
export function phoneMatchKey(value: unknown): string | null {
  const digits = digitsOnly(value);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** Whether two written numbers are the same number, by the same rule as samePhoneSql (+91 98765 43210 = 09876543210). */
export function sameCustomerPhone(a: unknown, b: unknown) {
  const key = phoneMatchKey(a);
  if (!key || phoneMatchKey(b) !== key) return false;
  const forms = samePhoneForms(key), typed = (value: unknown) => String(value ?? "").replace(/[+ \-().]/g, "");
  return forms.includes(typed(a)) && forms.includes(typed(b));
}
