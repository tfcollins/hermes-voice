import json

import pytest

from hermes_voice.app import STATIC, auth_headers, parse_sse, spoken_text


def test_auth_headers_requires_key(monkeypatch):
    import hermes_voice.app as module

    monkeypatch.setattr(module, "HERMES_KEY", "")
    with pytest.raises(RuntimeError):
        auth_headers()


def test_auth_headers(monkeypatch):
    import hermes_voice.app as module

    monkeypatch.setattr(module, "HERMES_KEY", "test-key")
    assert auth_headers()["Authorization"] == "Bearer test-key"


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

    for element_id in ("voiceButton", "repeatButton", "newButton", "commandHint"):
        assert f'id="{element_id}"' in html
    assert html.count("data-prompt=") == 3
    assert "new_session" in javascript
    assert "ArrowUp" in javascript
    assert "stopSpeaking" in javascript
