exports.handler = async (event) => {
  const client_id = process.env.GITHUB_CLIENT_ID;
  const client_secret = process.env.GITHUB_CLIENT_SECRET;
  const redirect_uri = process.env.GITHUB_OAUTH_REDIRECT_URI;

  // GET: meta (no secret)
  if (event.httpMethod === "GET") {
    const mode = event.queryStringParameters?.mode;
    if (mode === "meta") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id, redirect_uri })
      };
    }
    return { statusCode: 404, body: "Not Found" };
  }

  // POST: token exchange
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { code } = JSON.parse(event.body || "{}");
    if (!code) return { statusCode: 400, body: "Missing code" };

    const resp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id, client_secret, code, redirect_uri })
    });

    const data = await resp.json();
    if (!data.access_token) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: data.access_token, scope: data.scope })
    };
  } catch (e) {
    return { statusCode: 500, body: "Server error" };
  }
};
