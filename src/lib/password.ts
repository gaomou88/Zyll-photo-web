/**
 * 端到端加密密码的要求，和 App 的 PasswordPolicy 一致：至少 10 位，同时有字母和数字，不能是常见弱口令。
 * 只在设置新密码时检查。
 */
export const MIN_LENGTH = 10;

/** 不合格时返回原因（可直接给 t() 用的文字），合格返回 null。 */
export function passwordProblem(password: string): { key: string; vars?: Record<string, number> } | null {
  if ([...password].length < MIN_LENGTH) return { key: "密码至少要 {n} 位。", vars: { n: MIN_LENGTH } };
  if (!/\p{L}/u.test(password) || !/\p{Nd}/u.test(password)) return { key: "密码要同时包含字母和数字。" };
  if (isCommon(password)) return { key: "这个密码太常见、容易被猜到，请换一个。" };
  return null;
}

function isCommon(password: string): boolean {
  const p = password.toLowerCase();
  if (COMMON.has(p)) return true;
  if (new Set(p).size <= 2) return true;
  if (SEQUENCES.some((s) => p.length >= MIN_LENGTH && s.includes(p))) return true;
  const letters = [...p].filter((c) => /\p{L}/u.test(c)).join("");
  const digits = [...p].filter((c) => /\p{Nd}/u.test(c)).join("");
  const lettersThenDigits = p === letters + digits || p === digits + letters;
  return lettersThenDigits && WORDS.has(letters) && (isSimpleDigits(digits) || isYear(digits));
}

const isSimpleDigits = (d: string) =>
  new Set(d).size === 1 || "01234567890".includes(d) || "9876543210".includes(d) || COMMON_NUMBERS.has(d);

const isYear = (d: string) => d.length === 4 && /^\d{4}$/.test(d) && +d >= 1950 && +d <= 2100;

const SEQUENCES = ["1234567890qwertyuiop", "qwertyuiopasdfghjklzxcvbnm", "1qaz2wsx3edc4rfv5tgb", "zaq12wsxcde34rfv", "abcdefghijklmnopqrstuvwxyz0123456789", "q1w2e3r4t5y6u7i8o9p0", "1q2w3e4r5t6y7u8i9o0p", "a1b2c3d4e5f6g7h8"];

const COMMON_NUMBERS = new Set(["1314", "520", "5201314", "1314520", "147258369", "159357", "123123", "112233", "666", "888", "007"]);

const WORDS = new Set(["password", "passw", "pass", "passwd", "pwd", "qwerty", "qwer", "asdf", "zxcv", "qaz", "wsx", "qweasd", "asdfgh", "zxcvbn", "abc", "abcd", "abcde", "abcdef", "a", "aa", "aaa", "q", "qq", "qqq", "z", "x", "admin", "root", "user", "test", "guest", "login", "welcome", "iloveyou", "love", "letmein", "monkey", "dragon", "master", "football", "baseball", "sunshine", "princess", "shadow", "superman", "batman", "hello", "google", "apple", "android", "samsung", "huawei", "xiaomi", "zyll", "photo", "photos", "gallery", "woaini", "wang", "zhang", "li", "liu", "chen", "yang", "zhao", "huang", "zhou", "wu", "lin", "aini", "baobao", "laopo", "laogong"]);

const COMMON = new Set(["password1", "password12", "password123", "passw0rd", "p@ssw0rd", "passw0rd1", "qwerty123", "qwerty12", "qwerty1234", "1qaz2wsx", "1qazxsw2", "zaq12wsx", "1q2w3e4r", "1q2w3e4r5t", "q1w2e3r4", "q1w2e3r4t5", "qwer1234", "1234qwer", "asdf1234", "1234asdf", "zxcv1234", "abc12345", "abcd1234", "a1234567", "a12345678", "aa123456", "aa112233", "abc123456", "abc123abc", "12345678a", "123456789a", "123456abc", "123qweasd", "qweasd123", "qazwsx123", "asd123456", "zxc123456", "iloveyou1", "iloveyou2", "admin123", "admin1234", "welcome1", "welcome123", "letmein1", "monkey123", "dragon123", "football1", "baseball1", "trustno1", "sunshine1", "princess1", "master123", "superman1", "test1234", "root1234", "woaini1314", "woaini520", "5201314a", "a5201314", "qq123456", "qq5201314", "aa123123", "147258369a", "a147258369", "q123456789", "1a2b3c4d", "a1b2c3d4", "a1s2d3f4", "z1x2c3v4", "zyll1234", "zyll12345", "photo123", "android1", "google123", "samsung1", "huawei123", "xiaomi123", "change123", "changeme1", "default1"]);
