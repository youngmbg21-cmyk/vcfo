// Netlify serverless function — searches Swedish companies by name.
const https = require('https');

function serverFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.protocol === 'https:' ? 443 : 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; VCFO-Terminal/1.0)',
        ...(options.headers || {}),
      },
      timeout: 10000,
    };

    const lib = parsedUrl.protocol === 'https:' ? https : require('http');
    const req = lib.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body,
          json: () => { try { return JSON.parse(body); } catch(e) { return null; } },
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const query = (event.queryStringParameters?.q || '').trim();
  if (!query || query.length < 2) {
    return { statusCode: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Query "q" required (min 2 chars)' }) };
  }

  const results = [];

  // Source 1: Bolagsverket iXBRL API
  try {
    const url = `https://xbrl.bolagsverket.se/api/v1/reports?companyName=${encodeURIComponent(query)}&top=8`;
    const res = await serverFetch(url);
    if (res.ok) {
      const data = res.json();
      const reports = data?.reports || data?.items || (Array.isArray(data) ? data : []);
      for (const r of reports) {
        const orgNr = r.registrationNumber || r.organisationNumber || '';
        const name  = r.companyName || r.name || '';
        if (orgNr && name) {
          const formatted = orgNr.length === 10 && !orgNr.includes('-')
            ? orgNr.slice(0, 6) + '-' + orgNr.slice(6) : orgNr;
          results.push({ name, orgNr: formatted, legalForm: r.legalForm || 'AB', industry: r.industry || '', source: 'bolagsverket', confidence: 'high' });
        }
      }
    }
  } catch (e) { /* source failed */ }

  // Source 2: Allabolag autocomplete
  if (results.length < 3) {
    try {
      const url = `https://www.allabolag.se/what/${encodeURIComponent(query)}`;
      const res = await serverFetch(url);
      if (res.ok && res.contentType.includes('json')) {
        const data = res.json();
        const items = Array.isArray(data) ? data : (data?.results || data?.companies || []);
        for (const item of items.slice(0, 6)) {
          const orgNr = item.orgnr || item.orgNr || item.organisationsnummer || '';
          const name  = item.name || item.company_name || item.namn || '';
          if (orgNr && name) {
            const exists = results.some(r => r.orgNr.replace(/-/g, '') === orgNr.replace(/-/g, ''));
            if (!exists) {
              const formatted = orgNr.length === 10 && !orgNr.includes('-')
                ? orgNr.slice(0, 6) + '-' + orgNr.slice(6) : orgNr;
              results.push({ name, orgNr: formatted, legalForm: item.type || 'AB', industry: item.bransch || '', source: 'allabolag', confidence: 'high' });
            }
          }
        }
      }
    } catch (e) { /* source failed */ }
  }

  // Deduplicate
  const seen = new Set();
  const unique = results.filter(r => {
    const key = r.orgNr.replace(/-/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, count: unique.length, companies: unique.slice(0, 8) }),
  };
};
