const KEY = location.pathname.split("/").pop() ?? "";
const ENCODER = location.pathname.split("/")[2] ?? "bela";
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/viewer/${KEY}`;

const ic = (name, size = 14) =>
  `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#ic-${name}"/></svg>`;
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
let isStreaming = false;
let autostartEnabled = false;
let updatePkgCount = 0;
let updatePkgSize = "";

const available = {
  pipelines: {},
  asrcs: [],
  acodecs: {},
  relays: { servers: {}, accounts: {} },
};
const pendingConfig = {};
let configEchoDeadline = 0;
const dirtyFields = new Set();
const lastDeviceConfig = {};
const wifiScanningDevs = new Set();
const netifState = {};
const activeNotifications = new Map();

if (!KEY) {
  showOverlayError("No device key in URL.");
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
    clearNotifications();
  };
  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch {}
  };
  ws.onclose = () => {
    deviceOnline = false;
    updateStreamButton();
    setBadge("offline");
    scheduleReconnect();
  };
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
  if (msg.status) handleStatus(msg.status);
  if (msg.config) handleConfig(msg.config);
  if (msg.netif) handleNetif(msg.netif);
  if (msg.sensors) handleSensors(msg.sensors);
  if (msg.revisions) handleRevisions(msg.revisions);
  if (msg.pipelines) handlePipelines(msg.pipelines);
  if (msg.relays) handleRelays(msg.relays);
  if (msg.acodecs) handleAcodecs(msg.acodecs);
  if (msg.wifi) handleWifi(msg.wifi);
  if (msg.modems) handleModems(msg.modems);
  if (msg.bitrate) handleBitrate(msg.bitrate);
  if (msg.notification) handleNotification(msg.notification);
  if (msg.log) handleLog(msg.log);
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
  if (meta.deviceOnline !== undefined) {
    const wasOnline = deviceOnline;
    deviceOnline = meta.deviceOnline;
    setBadge(deviceOnline ? "online" : "offline");
    if (!deviceOnline && wasOnline) resetDeviceUI();
    if (deviceOnline && !wasOnline)
      document.getElementById("overlay-system-cmd")?.classList.add("hidden");
    updateStreamButton();
  }
}

function handleStatus(s) {
  if (s.is_streaming !== undefined) {
    const wasStreaming = isStreaming;
    isStreaming = s.is_streaming;
    if (isStreaming && !wasStreaming) {
      [
        "inp-srtla-addr",
        "inp-srtla-port",
        "inp-srt-sid",
        "sel-relay-server",
        "sel-relay-account",
      ].forEach(clearDirty);
    }
    updateStreamButton();
    updateLiveStats();
  }

  if (s.available_updates !== undefined) {
    const u = s.available_updates;
    updatePkgCount = u?.package_count ?? 0;
    updatePkgSize = u?.download_size ?? "";
    renderUpdateBtn();
    if (updatePkgCount > 0)
      pushNotification({
        name: "sw-update",
        type: "warning",
        msg: `${updatePkgCount} software update(s) available (${updatePkgSize})`,
        is_dismissable: true,
      });
  }

  if (s.updating != null) {
    const u = s.updating,
      total = u.total || 1;
    const done =
      (u.downloading || 0) + (u.unpacking || 0) + (u.setting_up || 0);
    document.getElementById("overlay-update").classList.remove("hidden");
    document.getElementById("upd-dl").textContent = pct(u.downloading, total);
    document.getElementById("upd-unpack").textContent = pct(u.unpacking, total);
    document.getElementById("upd-setup").textContent = pct(u.setting_up, total);
    document.getElementById("upd-bar").style.width =
      `${Math.round((done / total) * 100)}%`;
    if (u.result === 0) {
      setTimeout(
        () => document.getElementById("overlay-update").classList.add("hidden"),
        3000,
      );
      pushNotification({
        type: "success",
        msg: "Update complete! Encoder will restart.",
        is_dismissable: true,
      });
    }
  } else {
    document.getElementById("overlay-update")?.classList.add("hidden");
  }

  if (s.ssh) handleSSH(s.ssh);
  if (s.wifi) handleWifi(s.wifi);
  if (s.modems) handleModems(s.modems);
  if (s.asrcs !== undefined) {
    available.asrcs = s.asrcs;
    renderAsrcs();
  }
}
const pct = (v, t) => (v === undefined ? "—" : `${Math.round((v / t) * 100)}%`);

function handleConfig(c) {
  if (c.pipeline !== undefined) pendingConfig.pipeline = c.pipeline;
  if (c.asrc !== undefined) pendingConfig.asrc = c.asrc;
  if (c.acodec !== undefined) pendingConfig.acodec = c.acodec;
  if (c.relay_server !== undefined) pendingConfig.relay_server = c.relay_server;
  if (c.relay_account !== undefined)
    pendingConfig.relay_account = c.relay_account;

  const skipEcho = Date.now() < configEchoDeadline;
  if (!skipEcho) {
    if (c.pipeline !== undefined) syncSelect("sel-pipeline", c.pipeline);
    if (c.asrc !== undefined) syncSelect("sel-asrc", c.asrc);
    if (c.acodec !== undefined) syncSelect("sel-acodec", c.acodec);
    if (c.relay_server !== undefined)
      setDeviceConfigField("sel-relay-server", c.relay_server ?? "");
    if (c.relay_account !== undefined)
      setDeviceConfigField("sel-relay-account", c.relay_account ?? "");
    if (c.max_br !== undefined) syncRange("range-br", c.max_br, "br-val");
    if (c.srt_latency !== undefined)
      syncRange("range-lat", c.srt_latency, "lat-val");
    if (c.delay !== undefined) syncRange("range-delay", c.delay, "delay-val");
    setDeviceConfigField("inp-srtla-addr", c.srtla_addr);
    setDeviceConfigField("inp-srtla-port", c.srtla_port);
    setDeviceConfigField("inp-srt-sid", c.srt_streamid);
  }
  if (c.bitrate_overlay !== undefined) {
    const el = document.getElementById("chk-overlay");
    if (el) el.checked = !!c.bitrate_overlay;
  }
  if (c.autostart !== undefined) {
    autostartEnabled = !!c.autostart;
    const el = document.getElementById("chk-autostart");
    if (el) el.checked = autostartEnabled;
    refreshAutostartLabel();
  }
  if (c.ssh_pass) {
    const inp = document.getElementById("ssh-pass-input");
    const wrap = document.getElementById("ssh-pass-display");
    if (inp && wrap) {
      inp.value = c.ssh_pass;
      inp.type = "password";
      const btn = document.getElementById("btn-ssh-pass-vis");
      if (btn) btn.textContent = "Show";
      wrap.classList.remove("hidden");
    }
  }
  updateRelayVisibility();
  updateAudioVisibility();
}

