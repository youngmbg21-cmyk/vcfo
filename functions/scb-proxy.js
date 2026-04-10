// Netlify serverless function — proxies POST requests to SCB's PxWeb API.
const https = require('https');

function serverFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 15000,
    };

    const req = https.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=86400',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'POST only' }) };
  }

  const targetUrl = event.queryStringParameters?.url ||
    'https://api.scb.se/OV0104/v1/doris/sv/ssd/NV/NV0109/NV0109O/NV0109T05Ar';

  if (!targetUrl.startsWith('https://api.scb.se/')) {
    return { statusCode: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Only api.scb.se allowed' }) };
  }

  try {
    const res = await serverFetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: event.body,
    });

    return {
      statusCode: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: res.body,
    };
  } catch (e) {
    return { statusCode: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `SCB proxy failed: ${e.message}` }) };
  }
};
