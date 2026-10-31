"""Focused regression tests for voice capture and model reply handling.

The native microphone, screen, and cloud providers are mocked so this suite
runs on CI without an audio device, API key, or network access.
"""
import importlib.util
import queue
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


# Stub only packages unrelated to the tested functions at module load.
dotenv = types.ModuleType("dotenv")
dotenv.load_dotenv = lambda *args, **kwargs: None
pil = types.ModuleType("PIL")
pil_image = types.ModuleType("PIL.Image")
pil_image.Image = object
pil_image.Resampling = types.SimpleNamespace(LANCZOS=1)
pil.Image = pil_image
sys.modules.setdefault("dotenv", dotenv)
sys.modules.setdefault("PIL", pil)
sys.modules.setdefault("PIL.Image", pil_image)
sys.modules.setdefault("pyautogui", None)

ENGINE_PATH = Path(__file__).resolve().parents[1] / "engine.py"
spec = importlib.util.spec_from_file_location("heyclicky_engine_test", ENGINE_PATH)
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)


class VoiceCaptureTests(unittest.TestCase):
    def _speech_module(self, microphone, recognizer):
        module = types.ModuleType("speech_recognition")
        module.Recognizer = lambda: recognizer
        module.Microphone = lambda: microphone
        module.WaitTimeoutError = type("WaitTimeoutError", (Exception,), {})
        module.UnknownValueError = type("UnknownValueError", (Exception,), {})
        module.RequestError = type("RequestError", (Exception,), {})
        return module

    def test_capture_transcribes_even_when_optional_tts_fails(self):
        class Mic:
            def __enter__(self): return self
            def __exit__(self, *args): return False

        class Recognizer:
            pause_threshold = 0
            non_speaking_duration = 0
            operation_timeout = 0
            def adjust_for_ambient_noise(self, _microphone, duration): self.calibration = duration
            def listen(self, _microphone, **kwargs): self.listen_args = kwargs; return "audio-bytes"
            def recognize_google(self, audio, language):
                self.recognition_args = (audio, language)
                return "  what is this window?  "

        recognizer = Recognizer()
        fake_sr = self._speech_module(Mic(), recognizer)
        fake_tts = types.ModuleType("pyttsx3")
        fake_tts.init = lambda: (_ for _ in ()).throw(RuntimeError("SAPI driver unavailable"))
        with patch.dict(sys.modules, {"speech_recognition": fake_sr, "pyttsx3": fake_tts}), \
             patch.dict(engine.os.environ, {"HEYCLICKY_SPEECH_LANGUAGE": "bn-BD"}), \
             patch.object(engine, "emit"):
            self.assertEqual(engine.transcribe_once(), "what is this window?")
        self.assertEqual(recognizer.listen_args["timeout"], 10)
        self.assertEqual(recognizer.listen_args["phrase_time_limit"], 15)
        self.assertEqual(recognizer.recognition_args, ("audio-bytes", "bn-BD"))

    def test_no_speech_gets_actionable_error(self):
        class Mic:
            def __enter__(self): return self
            def __exit__(self, *args): return False

        class Recognizer:
            def adjust_for_ambient_noise(self, *_args, **_kwargs): pass
            def listen(self, *_args, **_kwargs): raise fake_sr.WaitTimeoutError()

        fake_sr = self._speech_module(Mic(), Recognizer())
        with patch.dict(sys.modules, {"speech_recognition": fake_sr}), patch.object(engine, "emit"):
            with self.assertRaisesRegex(RuntimeError, "No speech heard"):
                engine.transcribe_once()

    def test_microphone_permission_error_is_explained(self):
        class Mic:
            def __enter__(self): raise OSError("device access denied")
            def __exit__(self, *args): return False

        class Recognizer:
            def adjust_for_ambient_noise(self, *_args, **_kwargs): pass

        fake_sr = self._speech_module(Mic(), Recognizer())
        with patch.dict(sys.modules, {"speech_recognition": fake_sr}), patch.object(engine, "emit"):
            with self.assertRaisesRegex(RuntimeError, "Privacy & security → Microphone"):
                engine.transcribe_once()

    def test_capture_hides_ui_before_screenshot_and_restores_it_after(self):
        events = []
        screen = types.SimpleNamespace(screenshot=lambda: "desktop image")
        commands = queue.Queue()

        def emit(message):
            events.append(message)
            if message["type"] == "capture_request":
                commands.put({"type": "capture_ready", "id": message["id"]})

        with patch.object(engine, "emit", side_effect=emit), \
             patch.object(engine, "COMMAND_QUEUE", commands), \
             patch.object(engine, "pyautogui", screen):
            self.assertEqual(engine.capture_screen_without_clicky(), "desktop image")
        self.assertEqual([event["type"] for event in events], ["capture_request", "capture_done"])
        self.assertEqual(events[0]["id"], events[1]["id"])

    def test_reply_action_is_validated_and_preserved(self):
        action = engine.parse_action('{"action":"reply","text":"A concise explanation."}', (800, 600))
        self.assertEqual(action.name, "reply")
        self.assertEqual(action.text, "A concise explanation.")
        with self.assertRaisesRegex(ValueError, "Reply must contain"):
            engine.parse_action('{"action":"reply","text":""}', (800, 600))


if __name__ == "__main__":
    unittest.main()
