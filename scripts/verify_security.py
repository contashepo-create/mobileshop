#!/usr/bin/env python3
"""
Static security checks over the source tree.

Guards against regressions of the vulnerabilities fixed in this change set.
Run with:  python3 scripts/verify_security.py
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PASS, FAIL = [], []


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def strip_comments(s):
    """Removes // line comments and /* */ blocks so checks match real code,
    not the explanatory comments that intentionally name the old bad pattern."""
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    s = re.sub(r'^\s*//.*$', '', s, flags=re.M)
    s = re.sub(r'(?<![:"\'`])//[^\n"\'`]*$', '', s, flags=re.M)
    return s


def code(rel):
    return strip_comments(read(rel))


def walk(subdir, exts=('.ts', '.tsx')):
    base = os.path.join(ROOT, subdir)
    for dirpath, _dirs, files in os.walk(base):
        for fn in files:
            if fn.endswith(exts):
                p = os.path.join(dirpath, fn)
                yield os.path.relpath(p, ROOT), open(p, encoding='utf-8').read()


def check(name, ok, detail=''):
    if ok:
        PASS.append(name); print(f"  PASS  {name}")
    else:
        FAIL.append(name); print(f"  FAIL  {name}  {detail}")


print("=" * 68)
print("SECURITY REGRESSION CHECKS — Mobile Shop ERP")
print("=" * 68)

# 1 — no plaintext dev password anywhere in shipped source
print("\n[1] Developer password is not hardcoded")
offenders = [p for p, s in walk('src') if re.search(r"['\"]014253['\"]", strip_comments(s))]
check("no literal '014253' in src/", not offenders, f"found in {offenders}")

# 2 — dev auth is verified in the main process only
print("\n[2] Developer auth happens in the main process")
dev = read('src/main/security/devAuth.ts')
check("uses bcrypt", 'bcrypt.compareSync' in dev)
check("stores only a hash", 'DEV_PASSWORD_HASH' in dev and strip_comments(dev).count("'014253'") == 0)
check("rate limits attempts", 'MAX_ATTEMPTS' in dev and 'lockedUntil' in dev)
check("issues expiring tokens", 'TOKEN_TTL_MS' in dev and 'randomBytes' in dev)
console = read('src/renderer/src/pages/dev/DevConsolePage.tsx')
check("renderer no longer compares credentials", 'atob(' not in console and 'ENCRYPTED_DEV' not in console)
check("renderer no longer self-unlocks via sessionStorage", "sessionStorage.setItem('dev_unlocked'" not in console)
check("renderer calls dev:login", "invoke('dev:login'" in console)

# 3 — every privileged license channel requires a token
print("\n[3] License channels require a dev token")
lic = read('src/main/ipc/license.handlers.ts')
check("no plaintext password comparison", "devPassword !== '014253'" not in lic)
# Every privileged license channel must gate on a dev token. Asserting the
# BEHAVIOUR rather than a fixed count, so removing a channel does not produce a
# false failure while adding an unguarded one still does.
lic_code = code('src/main/ipc/license.handlers.ts')
privileged = re.findall(r"ipcMain\.handle\(\s*'(license:(?:generateCode|deactivate))'(.*?)(?=ipcMain\.handle\(|\Z)",
                        lic_code, re.S)
check("every privileged license channel verifies a dev token",
      bool(privileged) and all('verifyDevToken(' in body for _, body in privileged),
      f"channels={[n for n, _ in privileged]}")
check("no license channel still compares a plaintext password",
      "devPassword" not in lic_code)

# 4 — IPC guard exists and is installed before handlers
print("\n[4] IPC authorisation layer")
guard = read('src/main/security/ipcGuard.ts')
idx = read('src/main/index.ts')
check("guard module present", 'installIpcGuard' in guard)
check("denies unmapped channels by default", 'has no permission mapping' in guard)
check("guard installed in index.ts", 'installIpcGuard();' in idx)
check("installed before handler registration",
      idx.index('installIpcGuard();') < idx.index('registerAuthHandlers();'))
check("overrides caller-supplied userId", "'userId' in arg" in guard)
check("session lookup is per-webContents", 'event.sender.id' in guard)

# 5 — no hardcoded userId in the renderer
print("\n[5] Audit trail: no hardcoded user id")
bad = [p for p, s in walk('src/renderer') if re.search(r'userId:\s*1\b', s)]
check("no `userId: 1` in renderer", not bad, f"found in {bad}")

# 6 — SQL injection: no interpolated date filters
print("\n[6] No SQL string interpolation of user input")
for rel in ('src/main/ipc/statement.handlers.ts', 'src/main/ipc/reports.handlers.ts'):
    s = code(rel)
    check(f"{os.path.basename(rel)}: no quoted interpolation",
          not re.search(r">=\s*'\$\{", s) and not re.search(r"<=\s*'\$\{", s))
    check(f"{os.path.basename(rel)}: no fragile Date string-replace",
          ".replace('Date'" not in s and ".replace(/Date/g" not in s)

# 7 — CSV export is whitelisted
print("\n[7] CSV export cannot dump arbitrary tables")
dbh = read('src/main/ipc/database.handlers.ts')
check("table name validated against schema", 'assertExportableTable' in dbh)
check("users table blocked", 'EXPORT_BLOCKLIST' in dbh and "'users'" in dbh)
check("no raw table interpolation in a query",
      not re.search(r'prepare\(`SELECT \* FROM \$\{tableName\}`\)', dbh))
check("formula injection neutralised", 'csvCell' in dbh)

# 8 — print HTML is escaped
print("\n[8] Print/preview output is escaped")
pr = read('src/main/ipc/print.handlers.ts')
check("escape helper defined", 'function esc(' in pr)
check("numeric helper defined", 'function num(' in pr)
check("logo src validated", 'safeImageSrc' in pr)
check("print windows sandboxed", pr.count('sandbox: true') == 2, f"count={pr.count('sandbox: true')}")
body = strip_comments(pr[pr.index('function generateInvoiceHTML'):])
# Every value that lands in HTML must pass through esc()/num()/safeImageSrc().
# Nested template literals make full parsing impractical, so we assert the
# inverse: no `${identifier.path}` reaches the output without a sanitizer.
bare = re.findall(r'\$\{\s*((?:invoiceData|companyInfo|item|p|sc|su|ac)(?:\??\.[A-Za-z_]\w*)+)\s*\}', body)
check("no bare data interpolation in invoice HTML", not bare, f"bare: {sorted(set(bare))[:5]}")
sanitizers = len(re.findall(r'\b(?:esc|num|safeImageSrc)\(', body))
check("sanitizers applied throughout", sanitizers >= 30, f"count={sanitizers}")

# 9 — arbitrary JS execution removed
print("\n[9] No arbitrary code execution from main")
hits = [p for p, s in walk('src/main') if 'executeJavaScript(' in strip_comments(s)]
check("no executeJavaScript calls", not hits, f"found in {hits}")

# 10 — password reset invalidates sessions
print("\n[10] Password changes invalidate existing sessions")
usr = read('src/main/ipc/users.handlers.ts')
check("resetByDev destroys sessions", usr.count('destroyAllSessionsForUser') >= 2)
check("fake base64 'encryption' removed", 'ENCRYPTED_DEV_USER' not in usr)
check("minimum password length enforced", 'length < 6' in usr)

# 11 — login does not leak which field was wrong
print("\n[11] Login does not disclose whether a user exists")
auth = read('src/main/ipc/auth.handlers.ts')
check("single generic failure message", auth.count('اسم المستخدم أو كلمة المرور غير صحيحة') == 2)
check("dummy compare prevents timing oracle", 'bcrypt.compareSync(password, ' in auth and 'invalid' in auth)
check("session created server-side", 'createSession(event.sender.id' in auth)
check("permissions resolved server-side", 'loadPermissions' in auth)

# 12 — backups are WAL-safe
print("\n[12] Backups are WAL-safe")
bak = read('src/main/ipc/backup.handlers.ts')
check("uses SQLite backup API", 'db.backup(' in bak)
check("restore targets the active db path", 'getDbPath()' in bak)
check("restore validates the file header", 'SQLite format 3' in bak)
check("startup backup uses backup API", 'await db.backup(' in idx)
check("cleanup only removes its own files", 'auto_backup_' in idx and 'test(file)' in idx)

print("\n" + "=" * 68)
print(f"RESULT: {len(PASS)} passed, {len(FAIL)} failed")
print("=" * 68)
if FAIL:
    for f in FAIL:
        print("  FAILED:", f)
    sys.exit(1)
