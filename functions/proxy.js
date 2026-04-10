export async function onRequest(context) {
  const { request } = context;

  // 1. Handle Preflight OPTIONS requests for CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // 2. Forward the request to Anthropic
  const url = "https://api.anthropic.com/v1/messages";
  const proxyRequest = new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  try {
    const response = await fetch(proxyRequest);

    // 3. Return the response with CORS headers
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("Access-Control-Allow-Origin", "*");
    return newResponse;
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}