function handlePipelines(ps) {
  available.pipelines = ps;
  const sel = document.getElementById("sel-pipeline");
  sel.innerHTML = Object.entries(ps)
    .map(
      ([id, p]) =>
        `<option value="${escHtml(id)}">${escHtml(p.name ?? id)}</option>`,
    )
    .join("");

  if (pendingConfig.pipeline !== undefined) sel.value = pendingConfig.pipeline;
  updateAudioVisibility();
}
function handleAcodecs(acodecs) {
  available.acodecs = acodecs;
  const sel = document.getElementById("sel-acodec");
  sel.innerHTML = Object.entries(acodecs)
    .map(
      ([id, name]) =>
        `<option value="${escHtml(id)}">${escHtml(name)}</option>`,
    )
    .join("");
  if (pendingConfig.acodec !== undefined) sel.value = pendingConfig.acodec;
}
function renderAsrcs() {
  const sel = document.getElementById("sel-asrc");
  sel.innerHTML =
    `<option value="">None</option>` +
    available.asrcs
      .map((s) => `<option value="${escHtml(s)}">${escHtml(s)}</option>`)
      .join("");
  if (pendingConfig.asrc !== undefined) sel.value = pendingConfig.asrc;
}
function updateAudioVisibility() {
  const p = available.pipelines[document.getElementById("sel-pipeline").value];
  if (!p) return;
  document.getElementById("asrc-group").style.display =
    p.asrc !== false ? "" : "none";
  document.getElementById("acodec-group").style.display =
    p.acodec !== false ? "" : "none";
}

function handleRelays(relays) {
  if (relays.servers) available.relays.servers = relays.servers;
  if (relays.accounts) available.relays.accounts = relays.accounts;

  const srv = document.getElementById("sel-relay-server");
  const srvPrev = srv.value;
  srv.innerHTML =
    `<option value="">Manual (SRTLA)</option>` +
    Object.entries(available.relays.servers)
      .map(
        ([id, s]) =>
          `<option value="${escHtml(id)}">${escHtml(s.name)}${s.default ? " ★" : ""}</option>`,
      )
      .join("");
  if (dirtyFields.has("sel-relay-server")) srv.value = srvPrev;
  else if (lastDeviceConfig["sel-relay-server"] !== undefined)
    srv.value = lastDeviceConfig["sel-relay-server"];

  const acc = document.getElementById("sel-relay-account");
  const accPrev = acc.value;
  acc.innerHTML =
    `<option value="">None</option>` +
    Object.entries(available.relays.accounts)
      .map(
        ([id, a]) =>
          `<option value="${escHtml(id)}"${a.disabled ? " disabled" : ""}>${escHtml(a.name)}</option>`,
      )
      .join("");
  if (dirtyFields.has("sel-relay-account")) acc.value = accPrev;
  else if (lastDeviceConfig["sel-relay-account"] !== undefined)
    acc.value = lastDeviceConfig["sel-relay-account"];
  updateRelayVisibility();
}
function updateRelayVisibility() {
  const relay = document.getElementById("sel-relay-server")?.value ?? "";
  const hasRelay = relay !== "";
  document
    .getElementById("relay-account-group")
    ?.classList.toggle("hidden", !hasRelay);
  document
    .getElementById("manual-srtla-group")
    ?.classList.toggle("hidden", hasRelay);
}

