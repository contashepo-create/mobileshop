/**
 * Stand-in for `bcryptjs`.
 *
 * The real library is a native-free but deliberately SLOW hash — that slowness
 * is its whole security value, and it makes a suite that creates users
 * unusably slow. These tests are about authorisation logic (can the last
 * administrator be locked out? is a duplicate username refused?), not about
 * the strength of the hash, which is covered separately by the security audit.
 *
 * The shape is kept identical so the handlers cannot tell the difference.
 */
const tag = (s, salt) => `bcrypt$${salt ?? 10}$${Buffer.from(String(s)).toString('base64')}`;

export function hashSync(plain, saltRounds = 10) {
  return tag(plain, saltRounds);
}
export function compareSync(plain, hash) {
  if (typeof hash !== 'string') return false;
  const parts = hash.split('$');
  return parts.length === 3 && parts[2] === Buffer.from(String(plain)).toString('base64');
}
export function genSaltSync(rounds = 10) { return String(rounds); }

export default { hashSync, compareSync, genSaltSync };
