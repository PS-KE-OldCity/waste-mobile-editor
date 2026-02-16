const Auth = (() => {
  const TOKEN_KEY = "gh_token";
  const STATE_KEY = "gh_state";

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(STATE_KEY);
  }

  function randomState() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function startLogin() {
    // client_id je na serveri, ale redirect na authorize môže byť bez neho? nie.
    // Preto ho načítame z funkcie (bez secretu).
    const r = await fetch("/.netlify/functions/oauth-token?mode=meta");
    const meta = await r.json();

    const state = randomState();
    sessionStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams({
      client_id: meta.client_id,
      redirect_uri: meta.redirect_uri,
      scope: "repo",          // pre private repo; pre public by stačilo "public_repo"
      state
    });

    window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async function finishLogin() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code) throw new Error("Missing code");
    const expected = sessionStorage.getItem(STATE_KEY);
    if (!expected || state !== expected) throw new Error("Invalid state");

    const r = await fetch("/.netlify/functions/oauth-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });

    if (!r.ok) throw new Error("Token exchange failed");
    const data = await r.json();
    if (!data.access_token) throw new Error("No access_token returned");

    setToken(data.access_token);
  }

  return { getToken, startLogin, finishLogin, logout };
})();
