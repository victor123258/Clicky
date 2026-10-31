# Native hotkey and voice input

- Load API configuration from the local `.env` file when the backend starts.
- Bind Ctrl+Shift+Space with the Python `keyboard` package. Prevent overlapping requests with a lock.
- On activation, speak “Listening...” locally through `pyttsx3`, capture one bounded phrase from the microphone, and transcribe it with SpeechRecognition's Google Web Speech wrapper.
- This speech-recognition path requires internet and sends microphone audio to Google's service. It is not offline STT. Keep the listening window short, report errors, and never interpret speech as shell code.
- Capture a screenshot only after a transcript is received. Ensure the user understands that both transcript and desktop image are sent to their configured vision API.
