export default {
  async fetch(request, env) {
    // 1. Handle Preflight OPTIONS requests (this is what the browser sends first to check permissions)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*", // You can replace * with your Netlify URL for more security
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 2. Forward the actual request to Anthropic
    const url = "https://api.anthropic.com/v1/messages";
    
    // We create a new request object to ensure headers are passed correctly
    const proxyRequest = new Request(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });

    try {
      const response = await fetch(proxyRequest);

      // 3. Reconstruct the response and add the CORS headers back
      const newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      newResponse.headers.set("Access-Control-Allow-Methods": "GET, POST, OPTIONS");
      
      return newResponse;
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
  },
};
