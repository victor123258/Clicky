"""Native desktop assistant: global hotkey, cloud vision, and approved actions."""
from __future__ import annotations

import base64
import json
import os
import queue
import re
import sys
import threading
import time
from dataclasses import dataclass
from io import BytesIO
from typing import Any

from dotenv import load_dotenv
from PIL import Image

try:
    import pyautogui
except ImportError:
    pyautogui = None
else:
    pyautogui.FAILSAFE = True

GEMINI_MODEL = "gemini-2.5-flash"
OPENROUTER_MODEL = "google/gemini-2.5-flash:free"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_VISUAL_CHARS = 150_000
SYSTEM_PROMPT = '''You are a cautious desktop assistant. Inspect the screenshot and spoken request. Return exactly one JSON object, optionally inside a ```json code fence. Supported schemas:
{"action":"click","x":540,"y":300}
{"action":"type","text":"Hello World"}
{"action":"render_visual","html_payload":"<svg xmlns=\\\"http://www.w3.org/2000/svg\\\" viewBox=\\\"0 0 800 600\\\"><circle cx=\\\"400\\\" cy=\\\"300\\\" r=\\\"80\\\" fill=\\\"#38bdf8\\\"/></svg>"}
{"action":"clear_visual"}
{"action":"none"}
Coordinates are integer pixels within the screenshot. Click/type actions require explicit user confirmation. Never request secrets, passwords, payment details, destructive actions, or security changes. If uncertain, use none.
For a graphic, return a self-contained HTML or SVG fragment. If using Three.js, use the trusted global THREE supplied by the isolated overlay and put code in a module script; do not import external URLs. The visual runs in an opaque-origin sandboxed iframe without network access, Electron privileges, or access to the parent page. Avoid huge loops or excessive resources. Never include credentials or attempt to access the host outside the graphics sandbox.'''


@dataclass(frozen=True)
class Action:
    name: str
    x: int | None = None
    y: int | None = None
    text: str | None = None
    html_payload: str | None = None


def emit(message: dict[str, Any]) -> None:
    """Write exactly one JSON Lines message for the Electron main process."""
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def encode_screenshot(image: Image.Image, max_edge: int = 1920, quality: int = 88) -> bytes:
    """JPEG-compress the desktop capture while preserving UI detail."""
    image = image.convert("RGB")
    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    stream = BytesIO()
    image.save(stream, format="JPEG", quality=quality, optimize=True, progressive=True)
    return stream.getvalue()


