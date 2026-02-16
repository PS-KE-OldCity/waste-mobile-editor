document.addEventListener("DOMContentLoaded", async () => {
  // DOM
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

  const commitDialog = document.getElementById("commitDialog");
  const commitSummary = document.getElementById("commitSummary");
  const commitMsg = document.getElementById("commitMsg");
  const doCommitBtn = document.getElementById("doCommitBtn");

  // Map
  const map = L.map("map").setView([48.7164, 21.2611], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  const markersLayer = L.layerGroup().addTo(map);

  // State
  let geojsonData = null;
  let selectedFeature = null;
  let selectedMarker = null;
  let lastGpsLatLng = null;
  let gpsMarker = null;

  const dirtyIds = new Set(); // feature index based (fallback)
  let movedCount = 0;

  function featureKey(feature, idx) {
    // ak máš v properties stabilné id, použijeme ho, inak index
    const p = feature?.properties || {};
    return p.site_id || p.id || feature.id || `idx:${idx}`;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function updateDirtyUI() {
    dirtyBadge.textContent = `Zmeny: ${dirtyIds.size}`;
    commitBtn.disabled = !(Auth.getToken() && dirtyIds.size > 0);
  }

  function updateAuthUI(user) {
    const token = Auth.getToken();
    if (token && user) {
      userBadge.textContent = `@${user.login}`;
      loginBtn.hidden = true;
      logoutBtn.hidden = false;
      commitBtn.disabled = dirtyIds.size === 0;
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

  function updateCoordsUI(feature) {
    const [lng, lat] = feature.geometry.coordinates;
    latVal.textContent = Number(lat).toFixed(6);
    lngVal.textContent = Number(lng).toFixed(6);
  }

  function clearForm() {
    form.innerHTML = `<div class="hint">Po výbere markeru sa tu zobrazia properties.</div>`;
  }

  function markDirty(feature, idx) {
    dirtyIds.add(featureKey(feature, idx));
    updateDirtyUI();
  }

  function buildForm(feature, idx) {
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

    selTitle.textContent = (feature.properties?.name || feature.properties?.site_id || feature.id || "Vybraný bod");
    selSub.textContent = "Uprav properties alebo presuň marker prstom.";

    centerSelBtn.disabled = false;
    snapToGpsBtn.disabled = (lastGpsLatLng === null);

    updateCoordsUI(feature);
    buildForm(feature, idx);
  }

  function drawFeatures() {
    markersLayer.clearLayers();
    selectedFeature = null;
    selectedMarker = null;
    centerSelBtn.disabled = true;
    snapToGpsBtn.disabled = true;
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

    if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs).pad(0.1));
  }

  async function loadGeoJSON() {
    // načítame priamo z repa (statika)
    const r = await fetch(GH.FILE_PATH, { cache: "no-store" });
    if (!r.ok) throw new Error("GeoJSON load failed");
    geojsonData = await r.json();
    if (geojsonData.type !== "FeatureCollection") throw new Error("Not a FeatureCollection");
    drawFeatures();
  }

  // GPS
  locateBtn.addEventListener("click", () => {
    map.locate({ setView: true, maxZoom: 18, watch: false, enableHighAccuracy: true });
  });

  map.on("locationfound", (e) => {
    lastGpsLatLng = e.latlng;
    if (!gpsMarker) gpsMarker = L.circleMarker(e.latlng, { radius: 8 }).addTo(map);
    else gpsMarker.setLatLng(e.latlng);
    snapToGpsBtn.disabled = (selectedFeature === null);
  });

  map.on("locationerror", () => alert("Nepodarilo sa získať polohu."));

  centerSelBtn.addEventListener("click", () => {
    if (!selectedMarker) return;
    map.setView(selectedMarker.getLatLng(), Math.max(map.getZoom(), 18));
  });

  snapToGpsBtn.addEventListener("click", () => {
    if (!selectedFeature || !selectedMarker || !lastGpsLatLng) return;
    selectedMarker.setLatLng(lastGpsLatLng);
    selectedFeature.geometry.coordinates = [lastGpsLatLng.lng, lastGpsLatLng.lat];
    updateCoordsUI(selectedFeature);
  });

  // Auth buttons
  loginBtn.addEventListener("click", () => Auth.startLogin());
  logoutBtn.addEventListener("click", () => {
    Auth.logout();
    refreshUser();
    updateDirtyUI();
  });

  // Commit
  commitBtn.addEventListener("click", () => {
    commitSummary.textContent = `Zmenené features: ${dirtyIds.size}, presunuté body: ${movedCount}`;
    commitMsg.value = `Fix: upravené ${dirtyIds.size} stanovíšť`;
    commitDialog.showModal();
  });

  doCommitBtn.addEventListener("click", async (e) => {
    // dialog submit
    if (commitDialog.returnValue === "cancel") return;
  });

  commitDialog.addEventListener("close", async () => {
    if (commitDialog.returnValue !== "ok") return;

    const token = Auth.getToken();
    if (!token) return;

    const msg = commitMsg.value.trim();
    if (!msg) return;

    commitBtn.disabled = true;

    try {
      // 1) base SHA
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

      alert(`Hotovo! PR vytvorený: ${pr.html_url}`);
    } catch (err) {
      console.error(err);
      alert("Commit/PR zlyhalo. Pozri Console log.");
    } finally {
      await refreshUser();
      updateDirtyUI();
    }
  });

  // init
  // init
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

  // keď je mapa v rozložení, občas pomôže:
  setTimeout(() => map.invalidateSize(), 200);
});
