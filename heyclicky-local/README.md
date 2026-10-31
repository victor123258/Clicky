# HeyClicky for Windows

HeyClicky is a native Electron desktop assistant with a bundled Python backend and isolated graphics overlay. It does not use Ollama or other local LLMs.

## One-click installer

The Windows installer is built by the repository workflow at `../.github/workflows/windows-installer.yml`.

- Run the workflow manually to get a downloadable installer artifact under the workflow's **Artifacts** section.
- Push a version tag such as `v1.0.0` to publish the installer as a GitHub Release asset.
- The installer is configured as a per-user, one-click NSIS install and launches the app after installation.

The installer bundles Electron, Three.js, and a PyInstaller-built Python backend, so end users do not need Node.js or Python installed. The first launch opens a setup window for one Gemini or OpenRouter API key; obtaining that key still requires an account with the selected provider. Windows may show SmartScreen warnings because this project does not include a paid code-signing certificate.

## Build locally on Windows

Requirements: Windows x64, Node.js 22+, Python 3.12+, and audio input support.

```powershell
cd heyclicky-local
npm ci
npm run build:win
```

The installer appears in `release/`. `npm start` runs the development app from source instead. The bundled engine build uses PyInstaller and the runtime dependencies in `requirements.txt`.

## First run and use

The first-run wizard stores the selected provider key in the current user's HeyClicky application-data folder. Click **Ask Clicky** in the visible top-center notch, or press **Ctrl+Shift+Space**, then speak one short request. The assistant announces “Listening...”, transcribes one bounded phrase through SpeechRecognition's Google Web Speech service, captures the desktop, and requests one action from Gemini or OpenRouter. Click/type actions require confirmation in a native dialog and wait 0.5 seconds before execution. Move the pointer to a screen corner to activate PyAutoGUI's emergency failsafe. Press **Ctrl+Shift+Esc** to exit.

## Privacy and security

Screenshots and voice transcripts are sent to the configured cloud providers. Google's speech-recognition wrapper also sends microphone audio to Google. Provider free tiers, quotas, signup requirements, and prices can change; the project cannot guarantee those services remain free. Do not automate credentials, payments, destructive operations, security settings, or sensitive screens.

A visible floating notch/pill sits at the top center with Ask Clicky, status, Clear graphics, and Quit controls. The graphics surface itself is transparent, frameless, always-on-top, and click-through. Model-generated HTML/SVG/Three.js runs in an opaque-origin sandboxed iframe with no network, same-origin access, or Electron bridge. Graphics scripts are still untrusted and may consume CPU/GPU resources; payload size is capped. The app does not claim that generated scripts are risk-free.
