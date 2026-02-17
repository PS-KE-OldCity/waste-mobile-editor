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

  let lastGpsLatLng = null;
  let gpsMarker = null;

  const dirtyIds = new Set();
  let movedCount = 0;

  // =========================
  // Helpers
  // =========================
  function featureKey(feature, idx) {
    const p = feature?.properties || {};
    return p.site_id || p.id || feature.id || `idx:${idx}`;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
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
    if (!form) return;
    form.innerHTML = `<div class="hint">Po výbere markeru sa tu zobrazia properties.</div>`;
  }

  function markDirty(feature, idx) {
    dirtyIds.add(featureKey(feature, idx));
    updateDirtyUI();
  }

  function buildForm(feature, idx) {
    if (!form) return;

    const properties = feature.properties || {};
    form.innerHTML = "";

    const keys = Object.keys(properties).sort((a, b) => a.localeCompare(b));

    for (const key of keys) {
      const val = properties[key];

      const row = document.createElement("div");
      row.className = "row";

      const label = document.createElement("label");
      label.textContent = key;

      if (Array.isArray(val) || isPlainObject(val)) {
        const textarea = document.createElement("textarea");
        textarea.rows = 4;
        textarea.value = JSON.stringify(val, null, 2);
        textarea.addEventListener("change", () => {
          try {
            feature.properties[key] = JSON.parse(textarea.value);
            textarea.style.borderColor = "#cfd7df";
            markDirty(feature, idx);
          } catch {
            textarea.style.borderColor = "crimson";
          }
        });
        row.appendChild(label);
        row.appendChild(textarea);
      } else {
        const input = document.createElement("input");
        input.value = (val ?? "").toString();
        input.addEventListener("input", () => {
          feature.properties[key] = input.value;
          markDirty(feature, idx);
        });
        row.appendChild(label);
        row.appendChild(input);
      }

      form.appendChild(row);
    }
  }

  function selectFeature(feature, marker, idx) {
    selectedFeature = feature;
    selectedMarker = marker;

    if (selTitle) selTitle.textContent =
      (feature.properties?.name || feature.properties?.site_id || feature.id || "Vybraný bod");

    if (selSub) selSub.textContent = "Uprav properties alebo presuň marker prstom.";

    if (centerSelBtn) centerSelBtn.disabled = false;
    if (snapToGpsBtn) snapToGpsBtn.disabled = (lastGpsLatLng === null);

    updateCoordsUI(feature);
    buildForm(feature, idx);
  }

  function drawFeatures() {
    markersLayer.clearLayers();

    selectedFeature = null;
    selectedMarker = null;

    if (centerSelBtn) centerSelBtn.disabled = true;
    if (snapToGpsBtn) snapToGpsBtn.disabled = true;

    clearForm();

    const latlngs = [];

    geojsonData.features.forEach((feature, idx) => {
      if (!feature?.geometry || feature.geometry.type !== "Point") return;

      const [lng, lat] = feature.geometry.coordinates;
      if (typeof lat !== "number" || typeof lng !== "number") return;

      const marker = L.marker([lat, lng], { draggable: true }).addTo(markersLayer);

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

    if (latlngs.length) {
      map.fitBounds(L.latLngBounds(latlngs).pad(0.1));
    }
  }

  async function loadGeoJSON() {
    // cache-bust: po merge PR sa načíta nová verzia aj cez CDN cache
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
  // Refresh button
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
      if (!selectedFeature || !selectedMarker || !lastGpsLatLng) return;
      selectedMarker.setLatLng(lastGpsLatLng);
      selectedFeature.geometry.coordinates = [lastGpsLatLng.lng, lastGpsLatLng.lat];
      updateCoordsUI(selectedFeature);
    });
  }

  // =========================
  // Auth buttons
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
  // Commit workflow (branch + commit + PR)
  // =========================
  if (commitBtn) {
    commitBtn.addEventListener("click", () => {
      if (!commitDialog) return;

      if (commitSummary) {
        commitSummary.textContent = `Zmenené features: ${dirtyIds.size}, presunuté body: ${movedCount}`;
      }
      if (commitMsg) {
        commitMsg.value = `Fix: upravené ${dirtyIds.size} stanovíšť`;
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
        // 1) base SHA (base branch)
        const baseSha = await GH.getRefSha(token, GH.BASE_BRANCH);

        // 2) branch name
        const user = await GH.getViewer(token);
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const branch = `edit/${user.login}/${ts}`;

        // 3) create branch
        await GH.createBranch(token, branch, baseSha);

        // 4) get file SHA on base
        const fileSha = await GH.getFileSha(token, GH.FILE_PATH, GH.BASE_BRANCH);

        // 5) put updated file on new branch
        const newContent = JSON.stringify(geojsonData, null, 2);
        await GH.putFile(token, GH.FILE_PATH, branch, msg, newContent, fileSha);

        // 6) open PR
        const pr = await GH.openPR(
          token,
          branch,
          msg,
          `Editor: @${user.login}\nZmenené features: ${dirtyIds.size}\nPresunuté body: ${movedCount}`
        );

        // reset dirty
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
    alert("Nepodarilo sa načítať GeoJSON. Skontroluj cestu v GH.FILE_PATH a že súbor existuje v repozitári.");
  }

  try {
    await refreshUser();
  } catch (e) {
    console.error("Auth/user refresh error:", e);
  }

  updateDirtyUI();

  // flex layout + leaflet: sometimes needs invalidateSize
  setTimeout(() => map.invalidateSize(), 200);
});
