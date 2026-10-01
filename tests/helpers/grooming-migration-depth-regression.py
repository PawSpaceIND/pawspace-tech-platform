#!/usr/bin/env python3
"""Read-only regression for Grooming migration 0045; all SQL runs in :memory:.

Python 3.11+ is required for Connection.setlimit. Without --baseline, synthesize
the previous OR predicate from the candidate's exact manifest for the RED check.
"""
import argparse
import re
import sqlite3
from pathlib import Path


def statements(sql):
    result, pending = [], ""
    for line in sql.splitlines(True):
        pending += line
        if sqlite3.complete_statement(pending):
            result.append(pending.strip())
            pending = ""
    assert not pending.strip(), "Incomplete SQL tail"
    return result


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def epoch(db):
    return db.execute("SELECT epoch FROM grooming_revision_installation_epoch WHERE id=1").fetchone()[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--baseline")
    args = parser.parse_args()
    candidate = statements(Path(args.candidate).read_text())
    candidates = [s for s in candidate if s.startswith("WITH expected_grooming_triggers")]
    assert len(candidates) == 1, "Expected one row-based manifest fence"
    fence = candidates[0]
    cte = fence[:fence.index("UPDATE grooming_revision_installation_epoch")]
    db = sqlite3.connect(":memory:")
    rows = db.execute(cte + "SELECT name,sql FROM expected_grooming_triggers").fetchall()
    assert len(rows) == len(set(name for name, _ in rows)) == 57, "Manifest must contain all 57 unique triggers"

    if args.baseline:
        baseline = statements(Path(args.baseline).read_text())
        old_fences = [s for s in baseline if s.startswith("UPDATE grooming_revision_installation_epoch")]
        assert len(old_fences) == 1
        old_fence = old_fences[0]
        assert [s for s in baseline if s != old_fence] == [s for s in candidate if s != fence], "Unexpected migration changes outside the fence"
    else:
        # This preserves the old split string literal, needed by the DDL normalizer.
        terms = ["(name=" + literal(name) + " AND sql='CREATE '||" + literal(sql.removeprefix("CREATE ")) + ")" for name, sql in rows]
        old_fence = "UPDATE grooming_revision_installation_epoch SET epoch=epoch+1 WHERE id=1 AND NOT ((SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND (" + " OR ".join(terms) + "))=57 AND EXISTS(SELECT 1 FROM grooming_revision_installation WHERE id=1 AND schema_version=2));"

    # Only prerequisite table shapes needed to compile actual trigger DDL are mocked.
    # Predicates read the real sqlite_master and every trigger is actual candidate DDL.
    db.executescript("CREATE TABLE grooming_revision_installation(id INTEGER PRIMARY KEY,schema_version INTEGER);INSERT INTO grooming_revision_installation VALUES(1,2);CREATE TABLE grooming_revision_installation_epoch(id INTEGER PRIMARY KEY,epoch INTEGER,incarnation TEXT);INSERT INTO grooming_revision_installation_epoch VALUES(1,1,'" + "x" * 64 + "');")
    tables = {}
    for name, sql in rows:
        table = re.search(r"\bON ([a-z_]+)\b", sql).group(1)
        cols = set(re.findall(r"\b(?:NEW|OLD)\.([a-z_]+)\b", sql, re.I)) | {"id"}
        tables.setdefault(table, set()).update(cols)
    tables["conversation_ownership_revisions"].add("revision")
    tables["grooming_effective_control_revision"].update(["revision", "database_incarnation"])
    for table, cols in tables.items():
        if table != "grooming_revision_installation_epoch":
            db.execute("CREATE TABLE " + table + " (" + ",".join('"' + col + '" TEXT' for col in sorted(cols)) + ")")
    for _, sql in rows:
        db.execute(sql)
    actual = dict(db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'"))
    assert dict(rows) == actual, "Manifest must match the exact installed SQL of all triggers"

    # Confirm the supplied old predicate was valid at the normal SQLite limit.
    db.execute(old_fence)
    assert epoch(db) == 1, "Baseline manifest does not match candidate definitions"
    db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)
    assert db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH) == 100
    try:
        # Unique SQL text avoids the prepared-statement cache after changing limits.
        db.execute(old_fence + "\n-- depth-100 baseline probe")
    except sqlite3.Error as error:
        assert "Expression tree is too large" in str(error), str(error)
        print("RED confirmed: baseline rejected at expression depth 100")
    else:
        raise AssertionError("Baseline unexpectedly accepted at depth 100")

    db.execute(fence)
    assert epoch(db) == 1, "Intact replay must preserve the epoch"
    print("GREEN: intact candidate replay preserves epoch at depth 100")
    count = 0
    for name, sql in rows:
        for mode in ("missing", "altered"):
            before = epoch(db)
            db.execute("DROP TRIGGER " + name)
            if mode == "altered":
                table = re.search(r"\bON ([a-z_]+)\b", sql).group(1)
                db.execute("CREATE TRIGGER " + name + " AFTER UPDATE ON " + table + " BEGIN SELECT 1; END")
            db.execute(fence)
            assert epoch(db) == before + 1, (name, mode, "must fence exactly once")
            if mode == "altered":
                db.execute("DROP TRIGGER " + name)
            db.execute(sql)
            after = epoch(db)
            db.execute(fence)
            assert epoch(db) == after, (name, "repaired replay must be intact")
            count += 1
    print(f"GREEN: {count}/114 missing/altered-trigger cases fence; repaired replay is intact")

    for marker in (1, None, 3):
        db.execute("DELETE FROM grooming_revision_installation")
        if marker is not None:
            db.execute("INSERT INTO grooming_revision_installation VALUES(1,?)", (marker,))
        before = epoch(db)
        db.execute(fence)
        assert epoch(db) == before + 1, (marker, "invalid marker must fence")
    db.execute("DELETE FROM grooming_revision_installation")
    db.execute("INSERT INTO grooming_revision_installation VALUES(1,2)")
    db.execute("CREATE TRIGGER unrelated_probe AFTER UPDATE ON ai_handoffs BEGIN SELECT 1; END")
    before = epoch(db)
    db.execute(fence)
    assert epoch(db) == before, "Unrelated trigger must not invalidate complete manifest"
    print("GREEN: missing/wrong marker versions fence; extra unrelated trigger is harmless")
    print("PASS: all 57 unique exact trigger definitions; SQLite depth-100 semantics verified")


if __name__ == "__main__":
    main()
