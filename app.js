document.addEventListener("DOMContentLoaded", async () => {
  // ===== DOM =====
  const form = document.getElementById("editForm");

  const locateBtn = document.getElementById("locateBtn");
  const newSiteBtn = document.getElementById("newSiteBtn");
  const clearSelBtn = document.getElementById("clearSelBtn");

  const refreshBtn = document.getElementById("refreshBtn");
  const commitBtn = document.getElementById("commitBtn");
  const diffBtn = document.getElementById("diffBtn");
  const dirtyBadgeBtn = document.getElementById("dirtyBadge");

  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const userBadge = document.getElementById("userBadge");

  const selTitle = document.getElementById("selTitle");
  const selSub = document.getElementById("selSub");
  const latVal = document.getElementById("latVal");
  const lngVal = document.getElementById("lngVal");

  const diffDialog = document.getElementById("diffDialog");
  const diffBody = document.getElementById("diffBody");

  const commitDialog = document.getElementById("commitDialog");
  const commitSummary = document.getElementById("commitSummary");
  const commitMsg = document.getElementById("commitMsg");

  // ===== Map =====
  if (!window.L) {
    alert("Leaflet nie je načítaný.");
    return;
  }

  const map = L.map("map", { zoomControl: false }).setView([48.7164, 21.2611], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  const markersLayer = L.layerGroup().addTo(map);

  // ===== State =====
  let geojsonData = null;
  let originalSnapshot = null; // deep copy of last loaded file (for diff)
  let selectedFeature = null;
  let selectedMarker = null;
  let selectedIdx = null;

  const dirtyKeys = new Set(); // feature keys + "__file__"
  let movedCount = 0;

  // Map markers by key
  const markerByKey = new Map();

  // ===== Container types for field work =====
  // count-only UX (+/-). Liter defaults are prefilled.
  const CONTAINERS = [
    { key: "glass", label: "Sklo", liters: 1100, color: "#7fd3ff", icon: "◯" },
    { key: "mixed", label: "Zmes", liters: 1100, color: "#c9c9c9", icon: "■" },
    { key: "plastic", label: "Plast", liters: 1100, color: "#ffd36a", icon: "△" },
    { key: "paper", label: "Papier", liters: 1100, color: "#79a7ff", icon: "▤" },
    { key: "bio", label: "Bio", liters: 240, color: "#9be59b", icon: "✿" },
    { key: "oil", label: "Olej", liters: 240, color: "#ff9a6a", icon: "滴" },
  ];

  // ===== Helpers =====
  function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function ensureId(feature) {
    const p = (feature.properties ||= {});
    if (!p.site_id) {
      p.site_id = `site_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    }
  }

  function featureKey(feature, idx) {
    const p = feature?.properties || {};
    return p.site_id || p.id || feature.id || `idx:${idx}`;
  }

  function setEditing(on) {
    document.body.classList.toggle("editing", !!on);
    setTimeout(() => map.invalidateSize(), 180);
  }

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function normalizeContainers(p) {
    if (!Array.isArray(p.containers)) p.containers = [];
    // normalize to {fraction, label, volume_l, count}
    p.containers = p.containers.map((c) => {
      if (!isObj(c)) return null;
      const fraction = (c.fraction ?? c.waste ?? c.type ?? "").toString();
      const label = (c.label ?? "").toString() || fraction;
      const volume_l = Number(c.volume_l ?? c.volume ?? c.liters ?? 0) || 0;
      const count = Number(c.count ?? 1) || 1;
      return { ...c, fraction, label, volume_l, count };
    }).filter(Boolean);
  }

  function getContainerCount(p, key) {
    normalizeContainers(p);
    const found = p.containers.find(x => x.fraction === key);
    return found ? (Number(found.count) || 0) : 0;
  }

  function setContainerCount(p, key, label, liters, newCount) {
    normalizeContainers(p);
    const i = p.containers.findIndex(x => x.fraction === key);
    if (newCount <= 0) {
      if (i >= 0) p.containers.splice(i, 1);
      return;
    }
    const obj = { fraction: key, label, volume_l: liters, count: newCount };
    if (i >= 0) p.containers[i] = { ...p.containers[i], ...obj };
    else p.containers.push(obj);
  }

  function updateCoordsUI(feature) {
    const [lng, lat] = feature.geometry.coordinates;
    if (latVal) latVal.textContent = Number(lat).toFixed(6);
    if (lngVal) lngVal.textContent = Number(lng).toFixed(6);
  }

  function updateAuthUI(user) {
    const token = Auth.getToken();
    if (token && user) {
      userBadge.textContent = `@${user.login}`;
      loginBtn.hidden = true;
      logoutBtn.hidden = false;
      commitBtn.disabled = dirtyKeys.size === 0;
    } else {
      userBadge.textContent = "Neprihlásený";
      loginBtn.hidden = false;
      logoutBtn.hidden = true;
      commitBtn.disabled = true;
    }
  }

  async function refreshUser() {
    const token = Auth.getToken();
    if (!token) return updateAuthUI(null);
    try {
      const user = await GH.getViewer(token);
      updateAuthUI(user);
    } catch {
      Auth.logout();
      updateAuthUI(null);
    }
  }

  function setDirty(key) {
    dirtyKeys.add(key);
    updateDirtyUI();
    updateMarkerStyle(key);
  }

  function clearDirtyAll() {
    dirtyKeys.clear();
    movedCount = 0;
    updateDirtyUI();
    // refresh marker colors
    for (const k of markerByKey.keys()) updateMarkerStyle(k);
  }

  function updateDirtyUI() {
    const count = [...dirtyKeys].filter(k => k !== "__file__").length || (dirtyKeys.size ? 1 : 0);
    if (dirtyBadgeBtn) dirtyBadgeBtn.textContent = `Zmeny: ${count}`;
    if (diffBtn) diffBtn.disabled = dirtyKeys.size === 0;
    if (dirtyBadgeBtn) dirtyBadgeBtn.disabled = dirtyKeys.size === 0;
    if (commitBtn) commitBtn.disabled = !(Auth.getToken() && dirtyKeys.size > 0);
  }

  function makeDivIcon(isDirty) {
    // simple dot marker (blue / red)
    const color = isDirty ? "#d32f2f" : "#1e88e5";
    const html = `
      <div style="
        width:18px;height:18px;border-radius:999px;
        background:${color};
        border:2px solid rgba(255,255,255,0.95);
        box-shadow:0 2px 8px rgba(0,0,0,0.35);
      "></div>`;
    return L.divIcon({ className: "", html, iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  function updateMarkerStyle(key) {
    const entry = markerByKey.get(key);
    if (!entry) return;
    const isDirty = dirtyKeys.has(key) || dirtyKeys.has("__file__");
    entry.marker.setIcon(makeDivIcon(isDirty));
  }

  function clearSelectionUI() {
    selectedFeature = null;
    selectedMarker = null;
    selectedIdx = null;
    if (selTitle) selTitle.textContent = "Vyber stanovište";
    if (selSub) selSub.textContent = "Klikni na marker v mape.";
    if (latVal) latVal.textContent = "—";
    if (lngVal) lngVal.textContent = "—";
    setEditing(false);

    if (form) {
      form.innerHTML = `<div class="hint">
        Terénny flow:<br/>
        1) Klikni na stanovište (marker)<br/>
        2) Skontroluj GPS (ťahaj marker ak treba)<br/>
        3) Uprav názov/poznámku, typ, zámok<br/>
        4) Klikaj +/− na nádoby<br/>
        5) Označ “Skontrolované”
      </div>`;
    }
  }

  // ===== Simple diff =====
  function findOriginalFeatureByKey(key) {
    if (!originalSnapshot?.features) return null;
    const f = originalSnapshot.features.find((ft, idx) => featureKey(ft, idx) === key);
    return f || null;
  }

  function summarizeChangesForFeature(current, original) {
    const changes = [];

    // coords
    const c1 = current?.geometry?.coordinates;
    const c0 = original?.geometry?.coordinates;
    if (Array.isArray(c1) && Array.isArray(c0) && (c1[0] !== c0[0] || c1[1] !== c0[1])) {
      changes.push(`coordinates: [${c0[0]}, ${c0[1]}] → [${c1[0]}, ${c1[1]}]`);
    }

    const p1 = current?.properties || {};
    const p0 = original?.properties || {};

    const KEYS = [
      "name", "note",
      "site_kind", "has_lock",
      "verified", "accessible",
      "cleanliness", "wear", "issues"
    ];

    for (const k of KEYS) {
      const a = p0[k];
      const b = p1[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push(`${k}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
      }
    }

    // containers summary
    const cont0 = (p0.containers || []).map(x => ({ fraction: x.fraction ?? x.waste ?? x.type, count: x.count ?? 1, volume_l: x.volume_l ?? x.volume ?? x.liters })).sort((a,b)=>String(a.fraction).localeCompare(String(b.fraction)));
    const cont1 = (p1.containers || []).map(x => ({ fraction: x.fraction ?? x.waste ?? x.type, count: x.count ?? 1, volume_l: x.volume_l ?? x.volume ?? x.liters })).sort((a,b)=>String(a.fraction).localeCompare(String(b.fraction)));
    if (JSON.stringify(cont0) !== JSON.stringify(cont1)) {
      changes.push(`containers: ${JSON.stringify(cont0)} → ${JSON.stringify(cont1)}`);
    }

    return changes;
  }

  function openDiffDialog() {
    if (!diffDialog || !diffBody) return;

    diffBody.innerHTML = "";

    const keys = [...dirtyKeys].filter(k => k !== "__file__");
    if (keys.length === 0 && dirtyKeys.size > 0) {
      const d = document.createElement("div");
      d.className = "diffItem";
      d.innerHTML = `<b>Zmeny</b><div class="kv">Zmeny na súbore (pridané/odstránené stanovištia alebo iné štrukturálne zmeny).</div>`;
      diffBody.appendChild(d);
    }

    for (const key of keys) {
      const entry = markerByKey.get(key);
      const current = entry?.feature || null;
      const original = findOriginalFeatureByKey(key);

      const title = (current?.properties?.name || current?.properties?.site_id || key);
      const changes = original ? summarizeChangesForFeature(current, original) : ["(nové stanovište alebo nenájdený originál)"];

      const box = document.createElement("div");
      box.className = "diffItem";
      box.innerHTML = `<b>${title}</b><div class="kv">${changes.join("\n")}</div>`;
      diffBody.appendChild(box);
    }

    diffDialog.showModal();
  }

  // ===== Form UI (field work) =====
  function mkSection(title) {
    const s = document.createElement("div");
    s.className = "section";
    const h = document.createElement("div");
    h.className = "sectionTitle";
    h.textContent = title;
    s.appendChild(h);
    return s;
  }

  function mkRow(labelText, el) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(el);
    return row;
  }

  function mkInput(value, onInput, placeholder="") {
    const input = document.createElement("input");
    input.value = (value ?? "").toString();
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function mkTextarea(value, onChange, rows = 3) {
    const ta = document.createElement("textarea");
    ta.rows = rows;
    ta.value = (value ?? "").toString();
    ta.addEventListener("change", () => onChange(ta.value));
    return ta;
  }

  function mkSelect(value, options, onChange) {
    const sel = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    sel.value = value ?? "";
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  function mkToggleButton(isOn, textOff, textOn, onToggle) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `toggleBtn ${isOn ? "on" : ""}`;
    b.textContent = isOn ? textOn : textOff;
    b.addEventListener("click", () => onToggle(!isOn));
    return b;
  }

  function mkRange(value, min, max, step, onInput) {
    const wrap = document.createElement("div");
    wrap.className = "rangeWrap";

    const r = document.createElement("input");
    r.type = "range";
    r.min = String(min);
    r.max = String(max);
    r.step = String(step);
    r.value = String(value ?? min);

    const v = document.createElement("div");
    v.className = "rangeVal";
    v.textContent = r.value;

    r.addEventListener("input", () => {
      v.textContent = r.value;
      onInput(Number(r.value));
    });

    wrap.appendChild(r);
    wrap.appendChild(v);
    return wrap;
  }

  function buildForm(feature, idx) {
    if (!form) return;

    ensureId(feature);
    const p = (feature.properties ||= {});
    normalizeContainers(p);

    form.innerHTML = "";

    // QUICK: name + note
    const sQuick = mkSection("Rýchle údaje");
    {
      const name = mkInput(p.name ?? "", (v) => { p.name = v; setDirty(featureKey(feature, idx)); if (selTitle) selTitle.textContent = v || (p.site_id || "Vybraný bod"); });
      sQuick.appendChild(mkRow("Názov", name));

      const note = mkTextarea(p.note ?? "", (v) => { p.note = v; setDirty(featureKey(feature, idx)); }, 3);
      sQuick.appendChild(mkRow("Poznámka", note));
    }
    form.appendChild(sQuick);

    // STATUS: type + lock (dropdowns)
    const sStatus = mkSection("Stanovište");
    {
      const kind = mkSelect(
        p.site_kind ?? "",
        [
          { value: "", label: "Typ (vyber)" },
          { value: "open", label: "Otvorené" },
          { value: "closed", label: "Zatvorené" },
          { value: "underground", label: "Podzemné" },
          { value: "semi_underground", label: "Polopodzemné" },
        ],
        (v) => { p.site_kind = v; setDirty(featureKey(feature, idx)); }
      );
      sStatus.appendChild(mkRow("Typ", kind));

      const lock = mkSelect(
        (p.has_lock === true) ? "yes" : (p.has_lock === false) ? "no" : "",
        [
          { value: "", label: "Zámok (vyber)" },
          { value: "yes", label: "Má zámok" },
          { value: "no", label: "Nemá zámok" },
        ],
        (v) => { p.has_lock = (v === "yes") ? true : (v === "no") ? false : null; setDirty(featureKey(feature, idx)); }
      );
      sStatus.appendChild(mkRow("Zámok", lock));
    }
    form.appendChild(sStatus);

    // CONTAINERS: +/- counts
    const sCont = mkSection("Nádoby (klikaj + / −)");
    {
      const grid = document.createElement("div");
      grid.className = "containerGrid";

      for (const t of CONTAINERS) {
        const card = document.createElement("div");
        card.className = "cCard";

        const head = document.createElement("div");
        head.className = "cHead";

        const icon = document.createElement("div");
        icon.className = "cIcon";
        icon.style.background = t.color + "33";
        icon.style.border = `1px solid ${t.color}`;
        icon.innerHTML = `<span style="font-weight:900">${t.icon}</span>`;

        const info = document.createElement("div");
        const title = document.createElement("div");
        title.className = "cTitle";
        title.textContent = t.label;
        const meta = document.createElement("div");
        meta.className = "cMeta";
        meta.textContent = `${t.liters} l (predvoľba)`;

        info.appendChild(title);
        info.appendChild(meta);

        head.appendChild(icon);
        head.appendChild(info);

        const countRow = document.createElement("div");
        countRow.className = "cCount";

        const minus = document.createElement("button");
        minus.type = "button";
        minus.className = "pmBtn minus";
        minus.textContent = "−";

        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "pmBtn";
        plus.textContent = "+";

        const countSpan = document.createElement("span");
        countSpan.textContent = String(getContainerCount(p, t.key));

        const applyCount = (newCount) => {
          setContainerCount(p, t.key, t.label, t.liters, newCount);
          countSpan.textContent = String(getContainerCount(p, t.key));
          setDirty(featureKey(feature, idx));
        };

        minus.addEventListener("click", () => applyCount(getContainerCount(p, t.key) - 1));
        plus.addEventListener("click", () => applyCount(getContainerCount(p, t.key) + 1));

        countRow.appendChild(minus);
        countRow.appendChild(countSpan);
        countRow.appendChild(plus);

        card.appendChild(head);
        card.appendChild(countRow);

        grid.appendChild(card);
      }

      sCont.appendChild(grid);

      const hint = document.createElement("div");
      hint.className = "small";
      hint.textContent = "Tip: Ak sú rôzne objemy, doplň to v Pokročilé (JSON).";
      sCont.appendChild(hint);
    }
    form.appendChild(sCont);

    // CHECK / ACCESSIBILITY / SLIDERS / ISSUES
    const sCheck = mkSection("Kontrola");
    {
      const verified = (p.verified === true);
      const btn = mkToggleButton(
        verified,
        "Označiť ako skontrolované",
        "Skontrolované ✓ (klikni pre zrušenie)",
        async (next) => {
          p.verified = next;
          if (next) {
            p.verified_at = new Date().toISOString();
            try {
              const token = Auth.getToken();
              if (token) {
                const user = await GH.getViewer(token);
                p.verified_by = user.login;
              }
            } catch {}
          }
          setDirty(featureKey(feature, idx));
          buildForm(feature, idx); // refresh button text
        }
      );
      sCheck.appendChild(btn);

      const acc = mkSelect(
        (p.accessible === true) ? "yes" : (p.accessible === false) ? "no" : "",
        [
          { value: "", label: "Bezbariérové? (vyber)" },
          { value: "yes", label: "Áno" },
          { value: "no", label: "Nie" },
        ],
        (v) => { p.accessible = (v === "yes") ? true : (v === "no") ? false : null; setDirty(featureKey(feature, idx)); }
      );
      sCheck.appendChild(mkRow("Bezbariérové", acc));

      const clean = (Number.isFinite(p.cleanliness) ? p.cleanliness : 3);
      const wear = (Number.isFinite(p.wear) ? p.wear : 3);

      sCheck.appendChild(mkRow("Index čistoty (0–5)", mkRange(clean, 0, 5, 1, (v) => { p.cleanliness = v; setDirty(featureKey(feature, idx)); })));
      sCheck.appendChild(mkRow("Index opotrebenia (0–5)", mkRange(wear, 0, 5, 1, (v) => { p.wear = v; setDirty(featureKey(feature, idx)); })));

      const issues = mkTextarea(p.issues ?? "", (v) => { p.issues = v; setDirty(featureKey(feature, idx)); }, 3);
      sCheck.appendChild(mkRow("Závady / poznámky z terénu", issues));

      const info = document.createElement("div");
      info.className = "small";
      if (p.verified === true) {
        const by = p.verified_by ? `@${p.verified_by}` : "—";
        const at = p.verified_at ? p.verified_at : "—";
        info.textContent = `Posledná kontrola: ${by} • ${at}`;
      } else {
        info.textContent = "Zatiaľ nie je označené ako skontrolované.";
      }
      sCheck.appendChild(info);
    }
    form.appendChild(sCheck);

    // ADVANCED (collapsed)
    const adv = document.createElement("details");
    adv.className = "section";
    adv.open = false;
    const sum = document.createElement("summary");
    sum.textContent = "Pokročilé (ID/adresa/mestská časť/JSON)";
    adv.appendChild(sum);

    const body = document.createElement("div");
    body.style.marginTop = "10px";

    const siteId = mkInput(p.site_id ?? "", (v) => { p.site_id = v; setDirty(featureKey(feature, idx)); }, "site_id");
    body.appendChild(mkRow("ID (site_id)", siteId));

    const addr = mkInput(p.address ?? "", (v) => { p.address = v; setDirty(featureKey(feature, idx)); }, "adresa");
    body.appendChild(mkRow("Adresa", addr));

    const dist = mkInput(p.district ?? "", (v) => { p.district = v; setDirty(featureKey(feature, idx)); }, "mestská časť");
    body.appendChild(mkRow("Mestská časť", dist));

    const raw = document.createElement("textarea");
    raw.rows = 10;
    raw.value = JSON.stringify(p, null, 2);

    const err = document.createElement("div");
    err.className = "small";
    err.style.color = "crimson";
    err.style.display = "none";

    raw.addEventListener("change", () => {
      try {
        const parsed = JSON.parse(raw.value);
        if (!isObj(parsed)) throw new Error("not object");
        feature.properties = parsed;
        setDirty(featureKey(feature, idx));
        err.style.display = "none";
        buildForm(feature, idx);
      } catch {
        err.textContent = "Neplatný JSON – zmeny sa neuložili.";
        err.style.display = "block";
      }
    });

    body.appendChild(mkRow("Properties (JSON)", raw));
    body.appendChild(err);

    adv.appendChild(body);
    form.appendChild(adv);
  }

  // ===== Draw & select =====
  function selectFeature(feature, marker, idx) {
    selectedFeature = feature;
    selectedMarker = marker;
    selectedIdx = idx;

    ensureId(feature);

    const p = feature.properties || {};
    if (selTitle) selTitle.textContent = p.name || p.site_id || "Vybraný bod";
    if (selSub) selSub.textContent = "Terénny režim: názov → typ/zámok → nádoby → kontrola.";

    updateCoordsUI(feature);
    setEditing(true);
    buildForm(feature, idx);

    // keep marker draggable and visible
  }

  function drawFeatures() {
    markersLayer.clearLayers();
    markerByKey.clear();

    selectedFeature = null;
    selectedMarker = null;
    selectedIdx = null;

    clearSelectionUI();

    const latlngs = [];

    geojsonData.features.forEach((feature, idx) => {
      if (!feature?.geometry || feature.geometry.type !== "Point") return;
      ensureId(feature);

      const [lng, lat] = feature.geometry.coordinates;
      if (typeof lat !== "number" || typeof lng !== "number") return;

      const key = featureKey(feature, idx);
      const isDirty = dirtyKeys.has(key) || dirtyKeys.has("__file__");

      const marker = L.marker([lat, lng], { draggable: true, icon: makeDivIcon(isDirty) }).addTo(markersLayer);

      marker.on("click", () => selectFeature(feature, marker, idx));

      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        feature.geometry.coordinates = [pos.lng, pos.lat];
        movedCount += 1;
        setDirty(key);
        if (selectedFeature === feature) updateCoordsUI(feature);
      });

      markerByKey.set(key, { marker, feature, idx });
      latlngs.push([lat, lng]);
    });

    if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs).pad(0.1));
  }

  async function loadGeoJSON() {
    const url = `/${GH.FILE_PATH}?v=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`GeoJSON load failed: ${r.status}`);
    geojsonData = await r.json();
    if (geojsonData.type !== "FeatureCollection" || !Array.isArray(geojsonData.features)) {
      throw new Error("Not a FeatureCollection");
    }
    originalSnapshot = deepCopy(geojsonData);
    drawFeatures();
  }

  // ===== Map controls =====
  if (locateBtn) {
    locateBtn.addEventListener("click", () => {
      map.locate({ setView: true, maxZoom: 18, watch: false, enableHighAccuracy: true });
    });
  }

  map.on("locationerror", () => alert("Nepodarilo sa získať polohu."));

  map.on("locationfound", (e) => {
    // show a small dot for gps
    const ll = e.latlng;
    // create/update
    if (!window.__gpsDot) {
      window.__gpsDot = L.circleMarker(ll, { radius: 6 }).addTo(map);
    } else {
      window.__gpsDot.setLatLng(ll);
    }
  });

  if (newSiteBtn) {
    newSiteBtn.addEventListener("click", () => {
      if (!geojsonData) return;
      const center = map.getCenter();

      const f = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [center.lng, center.lat] },
        properties: {
          site_id: `site_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          name: "",
          note: "",
          site_kind: "",
          has_lock: null,
          containers: [],
          verified: false,
          accessible: null,
          cleanliness: 3,
          wear: 3,
          issues: ""
        }
      };

      geojsonData.features.push(f);
      dirtyKeys.add("__file__");
      const key = featureKey(f, geojsonData.features.length - 1);
      dirtyKeys.add(key);
      updateDirtyUI();

      drawFeatures();

      // select new one by reference
      const found = [...markerByKey.values()].find(x => x.feature === f);
      if (found) {
        map.setView(found.marker.getLatLng(), Math.max(map.getZoom(), 18));
        selectFeature(found.feature, found.marker, found.idx);
      }
    });
  }

  if (clearSelBtn) {
    clearSelBtn.addEventListener("click", () => {
      clearSelectionUI();
    });
  }

  // ===== Diff =====
  if (diffBtn) diffBtn.addEventListener("click", openDiffDialog);
  if (dirtyBadgeBtn) dirtyBadgeBtn.addEventListener("click", openDiffDialog);

  // ===== Refresh =====
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      try {
        await loadGeoJSON();
        clearDirtyAll();
        alert("Načítané najnovšie dáta.");
      } catch (e) {
        console.error(e);
        alert("Refresh zlyhal. Pozri Console.");
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }

  // ===== Auth =====
  if (loginBtn) loginBtn.addEventListener("click", () => Auth.startLogin());
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      Auth.logout();
      refreshUser();
      updateDirtyUI();
    });
  }

  // ===== Commit workflow =====
  if (commitBtn) {
    commitBtn.addEventListener("click", () => {
      if (!commitDialog) return;
      commitSummary.textContent = `Zmeny: ${dirtyKeys.size} • presuny: ${movedCount} • features: ${geojsonData?.features?.length ?? "?"}`;
      commitMsg.value = `Fix: terénna kontrola (${dirtyKeys.size})`;
      commitDialog.showModal();
    });
  }

  if (commitDialog) {
    commitDialog.addEventListener("close", async () => {
      if (commitDialog.returnValue !== "ok") return;

      const token = Auth.getToken();
      if (!token) return;

      const msg = (commitMsg?.value || "").trim();
      if (!msg) return;

      commitBtn.disabled = true;

      try {
        const baseSha = await GH.getRefSha(token, GH.BASE_BRANCH);

        const user = await GH.getViewer(token);
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const branch = `edit/${user.login}/${ts}`;

        await GH.createBranch(token, branch, baseSha);

        const fileSha = await GH.getFileSha(token, GH.FILE_PATH, GH.BASE_BRANCH);

        const newContent = JSON.stringify(geojsonData, null, 2);
        await GH.putFile(token, GH.FILE_PATH, branch, msg, newContent, fileSha);

        const pr = await GH.openPR(
          token,
          branch,
          msg,
          `Editor: @${user.login}\nZmeny: ${dirtyKeys.size}\nPresuny: ${movedCount}\nFeatures: ${geojsonData.features.length}`
        );

        // reset dirty + refresh original snapshot baseline
        originalSnapshot = deepCopy(geojsonData);
        clearDirtyAll();

        alert(`Hotovo! PR: ${pr.html_url}\nPo merge klikni Refresh.`);
      } catch (err) {
        console.error(err);
        alert("Commit/PR zlyhalo. Pozri Console log.");
      } finally {
        await refreshUser();
        updateDirtyUI();
      }
    });
  }

  // ===== Init =====
  clearSelectionUI();

  try {
    await loadGeoJSON();
  } catch (e) {
    console.error("GeoJSON load error:", e);
    alert("Nepodarilo sa načítať GeoJSON. Skontroluj GH.FILE_PATH a že súbor existuje v deployi.");
  }

  try {
    await refreshUser();
  } catch (e) {
    console.error("Auth/user refresh error:", e);
  }

  updateDirtyUI();
  setTimeout(() => map.invalidateSize(), 250);
});
