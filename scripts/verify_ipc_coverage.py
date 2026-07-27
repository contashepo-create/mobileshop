#!/usr/bin/env python3
"""
Ensures every registered IPC channel has an access rule.

The guard denies unmapped channels by default, so a missing entry would lock
users out of a working feature. This catches that at build time instead of in
production. Run with:  python3 scripts/verify_ipc_coverage.py
"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
IPC_DIR = os.path.join(ROOT, 'src/main/ipc')
GUARD = os.path.join(ROOT, 'src/main/security/ipcGuard.ts')

# Channels registered outside src/main/ipc (auth/dev live in their own modules).
EXTRA_SOURCES = ['src/main/ipc/auth.handlers.ts', 'src/main/ipc/settings.handlers.ts']

registered = set()
for fn in sorted(os.listdir(IPC_DIR)):
    if not fn.endswith('.ts'):
        continue
    src = open(os.path.join(IPC_DIR, fn), encoding='utf-8').read()
    for m in re.finditer(r"ipcMain\.handle\(\s*'([^']+)'", src):
        registered.add(m.group(1))

guard = open(GUARD, encoding='utf-8').read()

def block(name):
    m = re.search(name + r'[^=]*=\s*new Set<string>\(\[(.*?)\]\)', guard, re.S)
    if m:
        return set(re.findall(r"'([^']+)'", m.group(1)))
    return set()

public = block('PUBLIC_CHANNELS')
auth_only = block('AUTHENTICATED_ONLY')

perm_m = re.search(r'CHANNEL_PERMISSIONS:\s*Record<string, string>\s*=\s*\{(.*?)\n\};', guard, re.S)
mapped = set(re.findall(r"'([^']+)'\s*:\s*'[^']+'", perm_m.group(1))) if perm_m else set()

covered = public | auth_only | mapped

print("=" * 68)
print("IPC CHANNEL COVERAGE")
print("=" * 68)
print(f"registered channels : {len(registered)}")
print(f"public              : {len(public)}")
print(f"authenticated-only  : {len(auth_only)}")
print(f"permission-mapped   : {len(mapped)}")

missing = sorted(registered - covered)
stale = sorted(covered - registered)

ok = True
if missing:
    ok = False
    print(f"\nMISSING ACCESS RULE ({len(missing)}) — these would be DENIED at runtime:")
    for c in missing:
        print("   -", c)
else:
    print("\nOK: every registered channel has an access rule")

# A rule for a channel that no longer exists is dead config, not a failure.
if stale:
    print(f"\nNOTE: {len(stale)} rule(s) reference channels not currently registered:")
    for c in stale:
        print("   -", c)

# A channel must not be in more than one bucket (ambiguous intent).
dupes = sorted((public & auth_only) | (public & mapped) | (auth_only & mapped))
if dupes:
    ok = False
    print(f"\nAMBIGUOUS: channel(s) listed in multiple buckets: {dupes}")

print("\n" + "=" * 68)
print("RESULT:", "PASS" if ok else "FAIL")
print("=" * 68)
sys.exit(0 if ok else 1)
