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
