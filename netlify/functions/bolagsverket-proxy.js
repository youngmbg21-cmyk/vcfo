// Netlify serverless function — proxies requests to Bolagsverket's iXBRL API.
// Runs server-side so there are no CORS restrictions.
// Accepts org number + optional year, cascades through years to find data.

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

  // Build year cascade: if "latest" or empty, try most recent years first
  // iXBRL filings became common from ~2021 onward; many companies only have 2023+
  const currentYear = new Date().getFullYear();
  let yearCascade;
  if (requestedYear === 'latest' || !requestedYear) {
    yearCascade = [];
    for (let y = currentYear; y >= 2020; y--) yearCascade.push(String(y));
  } else {
    // Specific year requested — try it first, then cascade to nearby years
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
  // Source 1: Bolagsverket iXBRL API (primary — best structured data)
  // ══════════════════════════════════════════════════════════════
  try {
    // Fetch up to 10 reports for this company (all available years)
    const url = `https://xbrl.bolagsverket.se/api/v1/reports?registrationNumber=${orgNr}&top=10`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'VCFO-Terminal/1.0' },
    });

    if (res.ok) {
      const data = await res.json();
      const reports = data.reports || data.items || (Array.isArray(data) ? data : []);

      if (reports.length > 0) {
        results.reports = reports;
        results.source = 'bolagsverket-xbrl';

        // Find the best matching report using the year cascade
        let target = null;
        for (const yr of yearCascade) {
          target = reports.find(r => {
            const fy = (r.financialYear || r.reportPeriod || r.period || '').toString();
            return fy.includes(yr);
          });
          if (target) {
            results.resolvedYear = yr;
            break;
          }
        }
        // If no year match, use the first (most recent) report
        if (!target) {
          target = reports[0];
          const fy = (target.financialYear || target.reportPeriod || target.period || '').toString();
          results.resolvedYear = fy.slice(0, 4) || 'unknown';
        }

        // Try to fetch full report details if a URL is available
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
          } catch (e) { results.errors.push(`detail: ${e.message}`); }
        }

        if (!results.latestReport) {
          results.latestReport = target;
        }
      }
    }
  } catch (e) {
    results.errors.push(`xbrl: ${e.message}`);
  }

  // ══════════════════════════════════════════════════════════════
  // Source 2: Bolagsverket Värdefulla datamängder API
  // ══════════════════════════════════════════════════════════════
  if (!results.latestReport) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/organisationer/${orgNr}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'VCFO-Terminal/1.0' },
      });

      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object' && Object.keys(data).length > 2) {
          results.latestReport = data;
          results.source = 'bolagsverket-vdm';
          results.resolvedYear = (data.financialYear || data.reportPeriod || requestedYear || '').toString().slice(0, 4);
        }
      }
    } catch (e) {
      results.errors.push(`vdm: ${e.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Source 3: Document list (for year selector & fallback data)
  // ══════════════════════════════════════════════════════════════
  if (!results.reports.length) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/organisationer/${orgNr}/dokument`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'VCFO-Terminal/1.0' },
      });

      if (res.ok) {
        const data = await res.json();
        const docs = data.dokument || data.documents || (Array.isArray(data) ? data : []);
        if (docs.length > 0) {
          results.reports = docs;
          if (!results.source) results.source = 'bolagsverket-docs';

          // If we still don't have a report, try fetching the best year's document
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
                    const docRes = await fetch(
                      `https://api.bolagsverket.se/vardefulladatamangder/v1/dokument/${dId}`,
                      { headers: { 'Accept': 'application/json', 'User-Agent': 'VCFO-Terminal/1.0' } }
                    );
                    if (docRes.ok) {
                      const docData = await docRes.json();
                      if (docData) {
                        results.latestReport = docData;
                        results.resolvedYear = yr;
                        break;
                      }
                    }
                  } catch(e) { /* doc fetch failed, try next year */ }
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
  // Source 4: Fetch a specific document by ID (for year switching)
  // ══════════════════════════════════════════════════════════════
  if (docId) {
    try {
      const url = `https://api.bolagsverket.se/vardefulladatamangder/v1/dokument/${docId}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'VCFO-Terminal/1.0' },
      });

      if (res.ok) {
        const data = await res.json();
        if (data) {
          results.latestReport = data;
          if (!results.source) results.source = 'bolagsverket-doc';
        }
      }
    } catch (e) {
      results.errors.push(`doc: ${e.message}`);
    }
  }

  // Build summary of what years are available
  results.availableYears = results.reports
    .map(r => (r.financialYear || r.rakenskapsAr || r.reportPeriod || r.year || '').toString().slice(0, 4))
    .filter(y => y && parseInt(y) >= 2018)
    .filter((v, i, a) => a.indexOf(v) === i) // unique
    .sort((a, b) => parseInt(b) - parseInt(a));

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  };
};
