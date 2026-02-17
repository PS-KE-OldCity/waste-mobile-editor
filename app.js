document.addEventListener("DOMContentLoaded", async () => {
  // =========================
  // DOM
  // =========================
  const form = document.getElementById("editForm");
  const locateBtn = document.getElementById("locateBtn");
  const centerSelBtn = document.getElementById("centerSelBtn");
  const selTitle = document.getElementById("selTitle");
  const selSub = document.getElementById("selSub");
  const latVal = document.getElementById("latVal");
  const lngVal = document.getElementById("lngVal");
  const snapToGpsBtn = document.getElementById("snapToGpsBtn");
  const dirtyBadge = document.getElementById("dirtyBadge");

  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const userBadge = document.getElementById("userBadge");
  const commitBtn = document.getElementById("commitBtn");
  const refreshBtn = document.getElementById("refreshBtn");

  const newSiteBtn = document.getElementById("newSiteBtn");
  const deleteSiteBtn = document.getElementById("deleteSiteBtn");

  const commitDialog = document.getElementById("commitDialog");
  const commitSummary = document.getElementById("commitSummary");
  const commitMsg = document.getElementById("commitMsg");

  // =========================
  // Map
  // =========================
  if (!window.L) {
    alert("Leaflet (L) nie je načítaný. Skontroluj poradie <script> v index.html.");
    return;
  }

  const map = L.map("map").setView([48.7164, 21.2611], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  const markersLayer = L.layerGroup().addTo(map);

  // =========================
  // State
  // =========================
  let geojsonData = null;

  let selectedFeature = null;
  let selectedMarker = null;
  let selectedIdx = null;

  let lastGpsLatLng = null;
  let gpsMarker = null;

  const dirtyIds = new Set();
  let movedCount = 0;

  // marker lookup after redraw
  let markerByKey = new Map();

  // =========================
  // Helpers
  // =========================
  function ensureId(feature) {
    const p = (feature.properties ||= {});
    if (!p.site_id) {
      // stable-ish id for edits
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

  // when structure changes (add/remove feature/container), mark file dirty
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

  function clearForm() {
    if (deleteSiteBtn) { deleteSiteBtn.hidden = true; deleteSiteBtn.disabled = true; }
  }

  function setSelectedHeader(feature) {
    if (!selTitle) return;
    const p = feature.properties || {};
    selTitle.textContent = p.name || p.title || p.site_id || feature.id || "Vybraný bod";
    if (selSub) selSub.textContent = "Uprav údaje, kontajnery alebo presuň bod.";
  }

  // =========================
  // Form builders (sections)
  // =========================
  const BASIC_KEYS = [
    "site_id",
    "name",
    "address",
    "district",
    "city",
    "operator",
    "status",
    "note"
  ];

  function mkRow(labelText, inputEl) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(inputEl);
    return row;
  }

  function mkInput(value, onInput, placeholder = "") {
    const input = document.createElement("input");
    input.value = (value ?? "").toString();
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function mkTextarea(value, onChange, rows = 4) {
    const ta = document.createElement("textarea");
    ta.rows = rows;
    ta.value = (value ?? "").toString();
    ta.addEventListener("change", () => onChange(ta.value));
    return ta;
  }

  function mkDetails(title, open = true) {
    const d = document.createElement("details");
    d.className = "section";
    d.open = open;

    const s = document.createElement("summary");
    s.textContent = title;

    const body = document.createElement("div");
    body.className = "sectionBody";

    d.appendChild(s);
    d.appendChild(body);
    return { details: d, body };
  }

  function getExtrasObject(properties) {
    const extras = {};
    for (const [k, v] of Object.entries(properties || {})) {
      if (k === "containers") continue;
      if (BASIC_KEYS.includes(k)) continue;
      extras[k] = v;
    }
    return extras;
  }

  function setExtrasObject(properties, newExtras) {
    // remove existing extras keys
    for (const k of Object.keys(properties)) {
      if (k === "containers") continue;
      if (BASIC_KEYS.includes(k)) continue;
      delete properties[k];
    }
    // set new extras
    for (const [k, v] of Object.entries(newExtras || {})) {
      properties[k] = v;
    }
  }

  function buildContainersSection(feature, idx, parentBody) {
    const p = (feature.properties ||= {});
    if (!Array.isArray(p.containers)) p.containers = [];

    const headerRow = document.createElement("div");
    headerRow.className = "containerHeaderRow";

    const left = document.createElement("div");
    left.innerHTML = `<div style="font-weight:800">Kontajnery</div><div class="small">Pridaj/odober +/−, každá karta je jedna nádoba (alebo typ).</div>`;

    const right = document.createElement("div");
    right.className = "rowInline";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "iconBtn";
    addBtn.textContent = "+";
    addBtn.addEventListener("click", () => {
      p.containers.push({
        type: "",
        waste: "",
        volume_l: null,
        count: 1
      });
      markDirty(feature, idx);
      markFileDirty();
      buildForm(feature, idx); // re-render
    });

    right.appendChild(addBtn);
    headerRow.appendChild(left);
    headerRow.appendChild(right);

    parentBody.appendChild(headerRow);

    if (p.containers.length === 0) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Zatiaľ žiadne kontajnery. Klikni + pre pridanie.";
      parentBody.appendChild(hint);
      return;
    }

    p.containers.forEach((c, cIdx) => {
      if (!isPlainObject(c)) c = p.containers[cIdx] = {};

      const card = document.createElement("div");
      card.className = "containerCard";

      const top = document.createElement("div");
      top.className = "rowInline";
      top.style.justifyContent = "space-between";

      const title = document.createElement("div");
      title.style.fontWeight = "800";
      title.textContent = `Nádoba #${cIdx + 1}`;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "iconBtn danger";
      removeBtn.textContent = "−";
      removeBtn.addEventListener("click", () => {
        p.containers.splice(cIdx, 1);
        markDirty(feature, idx);
        markFileDirty();
        buildForm(feature, idx);
      });

      top.appendChild(title);
      top.appendChild(removeBtn);
      card.appendChild(top);

      // Friendly fields (best-effort)
      const grid = document.createElement("div");
      grid.className = "grid2";

      const typeInput = mkInput(c.type, (v) => { c.type = v; markDirty(feature, idx); }, "napr. 1100l / zvon / kôš");
      grid.appendChild(mkRow("Typ", typeInput));

      const wasteInput = mkInput(c.waste || c.fraction || "", (v) => {
        // keep both if they exist
        if ("waste" in c || !("fraction" in c)) c.waste = v;
        else c.fraction = v;
        markDirty(feature, idx);
      }, "napr. plast, papier, sklo");
      grid.appendChild(mkRow("Frakcia", wasteInput));

      const volInput = mkInput(
        (c.volume_l ?? c.volume ?? "").toString(),
        (v) => {
          const n = v.trim() === "" ? null : Number(v);
          if ("volume_l" in c || !("volume" in c)) c.volume_l = Number.isFinite(n) ? n : null;
          else c.volume = Number.isFinite(n) ? n : null;
          markDirty(feature, idx);
        },
        "litre"
      );
      volInput.type = "number";
      grid.appendChild(mkRow("Objem (l)", volInput));

      const countInput = mkInput(
        (c.count ?? 1).toString(),
        (v) => {
          const n = Number(v);
          c.count = Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
          markDirty(feature, idx);
        },
        "ks"
      );
      countInput.type = "number";
      grid.appendChild(mkRow("Počet", countInput));

      card.appendChild(grid);

      // Advanced JSON for unknown keys
      const adv = document.createElement("details");
      adv.className = "section";
      adv.open = false;

      const advSum = document.createElement("summary");
      advSum.textContent = "Pokročilé (JSON)";

      const advBody = document.createElement("div");
      advBody.className = "sectionBody";

      const ta = document.createElement("textarea");
      ta.rows = 5;
      ta.value = JSON.stringify(c, null, 2);

      const err = document.createElement("div");
      err.className = "small";
      err.style.color = "crimson";
      err.style.display = "none";

      ta.addEventListener("change", () => {
        try {
          const parsed = JSON.parse(ta.value);
          if (!isPlainObject(parsed)) throw new Error("Must be object");
          p.containers[cIdx] = parsed;
          markDirty(feature, idx);
          markFileDirty();
          err.style.display = "none";
          // re-render to keep friendly fields in sync
          buildForm(feature, idx);
        } catch (e) {
          err.textContent = "Neplatný JSON – zmeny sa neuložili.";
          err.style.display = "block";
        }
      });

      advBody.appendChild(ta);
      advBody.appendChild(err);
      adv.appendChild(advSum);
      adv.appendChild(advBody);

      card.appendChild(adv);
      parentBody.appendChild(card);
    });
  }

  function buildForm(feature, idx) {
    if (!form) return;

    ensureId(feature);

    const p = (feature.properties ||= {});
    if (!Array.isArray(p.containers)) p.containers = [];

    form.innerHTML = "";

    // SECTION 1: BASIC
    const s1 = mkDetails("1) Základné informácie", true);
    {
      const grid = document.createElement("div");
      grid.className = "grid2";

      const siteId = mkInput(p.site_id, (v) => { p.site_id = v; markDirty(feature, idx); setSelectedHeader(feature); }, "site_id");
      grid.appendChild(mkRow("ID (site_id)", siteId));

      const name = mkInput(p.name, (v) => { p.name = v; markDirty(feature, idx); setSelectedHeader(feature); }, "napr. Trieda SNP 12");
      grid.appendChild(mkRow("Názov", name));

      const addr = mkInput(p.address, (v) => { p.address = v; markDirty(feature, idx); }, "ulica + číslo");
      grid.appendChild(mkRow("Adresa", addr));

      const district = mkInput(p.district, (v) => { p.district = v; markDirty(feature, idx); }, "mestská časť");
      grid.appendChild(mkRow("Mestská časť", district));

      const city = mkInput(p.city, (v) => { p.city = v; markDirty(feature, idx); }, "Košice");
      grid.appendChild(mkRow("Mesto", city));

      const operator = mkInput(p.operator, (v) => { p.operator = v; markDirty(feature, idx); }, "KOSIT / mesto / ...");
      grid.appendChild(mkRow("Prevádzkovateľ", operator));

      const status = mkInput(p.status, (v) => { p.status = v; markDirty(feature, idx); }, "aktívne / zrušené / ...");
      grid.appendChild(mkRow("Status", status));

      s1.body.appendChild(grid);

      const note = mkTextarea(p.note || "", (v) => { p.note = v; markDirty(feature, idx); }, 3);
      s1.body.appendChild(mkRow("Poznámka", note));
    }
    form.appendChild(s1.details);

    // SECTION 2: CONTAINERS
    const s2 = mkDetails("2) Kontajnerové nádoby", true);
    buildContainersSection(feature, idx, s2.body);
    form.appendChild(s2.details);

    // SECTION 3: EXTRAS
    const s3 = mkDetails("3) Ostatné / technické (JSON)", false);
    {
      const extras = getExtrasObject(p);
      const ta = document.createElement("textarea");
      ta.rows = 8;
      ta.value = JSON.stringify(extras, null, 2);

      const err = document.createElement("div");
      err.className = "small";
      err.style.color = "crimson";
      err.style.display = "none";

      ta.addEventListener("change", () => {
        try {
          const parsed = JSON.parse(ta.value);
          if (!isPlainObject(parsed)) throw new Error("Must be object");
          setExtrasObject(p, parsed);
          markDirty(feature, idx);
          markFileDirty();
          err.style.display = "none";
        } catch (e) {
          err.textContent = "Neplatný JSON – zmeny sa neuložili.";
          err.style.display = "block";
        }
      });

      s3.body.appendChild(ta);

      const hint = document.createElement("div");
      hint.className = "small";
      hint.textContent = "Sem patria veci ako RFID, nemenné údaje, legacy polia. Upravuj opatrne.";
      s3.body.appendChild(hint);
      s3.body.appendChild(err);
    }
    form.appendChild(s3.details);
  }

  // =========================
  // Selection / draw
  // =========================
  function selectFeature(feature, marker, idx) {
    selectedFeature = feature;
    selectedMarker = marker;
    selectedIdx = idx;

    setSelectedHeader(feature);
    if (centerSelBtn) centerSelBtn.disabled = false;
    if (snapToGpsBtn) snapToGpsBtn.disabled = (lastGpsLatLng === null);
    if (deleteSiteBtn) deleteSiteBtn.disabled = false;

    updateCoordsUI(feature);
    buildForm(feature, idx);
    if (deleteSiteBtn) { deleteSiteBtn.hidden = false; deleteSiteBtn.disabled = false; }
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
    if (deleteSiteBtn) deleteSiteBtn.disabled = true;

    clearForm();

    const latlngs = [];

    geojsonData.features.forEach((feature, idx) => {
      if (!feature?.geometry || feature.geometry.type !== "Point") return;
      ensureId(feature);

      const [lng, lat] = feature.geometry.coordinates;
      if (typeof lat !== "number" || typeof lng !== "number") return;

      const marker = L.marker([lat, lng], { draggable: true }).addTo(markersLayer);
      const key = featureKey(feature, idx);
      markerByKey.set(key, { marker, feature, idx });

      marker.on("click", () => selectFeature(feature, marker, idx));

      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        feature.geometry.coordinates = [pos.lng, pos.lat];

        if (selectedFeature === feature) updateCoordsUI(feature);

        movedCount += 1;
        markDirty(feature, idx);
      });

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

  // =========================
  // Buttons: Refresh / New / Delete
  // =========================
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

      const center = map.getCenter();
      const pos = lastGpsLatLng || center;

      const f = {
        type: "Feature",
        geometry: { type: "Point", coordinates: [pos.lng, pos.lat] },
        properties: {
          site_id: `site_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          name: "",
          address: "",
          district: "",
          city: "Košice",
          operator: "",
          status: "",
          note: "",
          containers: []
        }
      };

      geojsonData.features.push(f);
      markFileDirty();

      drawFeatures();

      // select newly created marker
      const key = featureKey(f, geojsonData.features.length - 1);
      const entry = markerByKey.get(key);
      if (entry) {
        map.setView(entry.marker.getLatLng(), Math.max(map.getZoom(), 18));
        selectFeature(entry.feature, entry.marker, entry.idx);
      } else {
        // fallback: select by scanning reference
        const found = [...markerByKey.values()].find(x => x.feature === f);
        if (found) selectFeature(found.feature, found.marker, found.idx);
      }
    });
  }

  if (deleteSiteBtn) {
    deleteSiteBtn.addEventListener("click", () => {
      if (!geojsonData || selectedFeature == null || selectedIdx == null) return;

      const p = selectedFeature.properties || {};
      const label = p.name || p.site_id || "toto stanovište";

      if (!confirm(`Naozaj vymazať ${label}?`)) return;

      geojsonData.features.splice(selectedIdx, 1);
      markFileDirty();

      drawFeatures();
      clearForm();
    });
  }

  // =========================
  // GPS
  // =========================
  if (locateBtn) {
    locateBtn.addEventListener("click", () => {
      map.locate({ setView: true, maxZoom: 18, watch: false, enableHighAccuracy: true });
    });
  }

  map.on("locationfound", (e) => {
    lastGpsLatLng = e.latlng;
    if (!gpsMarker) gpsMarker = L.circleMarker(e.latlng, { radius: 8 }).addTo(map);
    else gpsMarker.setLatLng(e.latlng);

    if (snapToGpsBtn) snapToGpsBtn.disabled = (selectedFeature === null);
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
      updateCoordsUI(selectedFeature);
      movedCount += 1;
      markDirty(selectedFeature, selectedIdx);
    });
  }

  // =========================
  // Auth
  // =========================
  if (loginBtn) loginBtn.addEventListener("click", () => Auth.startLogin());

  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      Auth.logout();
      refreshUser();
      updateDirtyUI();
    });
  }

  // =========================
  // Commit workflow
  // =========================
  if (commitBtn) {
    commitBtn.addEventListener("click", () => {
      if (!commitDialog) return;

      if (commitSummary) {
        commitSummary.textContent = `Zmenené: ${dirtyIds.size} • presuny: ${movedCount} • features: ${geojsonData?.features?.length ?? "?"}`;
      }
      if (commitMsg) {
        commitMsg.value = `Fix: upravené ${dirtyIds.size} položky`;
      }

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
        // base SHA
        const baseSha = await GH.getRefSha(token, GH.BASE_BRANCH);

        // branch name
        const user = await GH.getViewer(token);
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const branch = `edit/${user.login}/${ts}`;

        // create branch
        await GH.createBranch(token, branch, baseSha);

        // file SHA on base
        const fileSha = await GH.getFileSha(token, GH.FILE_PATH, GH.BASE_BRANCH);

        // put updated file on new branch
        const newContent = JSON.stringify(geojsonData, null, 2);
        await GH.putFile(token, GH.FILE_PATH, branch, msg, newContent, fileSha);

        // open PR
        const pr = await GH.openPR(
          token,
          branch,
          msg,
          `Editor: @${user.login}\nZmeny: ${dirtyIds.size}\nPresuny: ${movedCount}\nFeatures: ${geojsonData.features.length}`
        );

        dirtyIds.clear();
        movedCount = 0;
        updateDirtyUI();

        alert(`Hotovo! PR vytvorený: ${pr.html_url}\nPo merge klikni Refresh.`);
      } catch (err) {
        console.error(err);
        alert("Commit/PR zlyhalo. Pozri Console log.");
      } finally {
        await refreshUser();
        updateDirtyUI();
      }
    });
  }

  // =========================
  // Init
  // =========================
  clearForm();

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
  setTimeout(() => map.invalidateSize(), 200);
});
