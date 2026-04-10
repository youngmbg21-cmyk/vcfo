// Netlify serverless function — proxies requests to Bolagsverket's iXBRL API.
// Runs server-side so there are no CORS restrictions.
// Accepts an org number and returns the financial report data.

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const orgNr = (event.queryStringParameters?.orgNr || '').replace(/[^0-9]/g, '');
  if (!orgNr || orgNr.length < 10) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Parameter "orgNr" required (10 digits)' }),
    };
  }

  // Optional: specific year or document ID
  const year  = event.queryStringParameters?.year || '';
  const docId = event.queryStringParameters?.docId || '';

  const results = {
    orgNr,
    reports: [],
    latestReport: null,
    source: null,
    error: null,
  };

  // ── Source 1: Bolagsverket iXBRL API (primary) ──
  try {
    const url = `https://xbrl.bolagsverket.se/api/v1/reports?registrationNumber=${orgNr}&top=5`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'VCFO-Terminal/1.0',
      },
    });

    if (res.ok) {
      const data = await res.json();
      const reports = data.reports || data.items || (Array.isArray(data) ? data : []);
      if (reports.length > 0) {
        results.reports = reports;
        results.source = 'bolagsverket-xbrl';

        // Find the latest report (or a specific year)
        let target = reports[0]; // default: most recent
        if (year) {
          const yearMatch = reports.find(r =>
            (r.financialYear || r.reportPeriod || '').toString().includes(year)
          );
          if (yearMatch) target = yearMatch;
        }

        // Try to fetch the full report details if a document URL is available
        const reportUrl = target.url || target.documentUrl || target.reportUrl;
        if (reportUrl) {
          try {
            const detailRes = await fetch(reportUrl, {
              headers: { 'Accept': 'application/json', 'User-Agent': 'VCFO-Terminal/1.0' },
            });
            if (detailRes.ok) {
              const detail = await detailRes.json();
              results.latestReport = { ...target, ...detail };
            }
          } catch (e) { /* detail fetch failed, use summary */ }
        }

        if (!results.latestReport) {
          results.latestReport = target;
        }
      }
    }
  } catch (e) {
    results.error = `xbrl source: ${e.message}`;
  }

  // ── Source 2: Bolagsverket Värdefulla datamängder API ──
  if (!results.latestReport) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/organisationer/${orgNr}`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'VCFO-Terminal/1.0',
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (data) {
          results.latestReport = data;
          results.source = 'bolagsverket-vdm';
        }
      }
    } catch (e) {
      if (!results.error) results.error = `vdm source: ${e.message}`;
    }
  }

  // ── Source 3: Document list (for year selector) ──
  if (!results.reports.length) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/organisationer/${orgNr}/dokument`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'VCFO-Terminal/1.0',
        },
      });

      if (res.ok) {
        const data = await res.json();
        const docs = data.dokument || data.documents || (Array.isArray(data) ? data : []);
        if (docs.length > 0) {
          results.reports = docs;
          if (!results.source) results.source = 'bolagsverket-docs';
        }
      }
    } catch (e) { /* docs fetch failed */ }
  }

  // ── Source 4: Fetch a specific document by ID ──
  if (docId) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/dokument/${docId}`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'VCFO-Terminal/1.0',
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (data) {
          results.latestReport = data;
          if (!results.source) results.source = 'bolagsverket-doc';
        }
      }
    } catch (e) { /* doc fetch failed */ }
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  };
};