def parse_action(raw: str, image_size: tuple[int, int]) -> Action:
    """Extract the first balanced JSON object from fenced or preambled output."""
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", raw.strip(), re.I | re.S)
    text = fence.group(1).strip() if fence else raw.strip()
    start = text.find("{")
    if start < 0:
        raise ValueError("Model response did not contain a JSON object")
    depth = 0
    quoted = escaped = False
    end = None
    for i in range(start, len(text)):
        char = text[i]
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        raise ValueError("Model response contained incomplete JSON")
    try:
        payload: Any = json.loads(text[start:end])
    except json.JSONDecodeError as exc:
        raise ValueError("Model response contained invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("Model action must be an object")
    name = payload.get("action")
    if name == "click":
        x, y = payload.get("x"), payload.get("y")
        if type(x) is not int or type(y) is not int or not (0 <= x < image_size[0] and 0 <= y < image_size[1]):
            raise ValueError("Click coordinates are invalid or outside the captured screen")
        return Action("click", x=x, y=y)
    if name == "type":
        value = payload.get("text")
        if not isinstance(value, str) or not value.strip() or len(value) > 500:
            raise ValueError("Typing action must contain 1–500 characters")
        return Action("type", text=value)
    if name == "render_visual":
        markup = payload.get("html_payload")
        if not isinstance(markup, str) or not markup.strip() or len(markup) > MAX_VISUAL_CHARS:
            raise ValueError("Visual payload must contain 1–150,000 characters")
        return Action("render_visual", html_payload=markup)
    if name == "clear_visual":
        return Action("clear_visual")
    if name == "none":
        return Action("none")
    raise ValueError(f"Unsupported model action: {name!r}")


def select_provider() -> tuple[str, str, str]:
    """Use explicit AI_PROVIDER, else Gemini when its key exists, else OpenRouter."""
    preference = os.getenv("AI_PROVIDER", "").strip().lower()
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    openrouter_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if preference not in {"", "gemini", "openrouter"}:
        raise RuntimeError("AI_PROVIDER must be 'gemini' or 'openrouter'")
    if preference == "gemini" or (not preference and gemini_key):
        if not gemini_key:
            raise RuntimeError("GEMINI_API_KEY is not configured")
        return "gemini", gemini_key, os.getenv("GEMINI_MODEL", GEMINI_MODEL)
    if preference == "openrouter" or (not preference and openrouter_key):
        if not openrouter_key:
            raise RuntimeError("OPENROUTER_API_KEY is not configured")
        return "openrouter", openrouter_key, os.getenv("OPENROUTER_MODEL", OPENROUTER_MODEL)
    raise RuntimeError("No API key found. Set GEMINI_API_KEY or OPENROUTER_API_KEY in heyclicky-local/.env")


def request_gemini(key: str, model: str, command: str, jpeg: bytes) -> str:
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=90_000))
    result = client.models.generate_content(
        model=model,
        contents=[types.Part.from_bytes(data=jpeg, mime_type="image/jpeg"), f"User request: {command}"],
        config=types.GenerateContentConfig(system_instruction=SYSTEM_PROMPT, temperature=0.1),
    )
    if not result.text:
        raise RuntimeError("Gemini returned an empty response")
    return result.text


def request_openrouter(key: str, model: str, command: str, jpeg: bytes) -> str:
    import requests
    data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
    payload = {"model": model, "temperature": 0.1, "messages": [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": [
            {"type": "text", "text": f"User request: {command}"},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]},
    ]}
    try:
        response = requests.post(OPENROUTER_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "X-Title": "HeyClicky Native"},
            json=payload, timeout=(10, 90))
        response.raise_for_status()
        text = response.json()["choices"][0]["message"]["content"]
    except (requests.RequestException, ValueError, KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"OpenRouter request failed: {exc}") from exc
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("OpenRouter returned empty content")
    return text


def plan_action(command: str, screenshot: Image.Image) -> Action:
    if not command.strip():
        raise ValueError("Speech transcript was empty")
    provider, key, model = select_provider()
    jpeg = encode_screenshot(screenshot)
    response = request_gemini(key, model, command, jpeg) if provider == "gemini" else request_openrouter(key, model, command, jpeg)
    encoded_image = Image.open(BytesIO(jpeg))
    action = parse_action(response, encoded_image.size)
    if action.name == "click":
        # Screenshot pixels can differ from PyAutoGUI's logical desktop coordinates
        # on HiDPI/Retina systems, so map to the automation coordinate dimensions.
        target_width, target_height = pyautogui.size()
        return Action("click", x=round(action.x * target_width / encoded_image.width),
                      y=round(action.y * target_height / encoded_image.height))
    return action


COMMAND_QUEUE: queue.Queue[dict[str, Any]] = queue.Queue()


def read_electron_commands() -> None:
    """Consume Electron's JSONL command channel without blocking approvals."""
    for line in sys.stdin:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, dict):
            continue
        kind = message.get("type")
        if kind == "approval":
            COMMAND_QUEUE.put(message)
        elif kind == "voice_request":
            threading.Thread(target=on_hotkey, daemon=True).start()
        elif kind == "clear_visual":
            emit({"type": "clear_visual"})
            emit({"type": "status", "message": "Graphics cleared."})
        elif kind == "shutdown":
            emit({"type": "shutdown"})
            return


def wait_for_approval(action: Action) -> bool:
    emit({"type": "action_confirmation", "action": action.name, "x": action.x, "y": action.y, "text": action.text})
    while True:
        message = COMMAND_QUEUE.get()
        if message.get("type") == "approval":
            return message.get("approved") is True


