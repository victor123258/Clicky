"use strict";

const api = window.heyclickyControls;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};
let route = "home";
let lastState = "ready";
let messages = [];
let sending = false;
let statusTimer;
let graphicsInteractionEnabled = false;

function refreshProviderStatus() {
  api.getProviderStatus().then((status) => { $("#provider-label").textContent = status; })
    .catch(() => { $("#provider-label").textContent = "Could not read provider settings."; });
}
function updateGraphicsInteraction(enabled) {
  graphicsInteractionEnabled = Boolean(enabled);
  const button = $("#graphics-interaction-toggle");
  button.setAttribute("aria-pressed", String(graphicsInteractionEnabled));
  button.textContent = graphicsInteractionEnabled ? "Stop interacting" : "Enable interaction";
  $("#notch").dataset.interaction = String(graphicsInteractionEnabled);
  $("#graphics-interaction-stop").style.display = graphicsInteractionEnabled ? "grid" : "none";
}
function navigate(next) {
  route = next;
  $$('[id^="route-"]').forEach((page) => { page.hidden = page.id !== `route-${next}`; });
  $$('[data-route]').forEach((button) => button.classList.toggle("active", button.dataset.route === next));
  if (next === "chat") {
    renderMessages();
    setTimeout(() => $("#prompt").focus(), 80);
  }
  if (next === "settings") refreshProviderStatus();
}
function addMessage(role, text, pending = false) {
  messages.push({ role, text: String(text), pending });
  if (messages.length > 60) messages = messages.slice(-60);
  renderMessages();
  renderRecent();
}
function renderMessages() {
  const thread = $("#thread");
  const nodes = [];
  if (!messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome-message";
    const mark = document.createElement("span");
    mark.className = "welcome-mark";
    mark.append(icon("mark"));
    const text = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = "Hey, I’m Clicky.";
    const body = document.createElement("p");
    body.textContent = "Ask me about what’s on screen, or tell me what you’d like help with.";
    text.append(title, body);
    welcome.append(mark, text);
    nodes.push(welcome);
  } else {
    for (const message of messages) {
      const row = document.createElement("div");
      row.className = `message ${message.role}${message.pending ? " pending" : ""}`;
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.append(icon(message.role === "user" ? "chat" : "mark"));
      const body = document.createElement("div");
      body.className = "message-body";
      body.textContent = message.text;
      row.append(avatar, body);
      nodes.push(row);
    }
  }
  thread.replaceChildren(...nodes);
  thread.scrollTop = thread.scrollHeight;
  $("#chat-count").textContent = String(messages.filter((message) => message.role === "user").length);
}
function renderRecent() {
  const list = $("#recent-list");
  if (!messages.length) {
    const row = document.createElement("div");
    row.className = "empty-row";
    const marker = document.createElement("span");
    marker.className = "empty-icon";
    marker.append(icon("spark"));
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = "A fresh start.";
    const detail = document.createElement("small");
    detail.textContent = "Your conversation appears here.";
    copy.append(title, detail);
    row.append(marker, copy);
    list.replaceChildren(row);
    return;
  }
  const latest = messages.slice(-4).reverse();
  list.replaceChildren(...latest.map((message) => {
    const row = document.createElement("div");
    row.className = "recent-message";
    const avatar = document.createElement("span");
    avatar.className = "empty-icon";
    avatar.append(icon(message.role === "user" ? "chat" : "mark"));
    const copy = document.createElement("span");
    copy.className = "recent-copy";
    const title = document.createElement("b");
    title.textContent = message.role === "user" ? "You" : "Clicky";
    const body = document.createElement("small");
    body.textContent = message.text.slice(0, 88) + (message.text.length > 88 ? "…" : "");
    copy.append(title, body);
    row.append(avatar, copy);
    return row;
  }));
}
function showNotice(message, kind = "warning") {
  const notice = $("#notice");
  notice.textContent = message;
  notice.hidden = false;
  notice.className = `notice ${kind}`;
  if (kind !== "warning") {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { notice.hidden = true; }, 6500);
  }
}
function sendText() {
  if (sending) return;
  if (lastState === "busy") {
    showNotice("Clicky is finishing another request. Please wait, then try again.", "info");
    return;
  }
  const field = $("#prompt");
  const text = field.value.trim();
  if (!text) { field.focus(); return; }
  field.value = "";
  sending = true;
  addMessage("user", text);
  addMessage("assistant", "Working on that…", true);
  api.sendText(text);
  $("#send").disabled = true;
  navigate("chat");
}
function removePending() {
  const last = messages.at(-1);
  if (last?.pending) messages.pop();
  sending = false;
  $("#send").disabled = lastState === "busy";
  $("#clear-chat").disabled = lastState === "busy";
}
function requestVoice() {
  if (lastState === "busy") return;
  if (route !== "chat") navigate("chat");
  api.requestVoice();
}

