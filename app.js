document.addEventListener("DOMContentLoaded", async () => {
  // ===== DOM =====
  const form = document.getElementById("editForm");

  const locateBtn = document.getElementById("locateBtn");
  const mapToggleBtn = document.getElementById("mapToggleBtn");
  const centerSelBtn = document.getElementById("centerSelBtn");
  const snapToGpsBtn = document.getElementById("snapToGpsBtn");

  const selTitle = document.getElementById("selTitle");
  const selSub = document.getElementById("selSub");
  const latVal = document.getElementById("latVal");
  const lngVal = document.getElementById("lngVal");
  const dirtyBadge = document.getElementById("dirtyBadge");

  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const userBadge = document.getElementById("userBadge");

  const newSiteBtn = document.getElementById("newSiteBtn");
  const deleteSiteBtn = document.getElementById("deleteSiteBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const commitBtn = document.getElementById("commitBtn");

  const commitDialog = document.getElementById("commitDialog");
  const commitSummary = document.getElementById("commitSummary");
  const commitMsg = document.getElementById("commitMsg");

  const addContainerDialog = document.getElementById("addContainerDialog");
  const containerTypeGrid = document.getElementById("containerTypeGrid");
  const containerVolume = document.getElementById("containerVolume");
  const containerCount = document.getElementById("containerCount");

  // ===== Map =====
  if (!window.L) {
    alert("Leaflet nie je načítaný. Skontroluj <script leaflet.js> v index.html.");
    return;
  }

  const map = L.map("map").setView([48.7164, 21.2611], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  const markersLayer = L.layerGroup().addTo(map);

  // ===== State =====
  let geojsonData = null;
  let selectedFeature = null;
  let selectedMarker = null;
  let selectedIdx = null;

  let lastGpsLatLng = null;
  let gpsMarker = null;

  const dirtyIds = new Set();
  let movedCount = 0;

  // map selection lookup after redraw
  let markerByKey = new Map();

  // ===== Container presets =====
  // (ak chcete iné default litre, stačí zmeniť tu)
  const CONTAINER_PRESETS = [
    { key: "glass", label: "Sklo", defaultVolume: 1100 },
    { key: "mixed", label: "Zmes", defaultVolume: 1100 },
    { key: "plastic", label: "Plast", defaultVolume: 1100 },
    { key: "paper", label: "Papier", defaultVolume: 1100 },
    { key: "bio", label: "Bio", defaultVolume: 240 },
    { key: "oil", label: "Olej", defaultVolume: 240 },
  ];

  // ===== Helpers =====
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

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function markDirty(feature, idx) {
    dirtyIds.add(featureKey(feature, idx));
    updateDirtyUI();
  }

  function markFileDirty() {
    dirtyIds.add("__file__");
    updateDirtyUI();
  }

  function updateDirtyUI() {
    if (dirtyBadge) dirtyBadge.textContent = `Zmeny: ${dirtyIds.size}`;
    if (commitBtn) commitBtn.disabled = !(Auth.getToken() && dirtyIds.size > 0);
  }

  function updateAuthUI(user) {
    const token = Auth.getToken();
    if (token && user) {
      if (userBadge) userBadge.textContent = `@${user.login}`;
      if (loginBtn) loginBtn.hidden = true;
      if (logoutBtn) logoutBtn.hidden = false;
      if (commitBtn) commitBtn.disabled = dirtyIds.size === 0;
    } else {
      if (userBadge) userBadge.textContent = "Neprihlásený";
      if (loginBtn) loginBtn.hidden = false;
      if (logoutBtn) logoutBtn.hidden = true;
      if (commitBtn) commitBtn.disabled = true;
    }
  }

  async function refreshUser() {
    const token = Auth.getToken();
    if (!token) return updateAuthUI(null);
    try {
      const user = await GH.getViewer(token);
      updateAuthUI(user);
    } catch (e) {
      console.error("refreshUser failed:", e);
      Auth.logout();
      updateAuthUI(null);
    }
  }

  function updateCoordsUI(feature) {
    const [lng, lat] = feature.geometry.coordinates;
    if (latVal) latVal.textContent = Number(lat).toFixed(6);
    if (lngVal) lngVal.textContent = Number(lng).toFixed(6);
  }

  function setEditingMode(on) {
    document.body.classList.toggle("editing", !!on);
  }

  function setMapExpanded(on) {
    document.body.classList.toggle("mapExpanded", !!on);
    if (mapToggleBtn) mapToggleBtn.textContent = document.body.classList.contains("mapExpanded") ? "Viac edit" : "Viac mapy";
    setTimeout(() => map.invalidateSize(), 220);
  }

  function clearSelectionUI() {
    if (selTitle) selTitle.textContent = "Vyber stanovište";
    if (selSub) selSub.textContent = "Klikni na marker alebo vytvor nové.";
    if (latVal) latVal.textContent = "—";
    if (lngVal) lngVal.textContent = "—";
    if (centerSelBtn) centerSelBtn.disabled = true;
    if (snapToGpsBtn) snapToGpsBtn.disabled = true;

    if (deleteSiteBtn) { deleteSiteBtn.hidden = true; deleteSiteBtn.disabled = true; }
    setEditingMode(false);

    if (form) {
      form.innerHTML = `<div class="hint">
        Terénny flow:<br/>
        1) Skontroluj GPS (Moja poloha / Presuň na GPS)<br/>
        2) Vyber typ stanovišťa + zamok<br/>
        3) Pridaj nádoby cez “+ Nádoba”<br/>
        4) Označ “Skontrolované”
      </div>`;
    }
  }

  // ===== UI builders =====
  function mkSection(title, rightEl = null) {
    const s = document.createElement("div");
    s.className = "section";

    const head = document.createElement("div");
    head.className = "sectionTitle";
    head.textContent = title;

    if (rightEl) {
      head.textContent = "";
      const left = document.createElement("div");
      left.textContent = title;
      left.style.fontWeight = "900";
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.justifyContent = "space-between";
      wrap.style.width = "100%";
      wrap.appendChild(left);
      wrap.appendChild(rightEl);
      head.appendChild(wrap);
    }

    s.appendChild(head);
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

  function mkInput(value, onInput, placeholder = "") {
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

  function mkYesNo(value, onChange) {
    return mkSelect(
      value === true ? "yes" : value === false ? "no" : "",
      [
        { value: "", label: "—" },
        { value: "yes", label: "Áno" },
        { value: "no", label: "Nie" }
      ],
      (v) => onChange(v === "yes" ? true : v === "no" ? false : null)
    );
  }

  function normalizeContainers(p) {
    if (!Array.isArray(p.containers)) p.containers = [];
  }

  function renderContainersList(p, feature, idx, containerListEl) {
    containerListEl.innerHTML = "";
    if (p.containers.length === 0) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Zatiaľ žiadne nádoby. Klikni “+ Nádoba”.";
      containerListEl.appendChild(hint);
      return;
    }

    p.containers.forEach((c, cIdx) => {
      if (!isPlainObject(c)) c = p.containers[cIdx] = {};

      // tolerantné mapovanie fieldov (aby sme sa vedeli prispôsobiť tvojmu geojsonu)
      const fraction = (c.fraction ?? c.waste ?? c.type ?? "").toString();
      const vol = (c.volume_l ?? c.volume ?? c.liters ?? "").toString();
      const count = (c.count ?? 1);

      const item = document.createElement("div");
      item.className = "containerItem";

      const main = document.createElement("div");
      main.className = "containerMain";

      const t = document.createElement("div");
      t.className = "containerTitle";
      t.textContent = fraction || `Nádoba #${cIdx + 1}`;

      const meta = document.createElement("div");
      meta.className = "containerMeta";
      meta.textContent = `${count} ks • ${vol ? vol + " l" : "objem ?"}`;

      main.appendChild(t);
      main.appendChild(meta);

      const btns = document.createElement("div");
      btns.className = "containerBtns";

      const minus = document.createElement("button");
      minus.type = "button";
      minus.className = "iconBtn danger";
      minus.textContent = "−";
      minus.addEventListener("click", () => {
        p.containers.splice(cIdx, 1);
        markDirty(feature, idx);
        markFileDirty();
        buildForm(feature, idx);
      });

      btns.appendChild(minus);
      item.appendChild(main);
      item.appendChild(btns);

      containerListEl.appendChild(item);
    });
  }

  function buildForm(feature, idx) {
    if (!form) return;

    ensureId(feature);
    const p = (feature.properties ||= {});
    normalizeContainers(p);

    // Minimal visible fields for field work
    // - GPS controls are in header
    // - Visible: popis + typ stanovišťa + zamok + nádoby + skontrolované
    // - Advanced: site_id, address, district, city, operator + raw JSON

    form.innerHTML = "";

    // SECTION: Quick edit
    const sQuick = mkSection("Rýchle údaje");
    {
      const desc = mkTextarea(p.description ?? p.note ?? "", (v) => {
        // keep both if you want; keep note as canonical
        p.note = v;
        p.description = v;
        markDirty(feature, idx);
      }, 3);
      sQuick.appendChild(mkRow("Popis / poznámka", desc));

      const siteKind = mkSelect(
        p.site_kind ?? p.kind ?? "",
        [
          { value: "", label: "Typ stanovišťa (vyber)" },
          { value: "open", label: "Otvorené" },
          { value: "closed", label: "Zatvorené" },
          { value: "underground", label: "Podzemné" },
          { value: "semi_underground", label: "Polopodzemné" }
        ],
        (v) => {
          p.site_kind = v;
          p.kind = v;
          markDirty(feature, idx);
        }
      );
      sQuick.appendChild(mkRow("Typ", siteKind));

      const hasLock = mkYesNo(
        (p.has_lock ?? p.locked ?? null),
        (val) => {
          // store both for compatibility
          p.has_lock = val;
          p.locked = val;
          markDirty(feature, idx);
        }
      );
      sQuick.appendChild(mkRow("Zámok", hasLock));
    }
    form.appendChild(sQuick);

    // SECTION: Containers
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "iconBtn";
    addBtn.textContent = "+ Nádoba";
    addBtn.addEventListener("click", () => openAddContainerDialog(feature, idx));

    const sCont = mkSection("Nádoby", addBtn);
    const list = document.createElement("div");
    list.className = "containerList";
    renderContainersList(p, feature, idx, list);
    sCont.appendChild(list);

    const smallHint = document.createElement("div");
    smallHint.className = "small";
    smallHint.textContent = "Tip: pridávaj rýchlo cez typy (Sklo/Zmes/Plast/…).";
    sCont.appendChild(smallHint);

    form.appendChild(sCont);

    // SECTION: Verified
    const sVer = mkSection("Kontrola");
    {
      const checked = document.createElement("select");
      const opts = [
        { value: "", label: "—" },
        { value: "yes", label: "Skontrolované" },
        { value: "no", label: "Neskontrolované" },
      ];
      for (const o of opts) {
        const opt = document.createElement("option");
        opt.value = o.value; opt.textContent = o.label;
        checked.appendChild(opt);
      }
      const current = (p.verified === true || p.checked === true) ? "yes" : (p.verified === false || p.checked === false) ? "no" : "";
      checked.value = current;

      checked.addEventListener("change", async () => {
        const v = checked.value;
        if (v === "yes") {
          p.verified = true;
          p.checked = true;
          p.verified_at = new Date().toISOString();
          try {
            const token = Auth.getToken();
            if (token) {
              const user = await GH.getViewer(token);
              p.verified_by = user.login;
            }
          } catch {}
        } else if (v === "no") {
          p.verified = false;
          p.checked = false;
        } else {
          p.verified = null;
          p.checked = null;
        }
        markDirty(feature, idx);
      });

      sVer.appendChild(mkRow("Stav", checked));

      const verInfo = document.createElement("div");
      verInfo.className = "small";
      const at = p.verified_at ? ` • ${p.verified_at}` : "";
      const by = p.verified_by ? ` • @${p.verified_by}` : "";
      verInfo.textContent = (p.verified === true || p.checked === true) ? `Posledná kontrola${by}${at}` : "Zatiaľ nie je označené ako skontrolované.";
      sVer.appendChild(verInfo);
    }
    form.appendChild(sVer);

    // SECTION: Advanced (dropdown)
    const adv = document.createElement("details");
    adv.className = "section";
    adv.open = false;
    const sum = document.createElement("summary");
    sum.textContent = "Pokročilé (ID, adresa, mestská časť, prevádzkovateľ, JSON)";
    adv.appendChild(sum);

    const body = document.createElement("div");
    body.className = "sectionBody";

    const siteId = mkInput(p.site_id, (v) => { p.site_id = v; markDirty(feature, idx); }, "site_id");
    body.appendChild(mkRow("ID (site_id)", siteId));

    const addr = mkInput(p.address ?? "", (v) => { p.address = v; markDirty(feature, idx); }, "adresa");
    body.appendChild(mkRow("Adresa", addr));

    const dist = mkInput(p.district ?? "", (v) => { p.district = v; markDirty(feature, idx); }, "mestská časť");
    body.appendChild(mkRow("Mestská časť", dist));

    const city = mkInput(p.city ?? "Košice", (v) => { p.city = v; markDirty(feature, idx); }, "mesto");
    body.appendChild(mkRow("Mesto", city));

    const op = mkInput(p.operator ?? "", (v) => { p.operator = v; markDirty(feature, idx); }, "prevádzkovateľ");
    body.appendChild(mkRow("Prevádzkovateľ", op));

    // Raw JSON for anything else
    const raw = document.createElement("textarea");
    raw.rows = 10;
    raw.value = JSON.stringify(p, null, 2);

    const rawErr = document.createElement("div");
    rawErr.className = "small";
    rawErr.style.color = "crimson";
    rawErr.style.display = "none";

    raw.addEventListener("change", () => {
      try {
        const parsed = JSON.parse(raw.value);
        if (!isPlainObject(parsed)) throw new Error("Must be object");
        feature.properties = parsed;
        markDirty(feature, idx);
        markFileDirty();
        rawErr.style.display = "none";
        buildForm(feature, idx);
      } catch {
        rawErr.textContent = "Neplatný JSON – zmeny sa neuložili.";
        rawErr.style.display = "block";
      }
    });

    body.appendChild(mkRow("Properties (JSON)", raw));
    body.appendChild(rawErr);

    adv.appendChild(body);
    form.appendChild(adv);
  }

  // ===== Selection + draw =====
  function selectFeature(feature, marker, idx) {
    selectedFeature = feature;
    selectedMarker = marker;
    selectedIdx = idx;

    ensureId(feature);

    const p = feature.properties || {};
    if (selTitle) selTitle.textContent = p.name || p.site_id || "Vybraný bod";
    if (selSub) selSub.textContent = "Skontroluj GPS → typ → zamok → nádoby → skontrolované.";

    if (centerSelBtn) centerSelBtn.disabled = false;
    if (snapToGpsBtn) snapToGpsBtn.disabled = (lastGpsLatLng === null);

    if (deleteSiteBtn) { deleteSiteBtn.hidden = false; deleteSiteBtn.disabled = false; }

    updateCoordsUI(feature);
    setEditingMode(true);
    buildForm(feature, idx);

    // when you pick a site, default to more edit space
    setMapExpanded(false);
  }

  function drawFeatures() {
    markersLayer.clearLayers();
    markerByKey = new Map();

    selectedFeature = null;
    selectedMarker = null;
    selectedIdx = null;

    if (deleteSiteBtn) { deleteSiteBtn.hidden = true; deleteSiteBtn.disabled = true; }
    if (centerSelBtn) centerSelBtn.disabled = true;
    if (snapToGpsBtn) snapToGpsBtn.disabled = true;

    clearSelectionUI();

    const latlngs = [];

    geojsonData.features.forEach((feature, idx) => {
      if (!feature?.geometry || feature.geometry.type !== "Point") return;
      ensureId(feature);

      const [lng, lat] = feature.geometry.coordinates;
      if (typeof lat !== "number" || typeof lng !== "number") return;

      const marker = L.marker([lat, lng], { draggable: true }).addTo(markersLayer);
      marker.on("click", () => selectFeature(feature, marker, idx));

      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        feature.geometry.coordinates = [pos.lng, pos.lat];
        movedCount += 1;
        markDirty(feature, idx);
        if (selectedFeature === feature) updateCoordsUI(feature);
      });

      const key = featureKey(feature, idx);
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
    drawFeatures();
  }

  // ===== Add container dialog =====
  let pendingContainerType = null;

  function openAddContainerDialog(feature, idx) {
    if (!addContainerDialog) return;

    const p = (feature.properties ||= {});
    if (!Array.isArray(p.containers)) p.containers = [];

    pendingContainerType = null;
    containerVolume.value = "";
    containerCount.value = "1";

    containerTypeGrid.innerHTML = "";
    for (const preset of CONTAINER_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "typeBtn";
      b.textContent = preset.label;
      b.addEventListener("click", () => {
        pendingContainerType = preset;
        containerVolume.value = String(preset.defaultVolume ?? 1100);
      });
      containerTypeGrid.appendChild(b);
    }

    addContainerDialog.showModal();

    addContainerDialog.addEventListener("close", () => {
      if (addContainerDialog.returnValue !== "ok") return;

      // require type
      if (!pendingContainerType) {
        alert("Najprv vyber typ nádoby.");
        return;
      }

      const vol = Number(containerVolume.value);
      const count = Math.max(1, Math.round(Number(containerCount.value || "1")));

      const containerObj = {
        fraction: pendingContainerType.key,
        label: pendingContainerType.label,
        volume_l: Number.isFinite(vol) ? vol : pendingContainerType.defaultVolume,
        count
      };

      p.containers.push(containerObj);
      markDirty(feature, idx);
      markFileDirty();

      buildForm(feature, idx);
    }, { once: true });
  }

  // ===== Buttons =====
  if (mapToggleBtn) {
    mapToggleBtn.addEventListener("click", () => {
      const on = !document.body.classList.contains("mapExpanded");
      setMapExpanded(on);
    });
  }

  if (locateBtn) {
    locateBtn.addEventListener("click", () => {
      map.locate({ setView: true, maxZoom: 18, watch: false, enableHighAccuracy: true });
    });
  }

  map.on("locationfound", (e) => {
    lastGpsLatLng = e.latlng;
    if (!gpsMarker) gpsMarker = L.circleMarker(e.latlng, { radius: 8 }).addTo(map);
    else gpsMarker.setLatLng(e.latlng);

    if (snapToGpsBtn) snapToGpsBtn.disabled = !(selectedFeature && selectedMarker);
  });

  map.on("locationerror", () => alert("Nepodarilo sa získať polohu."));

  if (centerSelBtn) {
    centerSelBtn.addEventListener("click", () => {
      if (!selectedMarker) return;
      map.setView(selectedMarker.getLatLng(), Math.max(map.getZoom(), 18));
    });
  }

  if (snapToGpsBtn) {
    snapToGpsBtn.addEventListener("click", () => {
      if (!selectedFeature || !selectedMarker || !lastGpsLatLng || selectedIdx == null) return;
      selectedMarker.setLatLng(lastGpsLatLng);
      selectedFeature.geometry.coordinates = [lastGpsLatLng.lng, lastGpsLatLng.lat];
      movedCount += 1;
      markDirty(selectedFeature, selectedIdx);
      updateCoordsUI(selectedFeature);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      try {
        dirtyIds.clear();
        movedCount = 0;
        updateDirtyUI();
        await loadGeoJSON();
        alert("GeoJSON načítaný nanovo.");
      } catch (e) {
        console.error(e);
        alert("Refresh zlyhal. Pozri Console.");
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }

  if (newSiteBtn) {
    newSiteBtn.addEventListener("click", () => {
      if (!geojsonData) return;

      const pos = lastGpsLatLng || map.getCenter();

      const f = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [pos.lng, pos.lat] },
        properties: {
          site_id: `site_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          note: "",
          site_kind: "",
          has_lock: null,
          containers: [],
          verified: null
        }
      };

      geojsonData.features.push(f);
      markFileDirty();

      drawFeatures();

      // select newly created by reference
      const found = [...markerByKey.values()].find(x => x.feature === f);
      if (found) {
        map.setView(found.marker.getLatLng(), Math.max(map.getZoom(), 18));
        selectFeature(found.feature, found.marker, found.idx);
      }
    });
  }

  if (deleteSiteBtn) {
    deleteSiteBtn.addEventListener("click", () => {
      if (!geojsonData || selectedIdx == null || !selectedFeature) return;

      const p = selectedFeature.properties || {};
      const label = p.name || p.site_id || "toto stanovište";
      if (!confirm(`Naozaj vymazať ${label}?`)) return;

      geojsonData.features.splice(selectedIdx, 1);
      markFileDirty();
      drawFeatures();
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

  // ===== Commit =====
  if (commitBtn) {
    commitBtn.addEventListener("click", () => {
      if (!commitDialog) return;
      if (commitSummary) {
        commitSummary.textContent = `Zmeny: ${dirtyIds.size} • presuny: ${movedCount} • features: ${geojsonData?.features?.length ?? "?"}`;
      }
      if (commitMsg) commitMsg.value = `Fix: terénna kontrola (${dirtyIds.size})`;
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

      if (commitBtn) commitBtn.disabled = true;

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
          `Editor: @${user.login}\nZmeny: ${dirtyIds.size}\nPresuny: ${movedCount}\nFeatures: ${geojsonData.features.length}`
        );

        dirtyIds.clear();
        movedCount = 0;
        updateDirtyUI();

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
  setMapExpanded(true);
  setTimeout(() => map.invalidateSize(), 250);
});