def process_request(command: str) -> None:
    if pyautogui is None:
        raise RuntimeError("PyAutoGUI is unavailable; install requirements.txt")
    pyautogui.FAILSAFE = True
    screenshot = pyautogui.screenshot()
    action = plan_action(command, screenshot)
    if action.name == "none":
        emit({"type": "status", "message": "No safe action proposed."})
    elif action.name == "clear_visual":
        emit({"type": "clear_visual"})
        emit({"type": "status", "message": "Graphics overlay cleared."})
    elif action.name == "render_visual":
        emit({"type": "render_visual", "html_payload": action.html_payload})
        emit({"type": "status", "message": "Isolated graphics payload sent to Electron overlay."})
    elif not wait_for_approval(action):
        emit({"type": "status", "message": "Desktop action cancelled."})
    else:
        # Give the user a brief final opportunity to move the pointer to a corner.
        time.sleep(0.5)
        pyautogui.FAILSAFE = True
        if action.name == "click":
            pyautogui.click(action.x, action.y)
            emit({"type": "status", "message": f"Clicked at ({action.x}, {action.y})."})
        elif action.name == "type":
            pyautogui.write(action.text, interval=0.02)
            emit({"type": "status", "message": "Typed the requested text."})


def _handle_hotkey() -> None:
    try:
        import pyttsx3
        import speech_recognition as sr
        emit({"type": "status", "message": "Listening…"})
        speaker = pyttsx3.init()
        speaker.say("Listening...")
        speaker.runAndWait()
        speaker.stop()
        recognizer = sr.Recognizer()
        with sr.Microphone() as microphone:
            log("Listening for one short request...")
            recognizer.adjust_for_ambient_noise(microphone, duration=0.2)
            audio = recognizer.listen(microphone, timeout=8, phrase_time_limit=12)
        transcript = recognizer.recognize_google(audio)
        log(f"Recognized request: {transcript}")
        emit({"type": "status", "message": "Thinking…"})
        process_request(transcript)
    except Exception as exc:
        if pyautogui is not None and isinstance(exc, pyautogui.FailSafeException):
            emit({"type": "failsafe", "message": "PyAutoGUI emergency failsafe activated."})
            raise SystemExit(2)
        emit({"type": "error", "message": str(exc)[:500]})


_REQUEST_LOCK = threading.Lock()


def on_hotkey() -> None:
    if not _REQUEST_LOCK.acquire(blocking=False):
        emit({"type": "status", "message": "A request is already being processed."})
        return
    try:
        _handle_hotkey()
    finally:
        _REQUEST_LOCK.release()


def main() -> None:
    config_dir = os.getenv("HEYCLICKY_CONFIG_DIR", os.path.dirname(__file__))
    user_config = os.path.join(config_dir, ".env")
    if os.path.isfile(user_config):
        load_dotenv(user_config, override=False)
    # In development, keep the documented project-local .env as a fallback.
    if config_dir != os.path.dirname(__file__):
        load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=False)
    if pyautogui is None:
        emit({"type": "error", "message": "PyAutoGUI missing; install dependencies with pip install -r requirements.txt"})
        raise SystemExit(1)
    pyautogui.FAILSAFE = True
    try:
        import keyboard
    except ImportError:
        emit({"type": "error", "message": "keyboard package missing; install requirements.txt"})
        raise SystemExit(1)
    try:
        provider, _key, model = select_provider()
    except RuntimeError as exc:
        emit({"type": "error", "message": str(exc)})
        raise SystemExit(1)
    emit({"type": "status", "message": f"Ready. Provider: {provider}, model: {model}. Press Ctrl+Shift+Space."})
    threading.Thread(target=read_electron_commands, daemon=True).start()
    keyboard.add_hotkey("ctrl+shift+space", on_hotkey, suppress=False)
    keyboard.add_hotkey("ctrl+shift+esc", lambda: emit({"type": "shutdown"}), suppress=False)
    try:
        keyboard.wait()
    except KeyboardInterrupt:
        emit({"type": "status", "message": "Backend stopped."})


if __name__ == "__main__":
    main()
