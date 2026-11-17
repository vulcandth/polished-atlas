#!/usr/bin/env python3
"""Inventory ALL commits and endpoint files; never infer review completion.

Each generated commit starts pending. Human/agent review must supply a reason,
disposition, evidence, and resolved status. Re-running preserves those reviews.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess

BASE = "e410d7405e7d5d016b16a0a59bfb6da0b2a9eabf"
HEAD = "704ea9db192ca8b902ef4aa7a441eb905eb29b89"


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output([os.environ.get("GIT_BIN", "git"), "-C", str(repo), *args],
                                   encoding="utf-8")


def inventory(repo: Path, output: Path, base: str, head: str) -> dict:
    previous = json.loads(output.read_text(encoding="utf-8")) if output.exists() else {}
    reviews = {c["sha"]: c for c in previous.get("commits", [])}
    raw = git(repo, "log", "--reverse", "--topo-order", "--format=%x1e%H%x1f%P%x1f%s",
              "--name-status", f"{base}..{head}")
    commits = []
    for record in raw.split("\x1e"):
        if not record.strip():
            continue
        first, *lines = record.strip().splitlines()
        sha, parents, subject = first.split("\x1f", 2)
        entry = dict(sha=sha, parents=parents.split(), subject=subject,
                     changes=[line.split("\t") for line in lines if line.strip()],
                     status="pending", disposition=None, reason="", evidence=[])
        if len(entry["parents"]) > 1:
            entry["merge_parent_changes"] = {
                parent: [line.split("\t") for line in git(repo, "diff", "--name-status", parent, sha).splitlines()]
                for parent in entry["parents"]
            }
        for key in ("status", "disposition", "reason", "evidence", "review_method", "triage_note"):
            if sha in reviews:
                if key in reviews[sha]:
                    entry[key] = reviews[sha][key]
        commits.append(entry)
    files = git(repo, "diff", "--name-status", "--find-renames", base, head).splitlines()
    result = dict(base=base, head=head, commit_count=len(commits),
                  endpoint_changes=[line.split("\t") for line in files], commits=commits)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return result


def validate(repo: Path, ledger: dict) -> None:
    expected = set(git(repo, "rev-list", f"{ledger['base']}..{ledger['head']}").splitlines())
    commits = ledger["commits"]
    actual = {c["sha"] for c in commits}
    if actual != expected or len(commits) != len(expected):
        raise ValueError("Audit ledger does not cover the exact commit range")
    files = [line.split("\t") for line in git(repo, "diff", "--name-status", "--find-renames",
                                             ledger["base"], ledger["head"]).splitlines()]
    if files != ledger["endpoint_changes"]:
        raise ValueError("Endpoint file inventory is stale or incomplete")
    allowed = {"adaptation", "regeneration", "already-supported", "no-atlas-impact", "superseded"}
    unresolved = [c["sha"] for c in commits if c["status"] != "resolved"
                  or c["disposition"] not in allowed or not c["reason"] or not c["evidence"]]
    if unresolved:
        raise ValueError(f"{len(unresolved)} commits still require review/resolution")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base", default=BASE)
    parser.add_argument("--head", default=HEAD)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        ledger = json.loads(args.output.read_text(encoding="utf-8"))
        if ledger["base"] != args.base or ledger["head"] != args.head:
            raise ValueError("Ledger range does not match the required source range")
        validate(args.repo, ledger)
    else:
        ledger = inventory(args.repo, args.output, args.base, args.head)
    pending = sum(c["status"] != "resolved" for c in ledger["commits"])
    print(f"{len(ledger['commits'])} commits; {len(ledger['endpoint_changes'])} changed paths; {pending} pending")


if __name__ == "__main__":
    main()
