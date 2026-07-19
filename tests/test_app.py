import json

import pytest

from hermes_voice.app import (
    STATIC,
    auth_headers,
    hal_event_to_voice,
    hal_headers,
    parse_sse,
    spoken_text,
)


def test_auth_headers_requires_key(monkeypatch):
    import hermes_voice.app as module

    monkeypatch.setattr(module, "HERMES_KEY", "")
    with pytest.raises(RuntimeError):
        auth_headers()


def test_auth_headers(monkeypatch):
    import hermes_voice.app as module

    monkeypatch.setattr(module, "HERMES_KEY", "test-key")
    assert auth_headers()["Authorization"] == "Bearer test-key"


def test_hal_headers(monkeypatch):
    import hermes_voice.app as module

    monkeypatch.setattr(module, "HAL_KEY", "hal-secret")
    assert hal_headers() == {
        "Authorization": "Bearer hal-secret",
        "Content-Type": "application/json",
    }


@pytest.mark.asyncio
async def test_parse_sse():
    class Response:
        async def aiter_lines(self):
            for line in [
                "event: assistant.delta",
                'data: {"delta":"Good"}',
                "",
                "event: tool.started",
                'data: {"tool_name":"terminal"}',
                "",
            ]:
                yield line

    events = [event async for event in parse_sse(Response())]
    assert events == [
        ("assistant.delta", {"delta": "Good"}),
        ("tool.started", {"tool_name": "terminal"}),
    ]


def test_spoken_text_removes_visual_markdown():
    rendered = spoken_text(
        "# Result\n\n- **Done**: see [the report](https://example.com).\n"
        "```python\nprint('not spoken')\n```\nUse `systemctl status`."
    )

    assert rendered == "Result Done: see the report. Code omitted. Use systemctl status."


def test_spoken_text_is_bounded():
    assert spoken_text("word " * 1000, limit=24) == "word word word word word"


def test_assistant_controls_are_present():
    html = (STATIC / "index.html").read_text()
    javascript = (STATIC / "app.js").read_text()

    for element_id in (
        "voiceButton",
        "repeatButton",
        "newButton",
        "commandHint",
        "modelSelect",
    ):
        assert f'id="{element_id}"' in html
    assert html.count("data-prompt=") == 3
    assert "new_session" in javascript
    assert "ArrowUp" in javascript
    assert "stopSpeaking" in javascript
    assert "hermesVoiceModel" in javascript


def test_hal_tool_event_translation():
    translated = hal_event_to_voice(
        {
            "kind": "tool_use",
            "adapter": "claude",
            "tool_name": "terminal",
            "tool_input": {"command": "hostname"},
        }
    )

    assert translated == {
        "type": "tool.started",
        "payload": {
            "tool_name": "terminal",
            "args": {"command": "hostname"},
            "preview": "HAL · claude",
        },
    }


def test_hal_text_and_error_event_translation():
    assert hal_event_to_voice({"kind": "text", "text": "Alternate answer"}) == {
        "type": "assistant.delta",
        "payload": {"delta": "Alternate answer"},
    }
    assert hal_event_to_voice({"kind": "error", "error_message": "limit"}) == {
        "type": "run.failed",
        "payload": {"message": "limit"},
    }
