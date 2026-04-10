// Netlify serverless function — proxies requests to Bolagsverket's iXBRL API.
// Uses node-fetch compatible approach for Netlify's Lambda runtime.

const https = require('https');
const http = require('http');

// Simple fetch wrapper that works on all Node.js versions
function serverFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'VCFO-Terminal/1.0',
        ...(options.headers || {}),
      },
      timeout: 12000,
    };

    const req = lib.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(body),
          json: () => {
            try { return Promise.resolve(JSON.parse(body)); }
            catch(e) { return Promise.reject(new Error(`JSON parse failed: ${body.slice(0, 200)}`)); }
          },
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

    if (options.body) req.write(options.body);
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=3600',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // Health check + connectivity test
  if (event.queryStringParameters?.health) {
    const diagnostics = {
      version: 'v4-debug',
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
      hasFetch: typeof fetch !== 'undefined',
      tests: {},
    };

    // Test 1: https module request
    try {
      const res = await serverFetch('https://httpbin.org/get');
      diagnostics.tests.httpsModule = { ok: res.ok, status: res.status };
    } catch(e) {
      diagnostics.tests.httpsModule = { error: e.message };
    }

    // Test 2: Bolagsverket XBRL API directly
    try {
      const res = await serverFetch('https://xbrl.bolagsverket.se/api/v1/reports?registrationNumber=5560004615&top=1');
      diagnostics.tests.bolagsverketXbrl = { ok: res.ok, status: res.status, bodyPreview: (await res.text()).slice(0, 300) };
    } catch(e) {
      diagnostics.tests.bolagsverketXbrl = { error: e.message, code: e.code };
    }

    // Test 3: Native fetch (Node 18+)
    if (typeof fetch !== 'undefined') {
      try {
        const res = await fetch('https://xbrl.bolagsverket.se/api/v1/reports?registrationNumber=5560004615&top=1');
        const text = await res.text();
        diagnostics.tests.nativeFetch = { ok: res.ok, status: res.status, bodyPreview: text.slice(0, 300) };
      } catch(e) {
        diagnostics.tests.nativeFetch = { error: e.message };
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(diagnostics, null, 2),
    };
  }

  const orgNr = (event.queryStringParameters?.orgNr || '').replace(/[^0-9]/g, '');
  if (!orgNr || orgNr.length < 10) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Parameter "orgNr" required (10 digits)' }),
    };
  }

  const requestedYear = event.queryStringParameters?.year || '';
  const docId         = event.queryStringParameters?.docId || '';

  const currentYear = new Date().getFullYear();
  let yearCascade;
  if (requestedYear === 'latest' || !requestedYear) {
    yearCascade = [];
    for (let y = currentYear; y >= 2020; y--) yearCascade.push(String(y));
  } else {
    const yr = parseInt(requestedYear);
    yearCascade = [String(yr)];
    for (let delta = 1; delta <= 3; delta++) {
      if (yr - delta >= 2020) yearCascade.push(String(yr - delta));
      if (yr + delta <= currentYear) yearCascade.push(String(yr + delta));
    }
  }

  const results = {
    orgNr,
    requestedYear: requestedYear || 'latest',
    resolvedYear: null,
    yearCascade,
    reports: [],
    latestReport: null,
    source: null,
    errors: [],
  };

  // ══════════════════════════════════════════════════════════════
  // Source 1: Bolagsverket iXBRL API
  // ══════════════════════════════════════════════════════════════
  try {
    const url = `https://xbrl.bolagsverket.se/api/v1/reports?registrationNumber=${orgNr}&top=10`;
    const res = await serverFetch(url);

    if (res.ok) {
      const data = await res.json();
      const reports = data.reports || data.items || (Array.isArray(data) ? data : []);

      if (reports.length > 0) {
        results.reports = reports;
        results.source = 'bolagsverket-xbrl';

        let target = null;
        for (const yr of yearCascade) {
          target = reports.find(r => {
            const fy = (r.financialYear || r.reportPeriod || r.period || '').toString();
            return fy.includes(yr);
          });
          if (target) { results.resolvedYear = yr; break; }
        }
        if (!target) {
          target = reports[0];
          const fy = (target.financialYear || target.reportPeriod || target.period || '').toString();
          results.resolvedYear = fy.slice(0, 4) || 'unknown';
        }

        const reportUrl = target.url || target.documentUrl || target.reportUrl;
        if (reportUrl) {
          try {
            const detailRes = await serverFetch(reportUrl);
            if (detailRes.ok) {
              const detail = await detailRes.json();
              results.latestReport = { ...target, ...detail };
            }
          } catch (e) { results.errors.push(`detail: ${e.message}`); }
        }

        if (!results.latestReport) results.latestReport = target;
      }
    } else {
      const body = await res.text();
      results.errors.push(`xbrl: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
  } catch (e) {
    results.errors.push(`xbrl: ${e.message} | stack: ${(e.stack || '').split('\n').slice(0,3).join(' > ')}`);
  }

  // ══════════════════════════════════════════════════════════════
  // Source 2: Bolagsverket Värdefulla datamängder API
  // ══════════════════════════════════════════════════════════════
  if (!results.latestReport) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/organisationer/${orgNr}`;
      const res = await serverFetch(url);

      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object' && Object.keys(data).length > 2) {
          results.latestReport = data;
          results.source = 'bolagsverket-vdm';
          results.resolvedYear = (data.financialYear || data.reportPeriod || '').toString().slice(0, 4);
        }
      } else {
        results.errors.push(`vdm: HTTP ${res.status}`);
      }
    } catch (e) {
      results.errors.push(`vdm: ${e.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Source 3: Document list
  // ══════════════════════════════════════════════════════════════
  if (!results.reports.length) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/organisationer/${orgNr}/dokument`;
      const res = await serverFetch(url);

      if (res.ok) {
        const data = await res.json();
        const docs = data.dokument || data.documents || (Array.isArray(data) ? data : []);
        if (docs.length > 0) {
          results.reports = docs;
          if (!results.source) results.source = 'bolagsverket-docs';

          if (!results.latestReport) {
            for (const yr of yearCascade) {
              const match = docs.find(d => {
                const fy = (d.financialYear || d.rakenskapsAr || d.year || '').toString();
                return fy.includes(yr);
              });
              if (match) {
                const dId = match.documentId || match.id;
                if (dId) {
                  try {
                    const docRes = await serverFetch(
                      `https://api.bolagsverket.se/vardefulladatamangder/v1/dokument/${dId}`
                    );
                    if (docRes.ok) {
                      const docData = await docRes.json();
                      if (docData) {
                        results.latestReport = docData;
                        results.resolvedYear = yr;
                        break;
                      }
                    }
                  } catch(e) { /* try next year */ }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      results.errors.push(`docs: ${e.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Source 4: Specific document by ID
  // ══════════════════════════════════════════════════════════════
  if (docId) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/dokument/${docId}`;
      const res = await serverFetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data) {
          results.latestReport = data;
          if (!results.source) results.source = 'bolagsverket-doc';
        }
      }
    } catch (e) { results.errors.push(`doc: ${e.message}`); }
  }

  // Available years summary
  results.availableYears = results.reports
    .map(r => (r.financialYear || r.rakenskapsAr || r.reportPeriod || r.year || '').toString().slice(0, 4))
    .filter(y => y && parseInt(y) >= 2018)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => parseInt(b) - parseInt(a));

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  };
};
