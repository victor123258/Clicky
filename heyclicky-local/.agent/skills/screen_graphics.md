# Native screen vision and graphics overlay

- Capture the real desktop through PyAutoGUI. Convert to RGB, resize only when larger than 1920 px on an edge, and encode a quality-88 progressive JPEG with Pillow.
- Send the JPEG and spoken request to the active cloud vision provider (Gemini GenAI SDK or OpenRouter HTTPS). Keep API keys only in ignored `.env`; never expose them to Electron renderer content.
- Parse a bounded JSON object and validate action-specific fields. Click coordinates must lie inside the sent image and are rescaled to desktop dimensions. Click/type actions always require explicit native confirmation.
- A `render_visual` action is forwarded over the Python stdout JSONL protocol to Electron IPC. It is rendered in a fresh `sandbox="allow-scripts"` opaque-origin iframe with no same-origin access, network, forms, top navigation, Electron bridge, or API credentials. Payload size is capped.
- A separate visible top-center control pill provides Ask Clicky, status, clear, and quit controls. The graphics overlay remains transparent, frameless, always-on-top, and click-through. It supports HTML/SVG and a bundled local Three.js module. Do not relax the iframe sandbox/CSP or expose privileged APIs to model output.
- Generated JavaScript remains untrusted and can consume renderer resources despite isolation. Enforce payload limits and clear/recreate the frame when replacing visuals. Do not use it for sensitive information.
- Gemini/OpenRouter free-tier terms, quota, signup requirements, and availability can change; the app cannot guarantee they remain free.
