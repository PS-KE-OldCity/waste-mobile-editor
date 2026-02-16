(function () {
  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;max-height:35vh;overflow:auto;background:#111;color:#0f0;padding:10px;border-radius:10px;z-index:99999;font-size:12px;opacity:.92;";
  box.textContent = "debug: ok\n";
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(box));

  function log(x) {
    box.textContent += (x?.stack || x?.message || String(x)) + "\n\n";
  }

  window.addEventListener("error", (e) => log(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => log(e.reason));
})();


const GH = (() => {
  // TODO: nastav na tvoje repo
  const OWNER = "lorot19";
  const REPO = "waste-mobile-editor";
  const FILE_PATH = "data/kosice_waste_sites_v2.geojson";
  const BASE_BRANCH = "main";

  function headers(token) {
    return {
      "Authorization": `token ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    };
  }

  async function api(token, url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: { ...headers(token), ...(opts.headers || {}) }
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`GitHub API error ${r.status}: ${t}`);
    }
    return r.json();
  }

  async function getViewer(token) {
    return api(token, "https://api.github.com/user");
  }

  async function getRefSha(token, branch) {
    const data = await api(token, `https://api.github.com/repos/${OWNER}/${REPO}/git/ref/heads/${branch}`);
    return data.object.sha;
  }

  async function createBranch(token, newBranch, fromSha) {
    return api(token, `https://api.github.com/repos/${OWNER}/${REPO}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${newBranch}`,
        sha: fromSha
      })
    });
  }

  async function getFileSha(token, path, branch) {
    const data = await api(token, `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${branch}`);
    return data.sha;
  }

  async function putFile(token, path, branch, message, contentText, sha) {
    const contentB64 = btoa(unescape(encodeURIComponent(contentText))); // UTF-8 safe-ish

    return api(token, `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: contentB64,
        branch,
        sha
      })
    });
  }

  async function openPR(token, headBranch, title, body = "") {
    return api(token, `https://api.github.com/repos/${OWNER}/${REPO}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title,
        head: headBranch,
        base: BASE_BRANCH,
        body
      })
    });
  }

  return {
    OWNER, REPO, FILE_PATH, BASE_BRANCH,
    getViewer, getRefSha, createBranch, getFileSha, putFile, openPR
  };
})();
