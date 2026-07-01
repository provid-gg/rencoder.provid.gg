const KEY = location.pathname.split("/").pop() ?? "";
const ENCODER = location.pathname.split("/")[2] ?? "bpos";
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/viewer/${KEY}`;
const KEY_RE = /^[0-9a-f]{16,32}-[0-9a-f]{16,32}$/;

const escHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1500;
let deviceOnline = false;

const stream = {};
let links = [];
const system = {};

if (!KEY || !KEY_RE.test(KEY)) {
  showOverlayError("No valid device key in URL.");
} else {
  document.getElementById("key-display").textContent = KEY;
  connect();
}

function persistDevice(key, name) {
  try {
    const list = JSON.parse(localStorage.getItem("rencoder_devices") ?? "[]");
    const idx = list.findIndex((d) => d.key === key);
    if (idx === -1)
      list.unshift({
        key,
        encoder: ENCODER,
        name: name ?? null,
        addedAt: new Date().toISOString(),
      });
    else {
      list[idx].encoder = ENCODER;
      if (name) list[idx].name = name;
    }
    localStorage.setItem("rencoder_devices", JSON.stringify(list.slice(0, 20)));
  } catch {}
}

function connect() {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    reconnectDelay = 1500;
    setBadge("connecting");
  };
  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch {}
  };
  ws.onclose = () => {
    setDeviceOnline(false);
    setBadge("offline");
    scheduleReconnect();
  };
  ws.onerror = () => {};
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    setBadge("connecting");
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 10_000);
}

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ keepalive: null }));
}, 10_000);

function handleMessage(msg) {
  if (msg._rencoder) {
    handleMeta(msg._rencoder);
    return;
  }
  if (msg.name !== undefined) setDeviceName(msg.name);
  if (msg.version !== undefined) setVersion(msg.version);
  if (msg.stream !== undefined) {
    Object.assign(stream, msg.stream);
    renderStream();
  }
  if (msg.links !== undefined) {
    links = Array.isArray(msg.links) ? msg.links : [];
    renderLinks();
  }
  if (msg.system !== undefined) {
    Object.assign(system, msg.system);
    renderSystem();
  }
}

function handleMeta(meta) {
  if (meta.error === "unknown_device") {
    showOverlayError("Device key not found.");
    return;
  }
  if (meta.deviceName) {
    setDeviceName(meta.deviceName);
    persistDevice(KEY, meta.deviceName);
  } else {
    persistDevice(KEY, null);
  }
  if (meta.deviceOnline !== undefined) setDeviceOnline(meta.deviceOnline);
}

function setDeviceOnline(online) {
  deviceOnline = online;
  setBadge(online ? "online" : "offline");
  document
    .getElementById("offline-banner")
    .classList.toggle("hidden", online);
  if (!online) renderStream();
}

const HEALTH_STYLE = {
  stable: "bg-emerald-500/10 text-emerald-400",
  degraded: "bg-yellow-400/10 text-yellow-300",
  unstable: "bg-red-500/10 text-red-400",
  standby: "bg-white/[0.05] text-white/40",
};
const STATUS_STYLE = {
  live: "text-red-400",
  connecting: "text-yellow-300/70",
  offline: "text-white/30",
};

function renderStream() {
  const live = deviceOnline && stream.status === "live";
  const total = live ? (stream.totalKbps ?? 0) : 0;
  document.getElementById("total-kbps").textContent = (total / 1000).toFixed(1);

  const statusEl = document.getElementById("stream-status");
  const status = deviceOnline ? (stream.status ?? "offline") : "offline";
  statusEl.textContent = status;
  statusEl.className = `text-[11px] font-semibold uppercase tracking-wider ${STATUS_STYLE[status] ?? "text-white/30"}`;

  const healthEl = document.getElementById("health-pill");
  const health = deviceOnline ? (stream.health ?? "standby") : "standby";
  healthEl.textContent = health;
  healthEl.className = `text-[11px] font-semibold px-2.5 py-1 rounded-full ${HEALTH_STYLE[health] ?? HEALTH_STYLE.standby}`;

  document.getElementById("elapsed").textContent = fmtElapsed(
    live ? (stream.elapsedSec ?? 0) : 0,
  );
  document.getElementById("resolution").textContent = stream.resolution ?? "—";
  document.getElementById("encoder").textContent = stream.encoder ?? "—";
  document.getElementById("target-kbps").textContent =
    stream.targetKbps != null
      ? `${(stream.targetKbps / 1000).toFixed(1)} Mbps`
      : "—";
}

const TYPE_STYLE = {
  ETH: "bg-cyan-500/15 text-cyan-300",
  WIFI: "bg-yellow-400/15 text-yellow-300",
  LTE: "bg-indigo-400/15 text-indigo-300",
  "5G": "bg-violet-400/15 text-violet-300",
};
const STATE_STYLE = {
  bonded: "text-emerald-400",
  ready: "text-white/55",
  disabled: "text-white/30",
  "no-ip": "text-yellow-300/70",
  "no-carrier": "text-red-400/70",
};

function renderLinks() {
  const container = document.getElementById("links-list");
  if (!links.length) {
    container.innerHTML = `<p class="text-sm text-white/20 py-4 text-center">No links reported.</p>`;
    document.getElementById("links-total").textContent = "";
    return;
  }

  container.innerHTML = links
    .map((l) => {
      const enabled = l.enabled !== false && l.state !== "disabled";
      const kbps = enabled ? (l.txKbps ?? 0) : 0;
      const mbps = (kbps / 1000).toFixed(2);
      const typeCls = TYPE_STYLE[l.type] ?? "bg-white/10 text-white/50";
      const stateCls = STATE_STYLE[l.state] ?? "text-white/40";
      return `
      <div class="flex items-center gap-3 px-4 py-3 rounded-xl border border-white/[0.06] bg-white/[0.02] ${enabled ? "" : "opacity-45"}">
        <span class="text-[10px] font-semibold px-2 py-0.5 rounded-md shrink-0 ${typeCls}">${escHtml(l.type ?? "—")}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold bpos-mono truncate">${escHtml(l.iface ?? l.label ?? "—")}</span>
            <span class="text-[10px] text-white/30 truncate">${escHtml(l.label ?? "")}</span>
          </div>
          <span class="text-[10px] bpos-mono text-white/30">${escHtml(l.ipv4 ?? "—")} · <span class="${stateCls}">${escHtml(l.state ?? "—")}</span></span>
        </div>
        <span class="text-sm bpos-mono tabular-nums font-semibold shrink-0 ${enabled ? "text-white/70" : "text-white/25"}">${mbps}<span class="text-[10px] text-white/30 font-normal"> M</span></span>
      </div>`;
    })
    .join("");

  const totalKbps = links
    .filter((l) => l.enabled !== false && l.state !== "disabled")
    .reduce((a, l) => a + (l.txKbps ?? 0), 0);
  document.getElementById("links-total").textContent =
    totalKbps > 0 ? `${(totalKbps / 1000).toFixed(1)} Mbps` : "";
}

function renderSystem() {
  document.getElementById("sys-temp").textContent =
    system.tempC != null ? `${Math.round(system.tempC)}°` : "—";
  document.getElementById("sys-cpu").textContent =
    system.cpu != null ? `${Math.round(system.cpu)}%` : "—";
  document.getElementById("sys-uptime").textContent =
    system.uptimeSec != null ? fmtUptime(system.uptimeSec) : "—";
}

function fmtElapsed(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}
function fmtUptime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function setBadge(state) {
  ["online", "offline", "connecting"].forEach((s) => {
    const el = document.getElementById(`badge-${s}`);
    if (el) {
      el.classList.add("hidden");
      el.classList.remove("flex");
    }
  });
  const active = document.getElementById(`badge-${state}`);
  if (active) {
    active.classList.remove("hidden");
    active.classList.add("flex");
  }
}
function showOverlayError(msg) {
  document.getElementById("overlay-error-msg").textContent = msg;
  document.getElementById("overlay-error").classList.remove("hidden");
}
function setDeviceName(name) {
  if (!name) return;
  const el = document.getElementById("device-name-display");
  el.textContent = name;
  el.classList.remove("hidden");
  document.title = `${name} — BackpackOS`;
}
function setVersion(v) {
  if (!v) return;
  const el = document.getElementById("device-version");
  el.textContent = `v${v}`;
  el.classList.remove("hidden");
}

const copyDeviceKey = () =>
  navigator.clipboard.writeText(KEY).catch(() => {});
const copyControlUrl = () =>
  navigator.clipboard.writeText(location.href).catch(() => {});

Object.assign(window, { copyDeviceKey, copyControlUrl });
