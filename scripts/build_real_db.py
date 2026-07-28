#!/usr/bin/env python3
"""
Builds a real SQLite database by replaying the migration SQL from
src/main/database/migrations/index.ts with the SAME control flow as the
TypeScript source.

This is important: several migrations wrap MULTIPLE db.exec() calls in a single
`try { ... } catch {}`. If an early statement throws, the remaining statements
in that block are skipped. A naive replay that wraps each statement
individually produces a completely different (and misleadingly destructive)
result, so we parse the try-block boundaries and honour them.

Usage:  python3 scripts/build_real_db.py [out.db] [--runs N] [-v]
"""
import os
import re
import sqlite3
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
MIG = os.path.join(ROOT, 'src/main/database/migrations/index.ts')


def split_statements(sql):
    """Split a SQL script on semicolons that are real statement separators.

    A plain ``sql.split(';')`` breaks on any semicolon inside a ``--`` comment
    or a quoted string, and — worse — leaves the comment glued to the previous
    fragment so the FOLLOWING statement never runs. A CREATE TABLE preceded by
    an explanatory comment was silently skipped, and the migration verifier then
    reported a syntax error for text that SQLite would never have seen.

    Comments are stripped and quotes tracked, so the result matches what SQLite
    itself would execute.
    """
    out, buf = [], []
    quote = None
    line_comment = block_comment = False
    i, n = 0, len(sql)
    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ''
        if line_comment:
            if c == '\n':
                line_comment = False
                buf.append(c)
            i += 1
            continue
        if block_comment:
            if c == '*' and nxt == '/':
                block_comment = False
                i += 1
            i += 1
            continue
        if quote is None and c == '-' and nxt == '-':
            line_comment = True
            i += 2
            continue
        if quote is None and c == '/' and nxt == '*':
            block_comment = True
            i += 2
            continue
        if quote is not None:
            buf.append(c)
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            buf.append(c)
            i += 1
            continue
        if c == ';':
            stmt = ''.join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    tail = ''.join(buf).strip()
    if tail:
        out.append(tail)
    return out


def parse_blocks(ts_source):
    """
    Returns an ordered list of (guarded: bool, [sql, ...]).

    `guarded=True`  -> the statements were inside `try { } catch {}`; a failure
                       aborts the rest of THAT block only.
    `guarded=False` -> a bare db.exec(); a failure would crash the app.
    """
    # Start at runMigrations: the helper functions above it contain SQL with
    # ${} placeholders that are only meaningful at runtime.
    src = ts_source[ts_source.index('export function runMigrations'):ts_source.index('function seedData')]

    # Locate each `try {` ... matching `}` region so we can group the execs.
    try_regions = []
    for m in re.finditer(r'\btry\s*\{', src):
        depth, i = 0, m.end() - 1
        while i < len(src):
            if src[i] == '{':
                depth += 1
            elif src[i] == '}':
                depth -= 1
                if depth == 0:
                    try_regions.append((m.start(), i))
                    break
            i += 1

    def in_try(pos):
        for a, b in try_regions:
            if a <= pos <= b:
                return (a, b)
        return None

    # Collect every SQL-bearing call in source order.
    calls = []
    for m in re.finditer(r'db\.exec\(\s*`(.*?)`\s*\)', src, re.S):
        calls.append((m.start(), m.group(1)))
    for m in re.finditer(r'db\.prepare\(\s*"([^"]+)"\s*\)\.run\(\)', src):
        calls.append((m.start(), m.group(1)))
    calls.sort(key=lambda x: x[0])

    blocks, current_key, current = [], None, []
    for pos, raw in calls:
        parts = split_statements(raw)
        key = in_try(pos)
        if key != current_key:
            if current:
                blocks.append((current_key is not None, current))
            current_key, current = key, []
        current.extend(parts)
    if current:
        blocks.append((current_key is not None, current))
    return blocks


def run_once(db, blocks, verbose=False):
    ok = skipped = 0
    problems = []
    for guarded, stmts in blocks:
        aborted = False
        for s in stmts:
            if aborted:
                skipped += 1
                if verbose:
                    print(f"      ~ SKIPPED (block aborted): {' '.join(s.split())[:66]}")
                continue
            try:
                db.execute(s)
                ok += 1
            except Exception as e:
                head = ' '.join(s.split())[:66]
                msg = str(e)
                # "duplicate column" is the normal idempotency signal
                benign = 'duplicate column name' in msg or 'already exists' in msg
                problems.append((head, msg, benign, guarded))
                if guarded:
                    aborted = True
                if verbose and not benign:
                    print(f"      x {head}\n        {msg}")
    return ok, skipped, problems


def main():
    args = [a for a in sys.argv[1:]]
    verbose = '-v' in args
    out = next((a for a in args if not a.startswith('-') and a.endswith('.db')), '/tmp/real_shop.db')
    runs = int(args[args.index('--runs') + 1]) if '--runs' in args else 2

    ts = open(MIG, encoding='utf-8').read()
    blocks = parse_blocks(ts)
    total = sum(len(b[1]) for b in blocks)
    print(f"parsed {len(blocks)} block(s), {total} SQL statement(s) from runMigrations()")

    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    db.isolation_level = None
    db.execute('PRAGMA foreign_keys = ON')

    for r in range(1, runs + 1):
        print(f"\n--- application start #{r} ---")
        ok, skipped, problems = run_once(db, blocks, verbose)
        real = [p for p in problems if not p[2]]
        print(f"    {ok} executed, {skipped} skipped after an aborted block, "
              f"{len(problems)} error(s) of which {len(real)} non-benign")
        for head, msg, benign, guarded in real:
            print(f"      ! {head}\n        {msg}")

    tables = [t[0] for t in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    orphans = [t for t in tables if t.endswith('_new')]
    print(f"\ntables: {len(tables)}")
    if orphans:
        print(f"ORPHAN REBUILD TABLES LEFT BEHIND: {orphans}")
    db.commit()
    db.close()
    print(f"wrote {out}")


if __name__ == '__main__':
    main()
