// Netlify serverless function — proxies POST requests to SCB's PxWeb API.
// The SCB statistics API (api.scb.se) is CORS-friendly for GET but some
// browser environments still have issues with POST requests to it.
// This function ensures reliable access from any deployment.

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed — use POST' }),
    };
  }

  // The target SCB endpoint is passed as a query parameter
  const targetUrl = event.queryStringParameters?.url ||
    'https://api.scb.se/OV0104/v1/doris/sv/ssd/NV/NV0109/NV0109O/NV0109T05Ar';

  // Only allow SCB endpoints
  if (!targetUrl.startsWith('https://api.scb.se/')) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Only api.scb.se endpoints are allowed' }),
    };
  }

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VCFO-Terminal/1.0',
      },
      body: event.body,
    });

    const data = await res.text();

    return {
      statusCode: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: data,
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `SCB proxy fetch failed: ${e.message}` }),
    };
  }
};
