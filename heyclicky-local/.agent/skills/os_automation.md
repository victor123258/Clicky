# Native OS automation and safety

- Set `pyautogui.FAILSAFE = True` at import/startup and before actions. A pointer move to a screen corner must raise the emergency exception and cause Electron to quit.
- Do not execute arbitrary model text, commands, or shortcuts. Only validated `click`, `type`, `render_visual`, `clear_visual`, and `none` actions are supported.
- For click/type, send a confirmation request over JSONL to Electron and wait for native user approval. Cancel by default. After approval wait 0.5 seconds, then perform one bounded action.
- Do not automate passwords, payment details, destructive operations, security settings, or sensitive data. Keep the full-screen graphics surface click-through. The separate top-center notch only exposes voice request, clear, and quit controls.
- `render_visual` runs in a sandboxed, opaque-origin iframe with no Electron APIs or network access. The sandbox is defense in depth, not permission to send secrets to generated code.
