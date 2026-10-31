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
{"action":"reply","text":"A concise, helpful answer grounded in the screenshot and request."}
{"action":"none"}
Coordinates are integer pixels within the screenshot. Click/type actions require explicit user confirmation. Use reply for questions or explanations; use none only when no useful response is safe. Never request secrets, passwords, payment details, destructive actions, or security changes.
For a graphic, return a self-contained HTML or SVG fragment. Choose SVG for flat diagrams and icons; when the user asks for 3D, make a genuine Three.js scene rather than a 2D drawing or CSS perspective trick. Use only the trusted global `window.THREE` supplied by the isolated overlay (inside one `<script type="module">`); do not add imports, CDNs, external assets, or network requests. The visual runs in a transparent, opaque-origin sandboxed iframe with no network access, Electron privileges, or access to the parent page.

For 3D quality, build a recognizable subject from real Three.js geometry and layered details, with a deliberate composition, readable silhouette, perspective camera framed so the subject is fully visible and fills roughly 55–75% of the viewport, coherent materials/colors, soft key/fill/rim lighting, and depth cues. Use smooth shading where appropriate and subtle animation that preserves the subject's readability. Make the first frame visible immediately. Instantiate `new window.THREE.WebGLRenderer({ alpha: true, antialias: true })`, append its canvas, set a fully transparent clear color, and render a visible first frame before starting any animation. Keep the background transparent so the desktop remains visible; cap pixel ratio at 2 and update renderer size and camera aspect on resize. Prefer built-in geometry and procedural details over external textures. Keep triangle counts and animation work modest, reuse objects in the animation loop, and avoid excessive lights, shadows, loops, or allocations. Keep the fragment compact and valid; do not wrap it in `<html>` or `<body>` tags. Never include credentials or attempt to access the host outside the graphics sandbox.'''


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
    if name == "reply":
        value = payload.get("text")
        if not isinstance(value, str) or not value.strip() or len(value) > 6000:
            raise ValueError("Reply must contain 1–6,000 characters")
        return Action("reply", text=value.strip())
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
        if kind in {"approval", "capture_ready"}:
            COMMAND_QUEUE.put(message)
        elif kind == "voice_request":
            threading.Thread(target=on_hotkey, daemon=True).start()
        elif kind == "text_request":
            text = message.get("text")
            if isinstance(text, str) and text.strip():
                threading.Thread(target=on_text_request, args=(text[:2000],), daemon=True).start()
        elif kind == "mic_test":
            threading.Thread(target=on_mic_test, daemon=True).start()
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


def capture_screen_without_clicky() -> Image.Image:
    """Hide the native UI before capture so the model sees the user's desktop, not Clicky."""
    import uuid
    capture_id = uuid.uuid4().hex
    emit({"type": "capture_request", "id": capture_id})
    deadline = time.monotonic() + 10
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Screen capture could not hide the Clicky overlay. Please try again.")
        try:
            message = COMMAND_QUEUE.get(timeout=remaining)
        except queue.Empty as exc:
            raise TimeoutError("Timed out while preparing a screen capture. Please try again.") from exc
        if message.get("type") == "capture_ready" and message.get("id") == capture_id:
            break
    try:
        return pyautogui.screenshot()
    finally:
        emit({"type": "capture_done", "id": capture_id})


def process_request(command: str) -> None:
    if pyautogui is None:
        raise RuntimeError("PyAutoGUI is unavailable; install requirements.txt")
    pyautogui.FAILSAFE = True
    screenshot = capture_screen_without_clicky()
    action = plan_action(command, screenshot)
    if action.name == "reply":
        emit({"type": "assistant_reply", "text": action.text})
        emit({"type": "status", "message": "Ready when you are."})
    elif action.name == "none":
        emit({"type": "assistant_reply", "text": "I couldn’t find a safe, useful next step from that request. You can rephrase it or ask me to explain what’s on screen."})
        emit({"type": "status", "message": "Ready when you are."})
    elif action.name == "clear_visual":
        emit({"type": "clear_visual"})
        emit({"type": "assistant_reply", "text": "I cleared the visual from your desktop."})
        emit({"type": "status", "message": "Graphics overlay cleared."})
    elif action.name == "render_visual":
        emit({"type": "render_visual", "html_payload": action.html_payload})
        emit({"type": "assistant_reply", "text": "I sent the visual to the transparent graphics overlay. I’ll alert you if the scene fails to render."})
        emit({"type": "status", "message": "Graphics payload sent to isolated Electron frame."})
    elif not wait_for_approval(action):
        emit({"type": "assistant_reply", "text": "No changes made — the desktop action was cancelled."})
        emit({"type": "status", "message": "Desktop action cancelled."})
    else:
        # Give the user a brief final opportunity to move the pointer to a corner.
        time.sleep(0.5)
        pyautogui.FAILSAFE = True
        if action.name == "click":
            pyautogui.click(action.x, action.y)
            emit({"type": "assistant_reply", "text": f"Done — I clicked at ({action.x}, {action.y})."})
            emit({"type": "status", "message": f"Clicked at ({action.x}, {action.y})."})
        elif action.name == "type":
            pyautogui.write(action.text, interval=0.02)
            emit({"type": "assistant_reply", "text": "Done — I typed the requested text."})
            emit({"type": "status", "message": "Typed the requested text."})


