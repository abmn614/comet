from scaffold.python.context_attribution import (
    attribute_context_sources,
    classify_tool_call,
    estimate_tokens,
)
from scaffold.python.logging import extract_events


def _bash(command: str, output: str = "") -> dict:
    return {"tool": "Bash", "input": {"command": command}, "output": output}


def _read(path: str, output: str = "") -> dict:
    return {"tool": "Read", "input": {"file_path": path}, "output": output}


def test_estimate_tokens_matches_repository_budget_heuristic():
    assert estimate_tokens("") == 0
    assert estimate_tokens("a" * 38) == 10
    assert estimate_tokens("读取当前阶段") == 6
    assert estimate_tokens("读取" + "a" * 19) == 7


def test_classify_tool_call_separates_skill_text_cli_reads_and_commands():
    assert classify_tool_call(_read("/w/.claude/skills/comet-native/reference/commands.md")) == (
        "skill_text",
        "/w/.claude/skills/comet-native/reference/commands.md",
    )
    assert classify_tool_call(_read("/w/.comet/applications/app/versions/abc/SKILL.md"))[0] == (
        "skill_text"
    )
    assert classify_tool_call(_read("/w/pipeline.py")) == ("file_read", "/w/pipeline.py")
    assert classify_tool_call(_bash("comet native next my-change --json")) == (
        "comet_cli",
        "comet native next",
    )
    assert classify_tool_call(_bash("cd /w && COMET_X=1 comet status --json")) == (
        "comet_cli",
        "comet status",
    )
    assert classify_tool_call(
        _bash("CHILD=c1 node .comet/applications/app/versions/abc/tools/session.mjs inspect $CHILD")
    ) == ("comet_cli", "session.mjs inspect")
    assert classify_tool_call(_bash("node assets/skills/comet/scripts/comet-state.mjs --help")) == (
        "comet_cli",
        "comet-state.mjs",
    )
    assert classify_tool_call(_bash("sed -n 1,80p .claude/skills/comet/SKILL.md")) == (
        "skill_text",
        "/skills/comet/SKILL.md",
    )
    assert classify_tool_call(_bash("echo comet is great")) == ("command", "echo comet is great")
    assert classify_tool_call({"tool": "Agent", "input": {}, "output": "done"}) == (
        "other",
        "Agent",
    )


def test_attribute_context_sources_weights_outputs_by_later_tool_calls():
    calls = [
        _read("/w/.claude/skills/comet-native/reference/commands.md", "a" * 380),
        _bash("comet native next c --json", "a" * 38),
        _bash("comet native next c --json", "a" * 38),
        _read("/w/app.py", "a" * 76),
    ]

    summary = attribute_context_sources(calls)

    assert summary["tool_calls"] == 4
    assert summary["by_source"]["skill_text"] == {
        "calls": 1,
        "output_tokens": 100,
        "carried_tokens": 300,
    }
    assert summary["by_source"]["comet_cli"] == {
        "calls": 2,
        "output_tokens": 20,
        "carried_tokens": 30,
    }
    assert summary["by_source"]["file_read"]["carried_tokens"] == 0
    assert summary["output_tokens"] == 140
    assert summary["carried_tokens"] == 330
    assert [item["key"] for item in summary["top_items"]] == [
        "/w/.claude/skills/comet-native/reference/commands.md",
        "comet native next",
        "/w/app.py",
    ]
    assert summary["top_items"][1]["calls"] == 2


def test_attribute_context_sources_handles_missing_and_structured_outputs():
    calls = [
        {"tool": "Read", "input": {"file_path": "/w/a.txt"}},
        {"tool": "TaskCreate", "input": "not-a-dict", "output": {"ok": True}},
    ]

    summary = attribute_context_sources(calls)

    assert summary["by_source"]["file_read"]["output_tokens"] == 0
    assert summary["by_source"]["other"]["output_tokens"] == estimate_tokens('{"ok": true}')


def test_extract_events_records_context_sources():
    events = extract_events(
        {
            "messages": [
                {
                    "type": "assistant",
                    "message": {
                        "id": "m1",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "t1",
                                "name": "Bash",
                                "input": {"command": "comet native status --json"},
                            }
                        ],
                    },
                },
                {
                    "type": "user",
                    "message": {
                        "content": [
                            {"type": "tool_result", "tool_use_id": "t1", "content": "a" * 38}
                        ]
                    },
                },
            ]
        }
    )

    assert events["context_sources"]["by_source"]["comet_cli"]["calls"] == 1
    assert events["context_sources"]["by_source"]["comet_cli"]["output_tokens"] == 10
