"""AI-assisted card review using Muse Spark via an OpenAI-compatible API.

The frontend calls ``POST /api/cards/{id}/ai-review``; this module builds the
prompt, calls the model, and parses the suggested single-fact cards.
"""

import json
import os
import re

AI_MODEL = os.getenv("AI_MODEL", "muse-spark-1.3-contributor")
AI_BASE_URL = os.getenv("AI_BASE_URL", "https://api.meta.ai/v1")

CUSTOM_SYSTEM_INSTRUCTIONS = """You answer questions about a flashcard.

Rules:
- Base your answer on the card's question and answer below.
- Be concise: a few sentences at most.
- Plain text only, no HTML."""

SYSTEM_INSTRUCTIONS = """You split a flashcard into the smallest useful set of single-fact cards.

Rules:
- Each suggested card tests exactly one fact, easy to remember.
- Keep the number of new cards as small as possible: only include the most
  important items from the original card.
- If the original card already tests exactly one fact clearly, do NOT
  split or rewrite it: reply with {"cards": []} to indicate no change
  is needed.
- Drop trivia, duplicates, and minor details.
- Front is a short question or cue; back is a short answer (one fact).
- Plain text only, no HTML.
- Reply with JSON only: {"cards": [{"front": "...", "back": "..."}]}"""


def strip_html(html: str) -> str:
    """Card HTML to plain text for the model prompt."""
    import html as html_module
    from html.parser import HTMLParser

    class _Text(HTMLParser):
        blocks = {"p", "div", "br", "li", "tr", "hr", "h1", "h2", "h3"}

        def __init__(self):
            super().__init__()
            self.parts: list[str] = []

        def handle_data(self, data: str):
            self.parts.append(data)

        def handle_endtag(self, tag: str):
            if tag in self.blocks:
                self.parts.append(" ")

    parser = _Text()
    parser.feed(html or "")
    return html_module.unescape(" ".join("".join(parser.parts).split())).strip()


def build_prompt(front_html: str, back_html: str) -> str:
    front = strip_html(front_html)
    back = strip_html(back_html)
    return (
        "Review this flashcard and split it into minimal single-fact cards.\n\n"
        f"Front:\n{front}\n\nBack:\n{back}\n\n"
        'Reply with JSON only: {"cards": [{"front": "...", "back": "..."}]}, '
        'or {"cards": []} if the card already tests a single fact and needs '
        "no change."
    )


def build_custom_prompt(front_html: str, back_html: str, question: str) -> str:
    front = strip_html(front_html)
    back = strip_html(back_html)
    return (
        "Answer this question about the flashcard below.\n\n"
        f"Front:\n{front}\n\nBack:\n{back}\n\n"
        f"Question:\n{(question or '').strip()}\n\n"
        "Reply in plain text only."
    )


def extract_delta(event) -> str | None:
    """Best-effort text delta from one Responses stream event."""
    event_type = getattr(event, "type", None)
    if event_type is None and isinstance(event, dict):
        event_type = event.get("type")
    if event_type != "response.output_text.delta":
        return None
    delta = getattr(event, "delta", None)
    if delta is None and isinstance(event, dict):
        delta = event.get("delta")
    return str(delta) if delta else None


def parse_suggestions(payload: str) -> list[dict]:
    """Parse model JSON into [{front, back}], tolerating code fences.

    An explicit empty list ({"cards": []}) means the AI concluded the card
    already tests a single fact and needs no change.
    """
    text = (payload or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    data = json.loads(text)
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        if "cards" not in data:
            raise ValueError("AI reply must be a JSON object with a 'cards' list")
        items = data["cards"]
    else:
        raise ValueError("AI reply must be a JSON object with a 'cards' list")
    if not isinstance(items, list):
        raise ValueError("AI reply must be a JSON object with a 'cards' list")
    if not items:
        return []
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        front = str(item.get("front", "")).strip()
        back = str(item.get("back", "")).strip()
        if front and back:
            out.append({"front": front, "back": back})
    if not out:
        raise ValueError("AI reply contained no usable cards")
    return out


def extract_response_text(response) -> str:
    """Best-effort text extraction across openai SDK response shapes."""
    text = getattr(response, "output_text", None)
    if text:
        return str(text)
    output = getattr(response, "output", None) or []
    chunks: list[str] = []
    for block in output:
        contents = getattr(block, "content", None) or []
        for part in contents:
            t = getattr(part, "text", None)
            if t:
                chunks.append(str(t))
    if chunks:
        return "".join(chunks)
    choices = getattr(response, "choices", None) or []
    for choice in choices:
        msg = getattr(choice, "message", None)
        content = getattr(msg, "content", None) if msg is not None else None
        if isinstance(content, str) and content:
            return content
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("text"):
                    chunks.append(str(part["text"]))
                elif getattr(part, "text", None):
                    chunks.append(str(part.text))
    if chunks:
        return "".join(chunks)
    data = None
    if hasattr(response, "model_dump"):
        try:
            data = response.model_dump()
        except Exception:
            data = None
    if isinstance(data, dict):
        try:
            return json.dumps(data)
        except Exception:
            pass
    return str(response)


def _require_client(client=None):
    api_key = os.environ.get("MODEL_API_KEY")
    if client is None and not api_key:
        raise RuntimeError("MODEL_API_KEY is not set")
    if client is None:
        from openai import OpenAI

        client = OpenAI(base_url=AI_BASE_URL, api_key=api_key)
    return client


def review_card_with_ai(
    front_html: str, back_html: str, client=None
) -> tuple[list[dict], str]:
    """Call Muse Spark and return (suggestions, model name)."""
    client = _require_client(client)
    response = client.responses.create(
        model=AI_MODEL,
        instructions=SYSTEM_INSTRUCTIONS,
        input=build_prompt(front_html, back_html),
    )
    return parse_suggestions(extract_response_text(response)), AI_MODEL


def answer_question_with_ai(
    front_html: str, back_html: str, question: str, client=None
) -> tuple[str, str]:
    """Answer a free-form question about a card; return (answer, model name)."""
    if not (question or "").strip():
        raise ValueError("A question is required")
    client = _require_client(client)
    response = client.responses.create(
        model=AI_MODEL,
        instructions=CUSTOM_SYSTEM_INSTRUCTIONS,
        input=build_custom_prompt(front_html, back_html, question),
    )
    return extract_response_text(response).strip(), AI_MODEL


def stream_review_with_ai(
    front_html: str,
    back_html: str,
    mode: str = "split",
    question: str | None = None,
    client=None,
):
    """Yield raw text deltas from Muse Spark as they arrive.

    ``mode`` is ``"split"`` (suggest single-fact cards as JSON) or
    ``"custom"`` (answer ``question`` in plain text). The caller accumulates
    the deltas and parses the full text once the stream ends.
    """
    if mode == "custom" and not (question or "").strip():
        raise ValueError("A question is required")
    client = _require_client(client)
    if mode == "custom":
        instructions = CUSTOM_SYSTEM_INSTRUCTIONS
        prompt = build_custom_prompt(front_html, back_html, question or "")
    else:
        instructions = SYSTEM_INSTRUCTIONS
        prompt = build_prompt(front_html, back_html)
    stream = client.responses.create(
        model=AI_MODEL,
        instructions=instructions,
        input=prompt,
        stream=True,
    )
    for event in stream:
        delta = extract_delta(event)
        if delta:
            yield delta