def announce_listening() -> None:
    """Give a best-effort spoken cue, but never let a TTS driver block the mic."""
    finished = threading.Event()

    def speak() -> None:
        try:
            import pyttsx3
            speaker = pyttsx3.init()
            speaker.say("Listening")
            speaker.runAndWait()
            speaker.stop()
        except Exception as exc:
            log(f"Optional voice cue unavailable; continuing with microphone capture: {exc}")
        finally:
            finished.set()

    threading.Thread(target=speak, name="optional-voice-cue", daemon=True).start()
    if not finished.wait(timeout=1.5):
        log("Optional voice cue timed out; continuing with microphone capture.")


def transcribe_once() -> str:
    """Capture one phrase and transcribe it; speech output is best-effort only."""
    try:
        import speech_recognition as sr
    except ImportError as exc:
        raise RuntimeError("SpeechRecognition is missing. Reinstall HeyClicky so the voice components are included.") from exc

    recognizer = sr.Recognizer()
    recognizer.pause_threshold = 0.8
    recognizer.non_speaking_duration = 0.45
    recognizer.operation_timeout = 25
    announce_listening()
    try:
        with sr.Microphone() as microphone:
            log("Microphone opened; calibrating ambient audio.")
            recognizer.adjust_for_ambient_noise(microphone, duration=0.25)
            emit({"type": "status", "message": "Listening — speak now."})
            audio = recognizer.listen(microphone, timeout=10, phrase_time_limit=15)
    except sr.WaitTimeoutError as exc:
        raise RuntimeError("No speech heard. Check the selected microphone, then speak after ‘Listening’ appears.") from exc
    except (OSError, AttributeError) as exc:
        raise RuntimeError(f"Could not open the microphone ({exc}). Check Windows Settings → Privacy & security → Microphone, allow desktop apps, and set a default input device.") from exc
    except Exception as exc:
        if "pyaudio" in str(exc).lower() or "audio" in str(exc).lower():
            raise RuntimeError(f"The microphone audio driver could not start ({exc}). Check Windows microphone privacy access and the default input device.") from exc
        raise

    try:
        transcript = recognizer.recognize_google(audio, language=os.getenv("HEYCLICKY_SPEECH_LANGUAGE", "en-US"))
    except sr.UnknownValueError as exc:
        raise RuntimeError("I didn’t catch that. Move closer to the microphone and try again.") from exc
    except sr.RequestError as exc:
        raise RuntimeError(f"Google speech transcription failed: {exc}. Check your internet connection and try the microphone test again.") from exc
    if not transcript or not transcript.strip():
        raise RuntimeError("No speech was recognized. Try again and speak a little closer to your microphone.")
    return transcript.strip()


def _handle_hotkey() -> None:
    try:
        # The global shortcut is still registered during first-run setup so the
        # local microphone test works, but a real request must never capture a
        # screenshot unless an AI provider is configured.
        select_provider()
        transcript = transcribe_once()
        log(f"Recognized request: {transcript}")
        emit({"type": "transcript", "text": transcript})
        emit({"type": "status", "message": "Thinking with your screen in context…"})
        process_request(transcript)
    except Exception as exc:
        if pyautogui is not None and isinstance(exc, pyautogui.FailSafeException):
            emit({"type": "failsafe", "message": "PyAutoGUI emergency failsafe activated."})
            raise SystemExit(2)
        emit({"type": "error", "message": str(exc)[:500]})


_REQUEST_LOCK = threading.Lock()


def on_hotkey() -> None:
    if not _REQUEST_LOCK.acquire(blocking=False):
        emit({"type": "busy_notice", "message": "Clicky is already working on a request."})
        return
    try:
        _handle_hotkey()
    finally:
        _REQUEST_LOCK.release()


def on_text_request(text: str) -> None:
    if not _REQUEST_LOCK.acquire(blocking=False):
        emit({"type": "request_rejected", "source": "text", "message": "Clicky is already working on another request. Your message was not sent; please retry when it is ready."})
        return
    try:
        emit({"type": "status", "message": "Thinking with your screen in context…"})
        process_request(text)
    except Exception as exc:
        if pyautogui is not None and isinstance(exc, pyautogui.FailSafeException):
            emit({"type": "failsafe", "message": "PyAutoGUI emergency failsafe activated."})
            raise SystemExit(2)
        emit({"type": "error", "message": str(exc)[:500]})
    finally:
        _REQUEST_LOCK.release()


def on_mic_test() -> None:
    if not _REQUEST_LOCK.acquire(blocking=False):
        emit({"type": "mic_test_result", "ok": False, "error": "Another request is already using the microphone. Wait for it to finish and try again."})
        return
    try:
        text = transcribe_once()
        emit({"type": "mic_test_result", "ok": True, "text": text})
        emit({"type": "status", "message": "Microphone test passed."})
    except Exception as exc:
        error = str(exc)[:500]
        emit({"type": "mic_test_result", "ok": False, "error": error})
        emit({"type": "error", "message": error})
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
        startup_status = f"Ready. Provider: {provider}, model: {model}. Press Ctrl+Shift+Space."
    except RuntimeError:
        # The no-key microphone test is useful during first-run setup.
        startup_status = "Voice test ready. Connect a provider key to use screen context."
    emit({"type": "status", "message": startup_status})
    threading.Thread(target=read_electron_commands, daemon=True).start()
    keyboard.add_hotkey("ctrl+shift+space", on_hotkey, suppress=False)
    keyboard.add_hotkey("ctrl+shift+esc", lambda: emit({"type": "shutdown"}), suppress=False)
    try:
        keyboard.wait()
    except KeyboardInterrupt:
        emit({"type": "status", "message": "Backend stopped."})


if __name__ == "__main__":
    main()
