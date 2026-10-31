"use strict";

let provider = "gemini";
const form = document.getElementById("setup-form");
const input = document.getElementById("api-key");
const label = document.getElementById("key-label");
const help = document.getElementById("key-help");
const error = document.getElementById("error");
const saveButton = document.getElementById("save-button");

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    provider = tab.dataset.provider;
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    label.textContent = provider === "gemini" ? "Gemini API key" : "OpenRouter API key";
    help.textContent = provider === "gemini"
      ? "Get a key at aistudio.google.com. Gemini is selected by default when both providers are configured."
      : "Get a key at openrouter.ai/keys. The default model is google/gemini-2.5-flash:free.";
    input.value = "";
    input.placeholder = provider === "gemini" ? "Paste Gemini key" : "Paste OpenRouter key";
    error.textContent = "";
  });
}

document.getElementById("toggle-key").addEventListener("click", (event) => {
  input.type = input.type === "password" ? "text" : "password";
  event.currentTarget.textContent = input.type === "password" ? "Show" : "Hide";
});

const micButton = document.getElementById("setup-mic-test");
const micResult = document.getElementById("setup-mic-result");
micButton.addEventListener("click", () => {
  micButton.disabled = true;
  micResult.textContent = "Opening microphone…";
  window.heyclickySetup.testMicrophone();
});
window.heyclickySetup.onMicrophoneTest((result) => {
  micButton.disabled = false;
  micResult.textContent = result?.ok
    ? `Heard: “${String(result.text || "").slice(0, 80)}”`
    : String(result?.error || "Microphone test failed.");
  micResult.style.color = result?.ok ? "#bde99a" : "#ffb0a7";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  const key = input.value.trim();
  if (!key) { error.textContent = "Paste an API key to continue."; return; }
  saveButton.disabled = true;
  saveButton.firstChild.textContent = "Saving securely… ";
  try {
    const result = await window.heyclickySetup.saveApiConfig({
      provider,
      gemini: provider === "gemini" ? key : "",
      openrouter: provider === "openrouter" ? key : ""
    });
    if (!result || !result.ok) throw new Error("Could not save configuration.");
  } catch (exception) {
    error.textContent = exception.message || "Could not save the key.";
    saveButton.disabled = false;
    saveButton.firstChild.textContent = "Save key & launch HeyClicky ";
  }
});
