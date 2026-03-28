const BASE = window.location.origin;
let currentKey = "";
let currentEncoder = "bela";

document.querySelectorAll(".encoder-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentEncoder = btn.dataset.encoder;
    document.querySelectorAll(".encoder-btn").forEach((b) => {
      const active = b === btn;
      b.style.background = active
        ? "linear-gradient(135deg,#facc15,#22d3ee)"
        : "";
      b.classList.toggle("text-black", active);
      b.classList.toggle("font-bold", active);
      b.classList.toggle("text-white/50", !active);
      b.classList.toggle("bg-white/5", !active);
      b.classList.toggle("border-transparent", active);
    });
    if (currentKey) updateCommands(currentKey);
  });
});
document.querySelector(".encoder-btn")?.click();

let currentUninstallEncoder = "bela";

function updateUninstallCmd() {
  document.getElementById("uninstall-standalone-cmd").textContent =
    `curl -fsSL ${BASE}/encoders/${currentUninstallEncoder}/scripts/uninstall | sudo bash`;
}

document.querySelectorAll(".uninstall-encoder-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentUninstallEncoder = btn.dataset.encoder;
    document.querySelectorAll(".uninstall-encoder-btn").forEach((b) => {
      const active = b === btn;
      b.style.background = active
        ? "linear-gradient(135deg,#facc15,#22d3ee)"
        : "";
      b.classList.toggle("text-black", active);
      b.classList.toggle("font-bold", active);
      b.classList.toggle("text-white/50", !active);
      b.classList.toggle("bg-white/5", !active);
      b.classList.toggle("border-transparent", active);
    });
    updateUninstallCmd();
  });
});
document.querySelector(".uninstall-encoder-btn")?.click();

document.getElementById("btn-generate").addEventListener("click", generateKey);
document.getElementById("device-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") generateKey();
});

function makeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 16)}-${hex.slice(16)}`;
}
document
  .getElementById("btn-copy-key")
  .addEventListener("click", () => copyText(currentKey, "btn-copy-key"));
document
  .getElementById("btn-copy-cmd")
  .addEventListener("click", () =>
    copyText(
      document.getElementById("install-cmd-display").textContent,
      "btn-copy-cmd",
    ),
  );
document
  .getElementById("btn-copy-uninstall")
  .addEventListener("click", () =>
    copyText(
      document.getElementById("uninstall-cmd-display").textContent,
      "btn-copy-uninstall",
    ),
  );
document
  .getElementById("btn-copy-uninstall-standalone")
  .addEventListener("click", () =>
    copyText(
      document.getElementById("uninstall-standalone-cmd").textContent.trim(),
      "btn-copy-uninstall-standalone",
    ),
  );

function generateKey() {
  const name = document.getElementById("device-name").value.trim();
  hideError();
  currentKey = makeKey();
  showResult(currentKey, name);
  document.getElementById("btn-generate").innerHTML =
    `<svg width="18" height="18"><use href="#ic-plus"/></svg> Generate Another Key`;
}

function updateCommands(key) {
  document.getElementById("install-cmd-display").textContent =
    `curl -fsSL ${BASE}/encoders/${currentEncoder}/scripts/install | sudo bash -s -- ${key}`;
  document.getElementById("uninstall-cmd-display").textContent =
    `curl -fsSL ${BASE}/encoders/${currentEncoder}/scripts/uninstall | sudo bash`;
  document.getElementById("control-link").href =
    `${BASE}/control/${currentEncoder}/${key}`;
}

function showResult(key, name) {
  document.getElementById("device-key-display").textContent = key;
  updateCommands(key);
  document.getElementById("result-block").classList.remove("hidden");
  saveDevice(key, name);
  renderSavedDevices();
}

function savedDevices() {
  try {
    return JSON.parse(localStorage.getItem("rencoder_devices") ?? "[]");
  } catch {
    return [];
  }
}

function saveDevice(key, name) {
  const devices = savedDevices().filter((d) => d.key !== key);
  devices.unshift({
    key,
    name: name || null,
    addedAt: new Date().toISOString(),
  });
  localStorage.setItem(
    "rencoder_devices",
    JSON.stringify(devices.slice(0, 20)),
  );
}

async function copyText(text, btnId) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement("textarea"), {
      value: text,
      style: "position:fixed;opacity:0",
    });
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  flashCheck(btnId);
}

function flashCheck(btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.innerHTML = `<svg width="16" height="16" style="color:#22d3ee"><use href="#ic-check"/></svg>`;
  setTimeout(() => {
    btn.innerHTML = orig;
  }, 2000);
}

function renderSavedDevices() {
  const list = document.getElementById("saved-devices-list");
  const section = document.getElementById("saved-devices-section");
  if (!list || !section) return;
  const devices = savedDevices();
  if (devices.length === 0) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");
  list.innerHTML = devices
    .map(
      (d) => `
    <div class="flex items-center gap-3 py-3 border-b border-white/[0.05] last:border-0">
      <div class="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
        <svg width="14" height="14" class="text-white/40"><use href="#ic-wifi"/></svg>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold truncate">${escHtml(d.name || "Unnamed Device")}</p>
        <p class="text-[11px] text-white/30 font-mono truncate">${escHtml(d.key)}</p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <a href="${BASE}/control/${encodeURIComponent(d.encoder ?? "bela")}/${encodeURIComponent(d.key)}" class="btn-ghost text-xs px-3 py-1.5">Control →</a>
        <button onclick="removeDevice('${escHtml(d.key)}')" class="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-colors">
          <svg width="13" height="13"><use href="#ic-x"/></svg>
        </button>
      </div>
    </div>`,
    )
    .join("");
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function removeDevice(key) {
  const devices = savedDevices().filter((d) => d.key !== key);
  localStorage.setItem("rencoder_devices", JSON.stringify(devices));
  renderSavedDevices();
}

renderSavedDevices();

function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  document.getElementById("error-block").classList.remove("hidden");
}

function hideError() {
  document.getElementById("error-block").classList.add("hidden");
}
