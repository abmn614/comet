"""Attribute tool-output context cost to the files and commands that produced it.

Token figures are heuristic estimates (CJK about one token per character, other
text about 3.8 characters per token), matching
``scripts/benchmark/skill-context-budget.mjs``. They rank sources; they are not
tokenizer counts.
"""

from __future__ import annotations

import json
import math
import re
import shlex
import sys
from pathlib import Path
from typing import Any

SOURCES = ("skill_text", "comet_cli", "file_read", "command", "other")
TOP_ITEMS = 10

_WIDE_CHARACTER = re.compile(
    "[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]"
)
_OTHER_CHARACTERS_PER_TOKEN = 3.8
_SKILL_TEXT_PATH = re.compile(
    r"(?:/skills(?:-zh)?/[^\s'\"]+\.md|\.comet/applications/[^\s'\"]+\.md)\b"
)
_COMET_SCRIPT = re.compile(
    r"(?:comet-[a-z0-9-]+\.mjs|\.comet/applications/[^\s'\"]+/tools/[^\s'\"]+\.mjs)"
)
_ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SEPARATORS = {"&&", "||", ";", "|"}


def estimate_tokens(text: str) -> int:
    wide = len(_WIDE_CHARACTER.findall(text))
    return math.ceil(wide + (len(text) - wide) / _OTHER_CHARACTERS_PER_TOKEN)


def _output_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _words(command: str) -> list[str]:
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return command.split()


def _comet_cli_key(command: str) -> str | None:
    """Return ``comet <subcommand ...>`` or ``<script>.mjs <subcommand>`` when the command runs Comet."""
    words = _words(command)
    for index, word in enumerate(words):
        if word in _SEPARATORS or _ENV_ASSIGNMENT.match(word):
            continue
        name = word.rsplit("/", 1)[-1]
        if name == "comet" and (index == 0 or words[index - 1] in _SEPARATORS
                                or _ENV_ASSIGNMENT.match(words[index - 1])):
            rest = [item for item in words[index + 1:index + 4] if not item.startswith("-")]
            subcommands = []
            for item in rest:
                if item in _SEPARATORS or "/" in item or item.startswith("<"):
                    break
                subcommands.append(item)
            return " ".join(["comet", *subcommands[:2]])
        if _COMET_SCRIPT.search(word):
            following = words[index + 1] if index + 1 < len(words) else ""
            subcommand = "" if following.startswith("-") or following in _SEPARATORS else following
            return f"{name} {subcommand}".strip()
    return None


def classify_tool_call(call: dict[str, Any]) -> tuple[str, str]:
    """Return ``(source, key)`` for one tool call."""
    tool = str(call.get("tool") or "")
    inp = call.get("input") if isinstance(call.get("input"), dict) else {}
    if tool == "Read":
        path = str(inp.get("file_path") or "")
        if _SKILL_TEXT_PATH.search(path):
            return "skill_text", path
        return "file_read", path or "Read"
    if tool == "Bash":
        command = str(inp.get("command") or "")
        cli = _comet_cli_key(command)
        if cli:
            return "comet_cli", cli
        skill_path = _SKILL_TEXT_PATH.search(command)
        if skill_path:
            return "skill_text", skill_path.group(0)
        return "command", " ".join(command.split())[:80]
    return "other", tool or "unknown"


def attribute_context_sources(tool_calls: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize tool-output size by source.

    ``carried_tokens`` approximates how long an output stayed in context:
    its estimated tokens multiplied by the number of later tool calls, each of
    which re-sends the conversation. Context compaction is not modeled.
    """
    total = len(tool_calls)
    by_source = {
        source: {"calls": 0, "output_tokens": 0, "carried_tokens": 0} for source in SOURCES
    }
    items: dict[tuple[str, str], dict[str, Any]] = {}
    for index, call in enumerate(tool_calls):
        if not isinstance(call, dict):
            continue
        source, key = classify_tool_call(call)
        tokens = estimate_tokens(_output_text(call.get("output")))
        carried = tokens * (total - index - 1)
        bucket = by_source[source]
        bucket["calls"] += 1
        bucket["output_tokens"] += tokens
        bucket["carried_tokens"] += carried
        item = items.setdefault(
            (source, key),
            {"source": source, "key": key, "calls": 0, "output_tokens": 0, "carried_tokens": 0},
        )
        item["calls"] += 1
        item["output_tokens"] += tokens
        item["carried_tokens"] += carried
    top_items = sorted(
        items.values(), key=lambda item: (-item["carried_tokens"], item["source"], item["key"])
    )[:TOP_ITEMS]
    return {
        "estimator": "heuristic-cjk1-other3.8",
        "tool_calls": total,
        "output_tokens": sum(bucket["output_tokens"] for bucket in by_source.values()),
        "carried_tokens": sum(bucket["carried_tokens"] for bucket in by_source.values()),
        "by_source": by_source,
        "top_items": top_items,
    }


def main(argv: list[str]) -> int:
    """Print ``context_sources`` for saved events files: ``python -m scaffold.python.context_attribution events.json...``."""
    if not argv:
        print("usage: python -m scaffold.python.context_attribution <events.json> [...]", file=sys.stderr)
        return 2
    for name in argv:
        events = json.loads(Path(name).read_text(encoding="utf-8"))
        summary = attribute_context_sources(events.get("tool_calls") or [])
        print(json.dumps({"events": name, "context_sources": summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