function handleNetif(netif) {
  Object.assign(netifState, netif);
  const container = document.getElementById("netif-list");
  container.innerHTML = "";

  for (const [name, iface] of Object.entries(netifState)) {
    const enabled = iface.enabled !== false;
    const mbps = ((iface.tp ?? 0) * 8) / 1_000_000;
    const barPct = Math.min((mbps / 20) * 100, 100);
    const typeClass = name.startsWith("eth")
      ? "netif-card-eth"
      : name.startsWith("wlan")
        ? "netif-card-wifi"
        : name.startsWith("wwan")
          ? "netif-card-modem"
          : "netif-card-other";

    const row = document.createElement("div");
    row.className = `${typeClass} flex items-center gap-3 py-2.5 border-b border-white/[0.05] last:border-0`;
    row.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1.5">
          <span class="text-xs font-mono font-semibold ${enabled ? "text-white/80" : "text-white/25"}">${escHtml(name)}</span>
          ${iface.ip ? `<span class="text-[10px] text-white/25 font-mono">${escHtml(iface.ip)}</span>` : ""}
          ${iface.error ? `<span class="text-[10px] text-red-400">${escHtml(iface.error)}</span>` : ""}
        </div>
        <div class="h-1 rounded-full bg-white/[0.07] overflow-hidden">
          <div class="netif-bar-fill h-full rounded-full transition-all duration-700" style="width:${enabled ? barPct : 0}%"></div>
        </div>
      </div>
      <div class="flex items-center gap-2.5 shrink-0">
        <span class="text-xs font-mono tabular-nums font-semibold" style="color:${enabled ? `var(--accent,#22d3ee)` : `rgba(255,255,255,0.18)`}">${mbps.toFixed(1)}<span class="text-white/30 font-normal text-[10px]"> M</span></span>
        <button data-netif-toggle
          class="text-[10px] px-2 py-0.5 rounded-md border transition-colors select-none
            ${
              enabled
                ? "border-white/[0.08] text-white/25 hover:border-red-500/40 hover:text-red-400"
                : "border-cyan-500/25 text-cyan-400/60 hover:border-cyan-400/50 hover:text-cyan-300"
            }">
          ${enabled ? "disable" : "enable"}
        </button>
      </div>`;
    container.appendChild(row);
    row
      .querySelector("[data-netif-toggle]")
      .addEventListener("click", () => toggleNetif(name, !enabled));
  }

  const totalMbps = Object.values(netifState)
    .filter((i) => i.enabled !== false)
    .reduce((a, i) => a + ((i.tp ?? 0) * 8) / 1_000_000, 0);
  const totalEl = document.getElementById("netif-total");
  if (totalEl)
    totalEl.textContent =
      totalMbps > 0.01 ? `${totalMbps.toFixed(1)} Mbps` : "";

  updateLiveStats();
}

function handleWifi(wifi) {
  if (wifi.new) {
    pushNotification({
      type: wifi.new.success ? "success" : "error",
      msg: wifi.new.success
        ? "Connected to Wi-Fi."
        : `Wi-Fi error: ${wifi.new.error ?? "unknown"}`,
      is_dismissable: true,
    });
  }

  const container = document.getElementById("wifi-devices");
  let hasDevices = false;

  for (const [id, dev] of Object.entries(wifi)) {
    if (["new", "scan", "connect", "hotspot"].includes(id)) continue;
    hasDevices = true;

    const stateKey = JSON.stringify({
      conn: dev.conn,
      hotspot: dev.hotspot,
      nets: dev.available,
      hw: dev.hw,
    });
    const isNew = !document.getElementById(`wifi-dev-${id}`);

    let devEl = document.getElementById(`wifi-dev-${id}`);
    if (!devEl) {
      devEl = document.createElement("div");
      devEl.id = `wifi-dev-${id}`;
      devEl.className =
        "rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 space-y-3";
      container.appendChild(devEl);
    }

    if (!isNew && devEl.dataset.stateKey === stateKey) continue;
    devEl.dataset.stateKey = stateKey;

    const nets = dev.available ?? [];
    const hotspot = !!dev.hotspot;
    const scanning = wifiScanningDevs.has(id);
    const connSsid = nets.find((n) => n.active)?.ssid ?? null;

    devEl.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <svg width="14" height="14" class="shrink-0 text-white/40"><use href="#ic-wifi"/></svg>
          <span class="font-semibold text-sm text-white/80 truncate">${escHtml(dev.hw ?? dev.ifname ?? id)}</span>
          ${
            hotspot
              ? `<span class="text-[10px] bg-yellow-400/10 text-yellow-400 px-2 py-0.5 rounded-full font-medium shrink-0">Hotspot</span>`
              : connSsid
                ? `<span class="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full font-medium truncate max-w-[120px] shrink-0" title="${escHtml(connSsid)}">${escHtml(connSsid)}</span>`
                : `<span class="text-[10px] text-white/20 shrink-0">No connection</span>`
          }
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          ${
            !hotspot
              ? `<button data-scan-btn onclick="wifiScan('${escHtml(id)}')"
              class="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${scanning ? "border-cyan-400/30 text-cyan-400 bg-cyan-400/5" : "border-white/10 text-white/40 hover:text-cyan-400 hover:border-cyan-400/30"} transition-colors font-medium">
              ${scanning ? `<svg width="11" height="11" style="animation:spin 1s linear infinite"><use href="#ic-spin"/></svg>Scanning` : "Scan"}
            </button>`
              : ""
          }
          <button onclick="wifiHotspot('${escHtml(id)}',${!hotspot})"
            class="text-xs px-2.5 py-1.5 rounded-lg border transition-colors font-medium ${hotspot ? "border-yellow-400/30 text-yellow-400 bg-yellow-400/5 hover:bg-yellow-400/10" : "border-white/10 text-white/30 hover:text-yellow-400 hover:border-yellow-400/30"}">
            ${hotspot ? "Hotspot off" : "Hotspot"}
          </button>
        </div>
      </div>
      ${
        !hotspot && nets.length > 0
          ? `<div class="space-y-1">${nets
              .slice(0, 15)
              .map((n, ni) => {
                const safeId = `wfp-${id}-${ni}`;
                const stagger = `style="animation-delay:${ni * 30}ms"`;
                const needsPass = n.security && !n.uuid;
                const hasSaved = !!n.uuid;
                return `
            <div class="wifi-net-item" ${stagger}>
              <div class="flex items-center gap-3 rounded-xl px-3 py-2.5 ${n.active ? "bg-emerald-500/[0.06] border border-emerald-500/20" : "hover:bg-white/[0.04] border border-transparent"} transition-colors cursor-default">
                <div class="flex items-center gap-0.5 shrink-0">${wifiSignalIcon(n.signal ?? 0)}</div>
                <span class="flex-1 text-sm font-medium truncate ${n.active ? "text-white" : "text-white/55"}">${escHtml(n.ssid)}</span>
                ${n.security ? `<svg width="12" height="12" class="shrink-0 text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>` : ""}
                ${
                  n.active
                    ? `<div class="flex items-center gap-1.5 shrink-0">
                      <span class="text-xs text-emerald-400 font-semibold">Connected</span>
                      ${
                        hasSaved
                          ? `<button onclick="wifiForget('${n.uuid}','${escHtml(n.ssid)}')"
                        class="text-xs px-2 py-1 rounded-lg border border-red-500/20 text-red-400/60 hover:border-red-500/40 hover:text-red-400 hover:bg-red-500/5 transition-colors">Forget</button>`
                          : ""
                      }
                    </div>`
                    : `<div class="flex items-center gap-1.5 shrink-0">
                      <button onclick="wifiConnectToggle('${safeId}','${id}','${escHtml(n.ssid)}',${needsPass},'${n.uuid ?? ""}')"
                        class="text-xs px-2.5 py-1 rounded-lg border border-cyan-500/25 text-cyan-400/70 hover:border-cyan-400/50 hover:text-cyan-300 hover:bg-cyan-400/5 transition-colors font-medium">
                        Connect
                      </button>
                      ${
                        hasSaved
                          ? `<button onclick="wifiForget('${n.uuid}','${escHtml(n.ssid)}')"
                        class="text-xs px-2 py-1 rounded-lg border border-red-500/20 text-red-400/60 hover:border-red-500/40 hover:text-red-400 hover:bg-red-500/5 transition-colors">Forget</button>`
                          : ""
                      }
                    </div>`
                }
              </div>
              ${
                needsPass
                  ? `
              <div id="${safeId}" class="hidden px-3 pt-1 pb-2">
                <div class="flex items-center gap-2 mt-1">
                  <input type="password" placeholder="Wi-Fi password"
                    class="input-field text-sm py-2 flex-1 min-w-0"
                    onkeydown="if(event.key==='Enter')wifiConnectWithPass(this,'${id}','${escHtml(n.ssid)}')"/>
                  <button onclick="wifiConnectWithPass(this.previousElementSibling,'${id}','${escHtml(n.ssid)}')"
                    class="shrink-0 text-sm px-3 py-2 rounded-xl bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30 transition-colors font-medium">
                    Join
                  </button>
                </div>
              </div>`
                  : ""
              }
            </div>`;
              })
              .join("")}
        </div>`
          : nets.length === 0 && !hotspot
            ? `<p class="text-xs text-white/25 text-center py-2">No networks found — tap Scan</p>`
            : ""
      }`;
  }

  container.querySelectorAll("[id^='wifi-dev-']").forEach((el) => {
    const devId = el.id.slice("wifi-dev-".length);
    if (!wifi[devId] || ["new", "scan", "connect", "hotspot"].includes(devId))
      el.remove();
  });

  const sec = document.getElementById("wifi-section");
  if (hasDevices) {
    const wasHidden = sec.classList.contains("hidden");
    sec.classList.remove("hidden");
    if (wasHidden) sec.classList.add("section-reveal");
  } else {
    sec.classList.add("hidden");
  }
}
function wifiSignalIcon(pct) {
  const level = Math.min(Math.floor(pct / 20), 4);
  return ["▁", "▂", "▃", "▄", "▅"]
    .map(
      (b, i) =>
        `<span class="text-sm" style="opacity:${i <= level ? 0.85 : 0.15};color:${i <= level ? "#22d3ee" : "inherit"}">${b}</span>`,
    )
    .join("");
}
function wifiConnectToggle(safeId, devId, ssid, needsPass, uuid) {
  if (!needsPass) {
    send(
      uuid
        ? { wifi: { connect: uuid } }
        : { wifi: { new: { device: devId, ssid, password: "" } } },
    );
    return;
  }

  const row = document.getElementById(safeId);
  if (!row) return;
  const hidden = row.classList.toggle("hidden");
  if (!hidden) row.querySelector("input")?.focus();
}
function wifiConnectWithPass(input, devId, ssid) {
  const password = input.value.trim();
  send({ wifi: { new: { device: devId, ssid, password } } });
  input.value = "";
  input.closest("[id^='wfp-']")?.classList.add("hidden");
}
function wifiForget(uuid, ssid) {
  if (
    !confirm(
      `Forget network "${ssid}"?\n\nThe device will need the password again to reconnect.`,
    )
  )
    return;
  send({ wifi: { forget: uuid } });
}
function wifiScan(dev) {
  send({ wifi: { scan: dev ?? "default" } });
  wifiScanningDevs.add(dev);
  const el = document.getElementById(`wifi-dev-${dev}`);
  if (el) {
    delete el.dataset.stateKey;
    const btn = el.querySelector(`[data-scan-btn]`);
    if (btn) {
      btn.innerHTML = `<svg width="11" height="11" style="animation:spin 1s linear infinite"><use href="#ic-spin"/></svg>Scanning`;
      btn.className =
        "flex items-center gap-1.5 text-xs shrink-0 px-2.5 py-1.5 rounded-lg border border-cyan-400/30 text-cyan-400 bg-cyan-400/5 transition-colors font-medium";
    }
  }
  setTimeout(() => {
    wifiScanningDevs.delete(dev);
    const el2 = document.getElementById(`wifi-dev-${dev}`);
    if (el2) delete el2.dataset.stateKey;
  }, 22_000);
}
function wifiHotspot(dev, enable) {
  send({ wifi: { hotspot: { device: dev, enable } } });
}
function handleModems(modems) {
  if (!Object.keys(modems).length) return;
  const modemSec = document.getElementById("modems-section");
  const modemNew = modemSec.classList.contains("hidden");
  modemSec.classList.remove("hidden");
  if (modemNew) modemSec.classList.add("section-reveal");
  document.getElementById("modems-list").innerHTML = Object.entries(modems)
    .map(([id, m]) => {
      const sig = m.signal ?? m.status?.signal ?? 0;
      const netType = m.network_type ?? m.status?.network_type ?? "";
      const net = m.operator ?? m.status?.network ?? "";
      const conn = m.status?.connection ?? "";
      const color = sig > 65 ? "#22d3ee" : sig > 35 ? "#facc15" : "#f87171";
      return `<div class="py-2.5 border-b border-white/[0.05] last:border-0 space-y-1.5">
      <div class="flex items-center justify-between">
        <span class="text-xs font-semibold text-white/70">${escHtml(m.model ?? m.name ?? id)}</span>
        ${
          m.no_sim
            ? `<span class="text-[10px] text-red-400">No SIM</span>`
            : `<span class="text-[10px] font-mono font-semibold" style="color:${color}">${escHtml(netType)}</span>`
        }
      </div>
      ${
        !m.no_sim
          ? `
        <div class="flex items-center gap-2">
          <div class="flex-1 h-1 rounded-full bg-white/[0.07] overflow-hidden">
            <div class="h-full rounded-full transition-all" style="width:${sig}%;background:${color}"></div>
          </div>
          <span class="text-[10px] tabular-nums font-mono font-semibold w-7 text-right" style="color:${color}">${sig}%</span>
        </div>
        ${net || conn ? `<p class="text-[10px] text-white/25 font-mono">${[net, conn].filter(Boolean).map(escHtml).join(" · ")}${m.imei ? " · ···" + escHtml(String(m.imei).slice(-4)) : ""}</p>` : ""}
      `
          : ""
      }
    </div>`;
    })
    .join("");
}

function handleSensors(sensors) {
  if (!Object.keys(sensors).length) return;
  const sensorSec = document.getElementById("sensors-section");
  const sensorNew = sensorSec.classList.contains("hidden");
  sensorSec.classList.remove("hidden");
  if (sensorNew) sensorSec.classList.add("section-reveal");
  document.getElementById("sensors-grid").innerHTML = Object.entries(sensors)
    .map(([name, value]) => {
      const color = sensorColor(name, String(value));
      const num = parseFloat(String(value));
      const isTemp = /temp|thermal/i.test(name) || String(value).includes("°");
      const barPct = isTemp && !isNaN(num) ? Math.min(num, 100) : null;
      return `<div class="rounded-xl bg-white/[0.03] border border-white/[0.06] p-3 relative overflow-hidden">
      ${barPct !== null ? `<div class="absolute bottom-0 left-0 h-0.5 transition-all duration-700" style="width:${barPct}%;background:${color}"></div>` : ""}
      <p class="text-[10px] text-white/30 mb-1 uppercase tracking-wide font-medium">${escHtml(humanize(name))}</p>
      <p class="text-lg font-black tabular-nums leading-none" style="color:${color}">${escHtml(String(value))}</p>
    </div>`;
    })
    .join("");
}
function sensorColor(name, value) {
  const isTemp = /temp|thermal/i.test(name) || value.includes("°");
  if (!isTemp) return "rgba(255,255,255,0.8)";
  const n = parseFloat(value);
  if (isNaN(n)) return "rgba(255,255,255,0.8)";
  if (n < 45) return "#22d3ee";
  if (n < 62) return "#facc15";
  if (n < 78) return "#f97316";
  return "#ef4444";
}

function handleRevisions(revisions) {
  document.getElementById("revisions-section").classList.remove("hidden");
  document.getElementById("revisions-grid").innerHTML = Object.entries(
    revisions,
  )
    .map(
      ([k, v]) =>
        `<div class="flex justify-between text-[10px]">
        <span class="text-white/30">${escHtml(k)}</span>
        <span class="font-mono text-white/45">${escHtml(String(v))}</span>
      </div>`,
    )
    .join("");
}

function resetDeviceUI() {
  Object.keys(netifState).forEach((k) => delete netifState[k]);
  document.getElementById("netif-list").innerHTML = "";
  const totalEl = document.getElementById("netif-total");
  if (totalEl) totalEl.textContent = "";
  document.getElementById("sensors-grid").innerHTML = "";
  document.getElementById("sensors-section").classList.add("hidden");
  document.getElementById("modems-list").innerHTML = "";
  document.getElementById("modems-section").classList.add("hidden");
  document.getElementById("revisions-section").classList.add("hidden");
  document.getElementById("ssh-section").classList.add("hidden");
  document.getElementById("wifi-devices").innerHTML = "";
  document.getElementById("wifi-section").classList.add("hidden");

  Object.keys(pendingConfig).forEach((k) => delete pendingConfig[k]);
  isStreaming = false;
  updateStreamButton();
}

function toggleSshPassVis() {
  const inp = document.getElementById("ssh-pass-input");
  const btn = document.getElementById("btn-ssh-pass-vis");
  if (!inp) return;
  const hidden = inp.type === "password";
  inp.type = hidden ? "text" : "password";
  if (btn) btn.textContent = hidden ? "Hide" : "Show";
}
function handleSSH(ssh) {
  const section = document.getElementById("ssh-section");
  section.classList.remove("hidden");
  const active = ssh.active;
  document.getElementById("ssh-dot").className =
    `w-2 h-2 rounded-full shrink-0 ${active ? "bg-emerald-400" : "bg-white/20"}`;
  document.getElementById("ssh-state").textContent = active ? "Active" : "Off";
  document.getElementById("btn-ssh-toggle").textContent = active
    ? "Disable"
    : "Enable";
  document.getElementById("btn-ssh-reset").classList.toggle("hidden", !active);
  if (ssh.user) {
    const el = document.getElementById("ssh-user");
    if (el) el.textContent = ssh.user;
  }
}
const toggleSSH = () =>
  send({
    command:
      document.getElementById("ssh-state").textContent === "Active"
        ? "stop_ssh"
        : "start_ssh",
  });
const resetSSH = () =>
  confirmCmd(
    "reset_ssh_pass",
    "Generate a new SSH password?",
    "Reset Password",
  );

function toggleAutostart() {
  const el = document.getElementById("chk-autostart");
  if (!el) return;
  if (
    el.checked &&
    !confirm(
      "Enabling Auto-Start will cause the encoder to start streaming on every power-up.\n\nOnly enable this if you are sure it is safe to do so. Continue?",
    )
  ) {
    el.checked = false;
    return;
  }
  autostartEnabled = el.checked;
  send({ config: { autostart: autostartEnabled } });
  refreshAutostartLabel();
}
function refreshAutostartLabel() {
  const lbl = document.getElementById("autostart-label");
  if (!lbl) return;
  lbl.textContent = autostartEnabled
    ? "Streams on power-up"
    : "Manual start only";
  lbl.className = `text-[10px] mt-0.5 ${autostartEnabled ? "text-yellow-400/80" : "text-white/30"}`;
}

function renderUpdateBtn() {
  const btn = document.getElementById("btn-sw-update");
  if (!btn) return;
  if (updatePkgCount > 0) {
    btn.classList.remove("hidden");
    btn.querySelector(".upd-label").textContent =
      `Software Update — ${updatePkgCount} pkg (${updatePkgSize})`;
  } else {
    btn.classList.add("hidden");
  }
}
const triggerUpdate = () =>
  confirmCmd(
    "update",
    `Install ${updatePkgCount} update(s) (${updatePkgSize})?\n\nThe encoder will briefly disconnect when done. Never remove power during an update.`,
    "Update Now",
  );

function handleBitrate(b) {
  if (b.max_br !== undefined) syncRange("range-br", b.max_br, "br-val");
}
function onBitrateChange() {
  const val = Number(document.getElementById("range-br").value);
  if (isStreaming) {
    send({ bitrate: { max_br: val } });
  } else {
    send({ config: { max_br: val } });
  }
}

function handleNotification(n) {
  if (n.msg) pushNotification(n);
  if (n.show) n.show.forEach(pushNotification);
  if (n.remove) n.remove.forEach(dismissNotification);
}
function clearNotifications() {
  activeNotifications.forEach((el) => el.remove());
  activeNotifications.clear();
}
function pushNotification(n) {
  const id = n.name ?? `anon-${Date.now()}`;
  activeNotifications.get(id)?.remove();
  activeNotifications.delete(id);
  const cls =
    {
      success: "toast-success",
      error: "toast-error",
      warning: "toast-warning",
    }[n.type] ?? "toast-info";
  const icon =
    { success: "ok", error: "alert", warning: "warn" }[n.type] ?? "alert";
  const div = document.createElement("div");
  div.className = `toast ${cls}`;
  div.innerHTML =
    `${ic(icon, 16)}<span class="flex-1">${escHtml(n.msg ?? "")}</span>` +
    (n.is_dismissable !== false
      ? `<button onclick="dismissNotification('${id}')" class="shrink-0 text-current opacity-50 hover:opacity-100 ml-2">${ic("x", 13)}</button>`
      : "");
  document.getElementById("notifications").appendChild(div);
  activeNotifications.set(id, div);
  if (!n.is_persistent && n.duration !== 0)
    setTimeout(() => dismissNotification(id), (n.duration ?? 8) * 1000);
}
const dismissNotification = (id) => {
  activeNotifications.get(id)?.remove();
  activeNotifications.delete(id);
};

function handleLog(log) {
  try {
    const blob = new Blob([log.contents ?? ""], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = log.name ?? "encoder.log";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch {}

  const section = document.getElementById("log-section");
  if (section) {
    document.getElementById("log-title").textContent = log.name ?? "Log";
    document.getElementById("log-content").textContent = log.contents ?? "";
    section.classList.remove("hidden");
  }
}

function updateStreamButton() {
  const big = document.getElementById("btn-stream-big");
  const inner = document.getElementById("stream-btn-inner");
  const nav = document.getElementById("btn-stream-toggle");
  const card = document.getElementById("stream-card");

  const liveBadge = document.getElementById("badge-live");
  liveBadge.classList.toggle("hidden", !isStreaming);
  liveBadge.style.display = isStreaming ? "flex" : "none";

  document
    .getElementById("live-stats-inline")
    .classList.toggle("hidden", !isStreaming);
  document
    .getElementById("config-strip")
    .classList.toggle("hidden", isStreaming);

  const btnBase =
    "rounded-2xl font-black text-xl tracking-tight transition-all duration-300 w-full py-7 lg:w-72 lg:shrink-0 lg:min-h-[9rem]";

  if (!deviceOnline) {
    big.disabled = true;
    big.className = `stream-btn-disabled ${btnBase}`;
    inner.innerHTML = "Device Offline";
    nav?.classList.add("hidden");
    card?.classList.remove("live-glow");
    return;
  }

  big.disabled = false;
  nav?.classList.remove("hidden");
  if (nav) nav.style.display = "inline-flex";

  if (isStreaming) {
    big.className = `stream-btn-live ${btnBase}`;
    inner.innerHTML = `
      <span class="live-dot w-3 h-3 rounded-full bg-red-400 mb-0.5"></span>
      <span class="text-2xl font-black tracking-tighter leading-none">LIVE</span>
      <span class="text-xs font-normal opacity-50 mt-0.5">Tap to stop</span>`;
    if (nav) {
      nav.style.cssText =
        "background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);color:#f87171;";
      nav.textContent = "Stop";
    }
    card?.classList.add("live-glow");
  } else {
    big.className = `stream-btn-idle ${btnBase}`;
    inner.innerHTML = `
      <svg width="28" height="28" class="opacity-80"><use href="#ic-play"/></svg>
      <span class="text-2xl font-black tracking-tighter leading-none">Start Streaming</span>`;
    if (nav) {
      nav.style.cssText =
        "background:linear-gradient(135deg,#facc15,#22d3ee);color:#000;font-weight:700;";
      nav.textContent = "Start";
    }
    card?.classList.remove("live-glow");
  }
}

function toggleStream() {
  if (!deviceOnline) return;
  if (isStreaming) {
    send({ stop: 0 });
    return;
  }

  const pipeline = document.getElementById("sel-pipeline").value;
  if (!pipeline) {
    pushNotification({
      type: "error",
      msg: "Select a pipeline before starting.",
      is_dismissable: true,
    });
    return;
  }

  const relayServer = document.getElementById("sel-relay-server").value;
  const relayAccount = document.getElementById("sel-relay-account").value;
  const useRelay = relayServer !== "";

  const payload = {
    pipeline,
    asrc: document.getElementById("sel-asrc").value || undefined,
    acodec: document.getElementById("sel-acodec").value || "aac",
    max_br: Number(document.getElementById("range-br").value),
    srt_latency: Number(document.getElementById("range-lat").value),
    delay: Number(document.getElementById("range-delay").value),
    bitrate_overlay:
      document.getElementById("chk-overlay").checked || undefined,
  };

  if (useRelay) {
    payload.relay_server = relayServer;
    payload.relay_account = relayAccount || undefined;

    if (!relayAccount) {
      const sid = document.getElementById("inp-srt-sid").value;
      if (sid) payload.srt_streamid = sid;
    }

    payload.srtla_addr = "";
    payload.srtla_port = "";
  } else {
    const addr = document.getElementById("inp-srtla-addr").value;
    const port = document.getElementById("inp-srtla-port").value;
    const sid = document.getElementById("inp-srt-sid").value;
    if (addr) payload.srtla_addr = addr;
    if (port) payload.srtla_port = port;
    if (sid) payload.srt_streamid = sid;
  }

  send({ start: payload });
}

function onConfigChange() {
  updateAudioVisibility();
  updateRelayVisibility();
  sendCurrentConfig();
}

function sendCurrentConfig() {
  if (!deviceOnline) return;
  configEchoDeadline = Date.now() + 3000;

  const relayServer = document.getElementById("sel-relay-server").value;
  const relayAccount = document.getElementById("sel-relay-account").value;
  const useRelay = relayServer !== "";

  const cfg = {};
  const pipeline = document.getElementById("sel-pipeline").value;
  if (pipeline) cfg.pipeline = pipeline;
  const asrc = document.getElementById("sel-asrc").value;
  cfg.asrc = asrc || null;
  const acodec = document.getElementById("sel-acodec").value;
  if (acodec) cfg.acodec = acodec;
  cfg.max_br = Number(document.getElementById("range-br").value);
  cfg.srt_latency = Number(document.getElementById("range-lat").value);
  cfg.delay = Number(document.getElementById("range-delay").value);

  if (useRelay) {
    cfg.relay_server = relayServer;
    cfg.relay_account = relayAccount || null;

    cfg.srt_streamid = !relayAccount
      ? document.getElementById("inp-srt-sid").value || null
      : null;

    cfg.srtla_addr = "";
    cfg.srtla_port = "";
  } else {
    cfg.relay_server = null;
    cfg.relay_account = null;
    cfg.srtla_addr = document.getElementById("inp-srtla-addr").value || "";
    cfg.srtla_port = document.getElementById("inp-srtla-port").value || "";
    cfg.srt_streamid = document.getElementById("inp-srt-sid").value || null;
  }

  send({ config: cfg });
}

function updateLiveStats() {
  const container = document.getElementById("live-stats-bars");
  if (!isStreaming || !Object.keys(netifState).length) return;

  const entries = Object.entries(netifState).filter(
    ([, i]) => i.enabled !== false,
  );
  const totalMbps = entries.reduce(
    (a, [, i]) => a + ((i.tp ?? 0) * 8) / 1_000_000,
    0,
  );

  container.innerHTML = `
    <div class="flex items-baseline gap-2 mb-4">
      <span class="text-5xl font-black tabular-nums" style="background:linear-gradient(to right,#facc15,#22d3ee,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent">${totalMbps.toFixed(1)}</span>
      <span class="text-base text-white/40 font-medium self-end pb-1">Mbps</span>
    </div>
    ${entries
      .map(([name, iface]) => {
        const mbps = ((iface.tp ?? 0) * 8) / 1_000_000;
        const barPct =
          totalMbps > 0 ? Math.min((mbps / totalMbps) * 100, 100) : 0;
        return `<div class="flex items-center gap-2 text-xs mb-1.5">
        <span class="font-mono text-white/35 w-14 shrink-0 text-[10px]">${name}</span>
        <div class="flex-1 h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
          <div class="h-full rounded-full transition-all duration-700" style="width:${barPct}%;background:linear-gradient(to right,#facc15,#22d3ee)"></div>
        </div>
        <span class="text-white/45 w-16 text-right font-mono tabular-nums text-[10px]">${mbps.toFixed(2)} M</span>
      </div>`;
      })
      .join("")}`;
}

const toggleNetif = (name, enable) => {
  if (netifState[name])
    send({ netif: { name, ip: netifState[name].ip, enabled: enable } });
};

const SYSTEM_CMD_META = {
  reboot: {
    icon: "↺",
    title: "Rebooting…",
    msg: "The encoder is restarting. This page will reconnect automatically.",
  },
  poweroff: {
    icon: "⏻",
    title: "Powering Off…",
    msg: "The encoder is shutting down. Reconnect won't happen until it is powered back on.",
  },
};
function sendCommand(cmd) {
  send({ command: cmd });
  const meta = SYSTEM_CMD_META[cmd];
  if (meta) showSystemCmdOverlay(meta);
}
function showSystemCmdOverlay({ icon, title, msg }) {
  document.getElementById("osc-icon").textContent = icon;
  document.getElementById("osc-title").textContent = title;
  document.getElementById("osc-msg").textContent = msg;
  document.getElementById("overlay-system-cmd").classList.remove("hidden");
}
let pendingCmd = null;
function confirmCmd(cmd, msg, label) {
  pendingCmd = cmd;
  document.getElementById("dialog-title").textContent = label;
  document.getElementById("dialog-msg").textContent = msg;
  document.getElementById("dialog-confirm-btn").textContent = label;
  document.getElementById("dialog-confirm").classList.remove("hidden");
}
function closeDialog() {
  document.getElementById("dialog-confirm").classList.add("hidden");
  pendingCmd = null;
}
document.getElementById("dialog-confirm-btn").addEventListener("click", () => {
  if (pendingCmd) sendCommand(pendingCmd);
  closeDialog();
});
document.getElementById("dialog-confirm").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeDialog();
});

function setBadge(state) {
  ["online", "offline", "connecting"].forEach((s) =>
    document.getElementById(`badge-${s}`)?.classList.add("hidden"),
  );
  document.getElementById(`badge-${state}`)?.classList.remove("hidden");
}
function showOverlayError(msg) {
  document.getElementById("overlay-error-msg").textContent = msg;
  document.getElementById("overlay-error").classList.remove("hidden");
}
const copyDeviceKey = () =>
  navigator.clipboard
    .writeText(KEY)
    .then(() =>
      pushNotification({
        type: "success",
        msg: "Device key copied.",
        is_dismissable: true,
      }),
    )
    .catch(() => {});
const copyControlUrl = () =>
  navigator.clipboard
    .writeText(location.href)
    .then(() =>
      pushNotification({
        type: "success",
        msg: "Control URL copied.",
        is_dismissable: true,
      }),
    )
    .catch(() => {});

function setDeviceName(name) {
  const el = document.getElementById("device-name-display");
  el.textContent = name;
  el.classList.remove("hidden");
  document.getElementById("btn-rename").classList.remove("hidden");
  document.title = `${name} — Remote Encoder`;
}
function startRename() {
  document.getElementById("rename-input").value = document.getElementById(
    "device-name-display",
  ).textContent;
  document.getElementById("device-name-wrap").classList.add("hidden");
  const form = document.getElementById("rename-form");
  form.classList.remove("hidden");
  form.style.display = "flex";
  document.getElementById("rename-input").focus();
  document.getElementById("rename-input").select();
}
function saveRename() {
  const name = document.getElementById("rename-input").value.trim();
  if (name) {
    setDeviceName(name);
    persistDevice(KEY, name);
    pushNotification({
      type: "success",
      msg: "Device renamed.",
      is_dismissable: true,
    });
  }
  cancelRename();
}
function cancelRename() {
  document.getElementById("rename-form").classList.add("hidden");
  document.getElementById("rename-form").style.display = "";
  document.getElementById("device-name-wrap").classList.remove("hidden");
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pushNotification({
      type: "warning",
      msg: "Not connected to server.",
      is_dismissable: true,
    });
    return;
  }
  ws.send(JSON.stringify(payload));
}
const syncSelect = (id, val) => {
  const el = document.getElementById(id);
  if (el) el.value = val;
};
const syncRange = (id, val, lbl) => {
  const el = document.getElementById(id);
  if (el) el.value = val;
  if (lbl) {
    const l = document.getElementById(lbl);
    if (l) l.textContent = val;
  }
};
const setVal = (id, val) => {
  const el = document.getElementById(id);
  if (el) el.value = val ?? "";
};
const humanize = (s) =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function setDeviceConfigField(id, val) {
  if (val === undefined) return;
  lastDeviceConfig[id] = val ?? "";
  if (!dirtyFields.has(id)) setVal(id, val);
}
function markDirty(id) {
  dirtyFields.add(id);
  document.getElementById(`${id}-reset`)?.classList.remove("hidden");
}
function clearDirty(id) {
  dirtyFields.delete(id);
  document.getElementById(`${id}-reset`)?.classList.add("hidden");
}
function resetField(id) {
  setVal(id, lastDeviceConfig[id] ?? "");
  clearDirty(id);
}

Object.assign(window, {
  toggleStream,
  onBitrateChange,
  onConfigChange,
  sendCommand,
  confirmCmd,
  closeDialog,
  toggleNetif,
  toggleSSH,
  resetSSH,
  toggleSshPassVis,
  wifiScan,
  wifiConnectToggle,
  wifiConnectWithPass,
  wifiForget,
  toggleAutostart,
  triggerUpdate,
  renderUpdateBtn,
  dismissNotification,
  copyDeviceKey,
  copyControlUrl,
  startRename,
  saveRename,
  cancelRename,
  markDirty,
  clearDirty,
  resetField,
});
