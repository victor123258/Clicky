# HeyClicky for Windows

HeyClicky is a native Electron desktop assistant with a Python speech/vision backend and a separate, isolated graphics overlay. It does not use Ollama or other local LLMs.

## One-click installer

The Windows installer is built by the repository workflow at `../.github/workflows/windows-installer.yml`.

- Pushes to `main` trigger a Windows installer build and GitHub release upload.
- The per-user NSIS installer bundles Electron, Three.js, and a PyInstaller-built Python backend. End users do not need Node.js or Python installed.
- On first launch, choose Gemini or OpenRouter and enter your own API key. Getting a key requires an account with the selected provider. Windows may show SmartScreen warnings because this project does not include a paid code-signing certificate.

## Use

The top-center notch is the app's home: hover for a quick peek, click to open Home, Chat, or Settings, and collapse it when you want it out of the way. Ask a typed question in Chat or tap the microphone / press **Ctrl+Shift+Space** to speak. Voice input waits for a phrase and transcribes it with SpeechRecognition's Google Web Speech service; no text-to-speech engine is required for capture. The app hides its notch and graphics overlay while taking a screenshot so Clicky does not become its own screen context. Click/type desktop actions require confirmation in a native dialog and wait 0.5 seconds before execution. Move the pointer to a screen corner to activate PyAutoGUI's emergency failsafe. Press **Ctrl+Shift+Esc** to exit.

In **Settings → Test microphone**, run a local capture/transcription test without an AI key or AI request. The onboarding window also offers the same test before connecting a key. Audio is still sent to Google's speech service for transcription. If the test fails, use its error details, check Windows **Settings → Privacy & security → Microphone** (including desktop-app access), confirm a default input device is selected, and check your internet connection. Speech recognition defaults to English (US), with selectable English (UK), Bengali (Bangladesh), Hindi, Urdu, Spanish (Mexico), French, and German in Settings. The chosen language is saved locally and applies to the global shortcut and the microphone test.

## Build locally on Windows

Requirements: Windows x64, Node.js 22+, Python 3.12+, and a working microphone/audio input.

```powershell
cd heyclicky-local
npm ci
npm run build:win
```

The installer appears in `release/`. `npm start` runs the development app from source instead. The bundled engine uses PyInstaller and runtime dependencies from `requirements.txt`. Run `npm run smoke:graphics` to render and read back a real WebGL pixel from the sandboxed Three.js frame in Electron, using SwiftShader so no physical GPU or API key is needed; Windows CI runs this before packaging.

## Privacy and security

Screenshots and prompts are sent to the configured Gemini or OpenRouter endpoint. Google's speech-recognition service receives microphone audio for transcription. Provider free tiers, quotas, signup requirements, and prices can change; this project cannot guarantee those services remain free. The microphone test does not use the AI provider, but it does send captured audio to Google's transcription service. Do not automate credentials, payments, destructive operations, security settings, or sensitive screens.

The graphics surface is transparent, frameless, and always-on-top. It remains click-through by default. To manipulate a 3D visual, open Settings → 3D object interaction; this temporarily captures mouse input across the full-screen overlay so dragging rotates the scene and the wheel zooms. While enabled, clicks do not reach apps underneath; press Escape or turn the mode off to restore click-through. Model-generated HTML/SVG/Three.js runs in an opaque-origin sandboxed iframe with no network access, same-origin access, or Electron bridge. Graphics scripts are untrusted and may consume CPU/GPU resources; payload size is capped. The app does not claim that generated scripts are risk-free.