$("#expand").addEventListener("click", () => api.setLayout("expanded"));
$("#open-home").addEventListener("click", () => { navigate("home"); api.setLayout("expanded"); });
$("#collapse").addEventListener("click", () => api.setLayout("collapsed"));
$("#quit").addEventListener("click", () => api.quit());
$("#quick-talk").addEventListener("click", requestVoice);
$("#home-talk").addEventListener("click", requestVoice);
$("#chat-talk").addEventListener("click", requestVoice);
$("#home-chat").addEventListener("click", () => api.setLayout("expanded"));
$("#home-chat").addEventListener("click", () => navigate("chat"));
$("#send").addEventListener("click", sendText);
$("#prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendText(); }
});
const languageSelect = $("#voice-language");
let languageTouched = false;
languageSelect.addEventListener("change", async () => {
  languageTouched = true;
  const previous = languageSelect.dataset.saved || "en-US";
  languageSelect.disabled = true;
  try {
    const result = await api.setVoiceLanguage(languageSelect.value);
    languageSelect.dataset.saved = result.language;
    showNotice(`Speech language saved: ${languageSelect.selectedOptions[0].textContent}.`, "info");
  } catch (error) {
    languageSelect.value = previous;
    showNotice(error.message || "Could not save speech language.", "warning");
  } finally {
    languageSelect.disabled = false;
  }
});
api.getVoiceLanguage().then((language) => {
  if (!languageTouched && [...languageSelect.options].some((option) => option.value === language)) {
    languageSelect.value = language;
    languageSelect.dataset.saved = language;
  }
}).catch((error) => showNotice(error.message || "Could not load speech language.", "warning"));

$("#mic-test").addEventListener("click", () => {
  $("#mic-result").textContent = "Opening microphone…";
  $("#mic-result").style.color = "#cce7a3";
  api.testMicrophone();
});
$("#api-settings").addEventListener("click", () => api.openSetup());
$("#graphics-interaction-stop").addEventListener("click", async () => {
  try {
    updateGraphicsInteraction(await api.setGraphicsInteraction(false));
  } catch (error) {
    showNotice(error.message || "Could not exit 3D interaction mode.", "warning");
  }
});
$("#graphics-interaction-toggle").addEventListener("click", async () => {
  const button = $("#graphics-interaction-toggle");
  button.disabled = true;
  try {
    const enabled = await api.setGraphicsInteraction(!graphicsInteractionEnabled);
    updateGraphicsInteraction(enabled);
    showNotice(enabled
      ? "Interaction enabled: drag the 3D visual to rotate it. Escape restores click-through."
      : "Interaction disabled. Click-through is restored.", "info");
  } catch (error) {
    showNotice(error.message || "Could not change 3D interaction mode.", "warning");
  } finally {
    button.disabled = false;
  }
});
api.onGraphicsInteraction(updateGraphicsInteraction);
$("#mic-privacy").addEventListener("click", () => api.openMicrophonePrivacy());
$("#clear-visuals").addEventListener("click", () => api.clearVisual());
$("#clear-chat").addEventListener("click", () => {
  if (sending || lastState === "busy") {
    showNotice("Wait for the current request to finish before starting a new chat.", "info");
    return;
  }
  messages = [];
  sending = false;
  renderMessages();
  renderRecent();
});
$$('[data-route]').forEach((button) => button.addEventListener("click", () => navigate(button.dataset.route)));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") api.setLayout("collapsed");
});

api.onLayout((value) => {
  const mode = value?.mode || "collapsed";
  $("#notch").dataset.layout = mode;
  $("#peek").hidden = mode !== "peek";
  $("#workspace").hidden = mode !== "expanded";
});
api.onStatus((value) => {
  const message = String(value?.message || "Ready");
  lastState = value?.kind === "busy" ? "busy" : "ready";
  $("#send").disabled = sending || lastState === "busy";
  $("#clear-chat").disabled = sending || lastState === "busy";
  $("#status").textContent = message;
  $("#notch").classList.toggle("busy", lastState === "busy");
  $("#quick-talk").classList.toggle("busy", lastState === "busy");
  $("#quick-talk").setAttribute("aria-label", lastState === "busy" ? "Voice request in progress" : "Start a voice request");
  if (value?.kind !== "warning") $("#preview").textContent = "A little help, right where you are.";
  if (value?.kind === "warning") {
    $("#preview").textContent = message;
    showNotice(message, "warning");
    if (message.toLowerCase().includes("microphone")) {
      $("#mic-result").textContent = "Voice input failed — see message above";
      $("#mic-result").style.color = "#f0bc9c";
    }
    if (sending || messages.at(-1)?.pending) { removePending(); renderMessages(); }
  } else if (lastState === "busy") {
    $("#notice").hidden = true;
  }
});
api.onTranscript((value) => {
  const text = String(value?.text || "").trim();
  if (text) {
    removePending();
    sending = true;
    $("#send").disabled = true;
    $("#clear-chat").disabled = true;
    addMessage("user", text);
    addMessage("assistant", "Thinking…", true);
    navigate("chat");
  }
});
api.onReply((value) => {
  const text = String(value?.text || "").trim();
  if (!text) return;
  removePending();
  addMessage("assistant", text);
  if (route === "home") showNotice("Clicky replied in your chat.", "info");
});
api.onRequestRejected((value) => {
  if (sending) {
    removePending();
    if (messages.at(-1)?.role === "user") messages.pop();
    renderMessages();
    renderRecent();
  }
  showNotice(String(value?.message || "The request was not sent; please try again when Clicky is ready."), "warning");
});
api.onBusyNotice((value) => {
  showNotice(String(value?.message || "Clicky is already working on another request."), "info");
});
api.onMicTest((value) => {
  const result = $("#mic-result");
  result.textContent = value?.ok ? `Heard: “${String(value.text || "").slice(0, 110)}”` : String(value?.error || "Microphone test failed.");
  result.style.color = value?.ok ? "#cce7a3" : "#f0bc9c";
  if (!value?.ok) showNotice(result.textContent, "warning");
  else showNotice("Microphone and speech recognition are working. This test did not use your API key.", "info");
});

renderMessages();
refreshProviderStatus();
