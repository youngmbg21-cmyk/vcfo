// Netlify serverless function — searches Swedish companies by name.
// Queries multiple free Swedish company data sources server-side
// (no CORS issues) and returns matching companies with org numbers.

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
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Query parameter "q" required (min 2 chars)' }),
    };
  }

  const results = [];

  // ── Source 1: Bolagsverket Näringslivsregistret (XBRL search) ──
  // Their web search uses this endpoint internally
  try {
    const bvUrl = `https://xbrl.bolagsverket.se/api/v1/reports?companyName=${encodeURIComponent(query)}&top=8`;
    const bvRes = await fetch(bvUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'VCFO-Terminal/1.0' },
    });
    if (bvRes.ok) {
      const bvData = await bvRes.json();
      const reports = bvData.reports || bvData.items || bvData || [];
      if (Array.isArray(reports)) {
        for (const r of reports) {
          const orgNr = r.registrationNumber || r.organisationNumber || r.orgNr || '';
          const name  = r.companyName || r.name || '';
          if (orgNr && name) {
            const formatted = orgNr.length === 10 && !orgNr.includes('-')
              ? orgNr.slice(0, 6) + '-' + orgNr.slice(6)
              : orgNr;
            results.push({
              name,
              orgNr: formatted,
              legalForm: r.legalForm || 'AB',
              industry: r.industry || r.sector || '',
              source: 'bolagsverket',
              confidence: 'high',
            });
          }
        }
      }
    }
  } catch (e) { /* Bolagsverket source failed — try next */ }

  // ── Source 2: Allabolag autocomplete ──
  // Public autocomplete endpoint used by allabolag.se
  if (results.length < 3) {
    try {
      const aaUrl = `https://www.allabolag.se/what/${encodeURIComponent(query)}`;
      const aaRes = await fetch(aaUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; VCFO-Terminal/1.0)',
        },
      });
      if (aaRes.ok) {
        const contentType = aaRes.headers.get('content-type') || '';
        if (contentType.includes('json')) {
          const aaData = await aaRes.json();
          const items = Array.isArray(aaData) ? aaData : (aaData.results || aaData.companies || []);
          for (const item of items.slice(0, 6)) {
            const orgNr = item.orgnr || item.orgNr || item.organisationsnummer || '';
            const name  = item.name || item.company_name || item.namn || '';
            if (orgNr && name) {
              // Skip if we already have this company from Bolagsverket
              const exists = results.some(r => r.orgNr.replace('-', '') === orgNr.replace('-', ''));
              if (!exists) {
                const formatted = orgNr.length === 10 && !orgNr.includes('-')
                  ? orgNr.slice(0, 6) + '-' + orgNr.slice(6)
                  : orgNr;
                results.push({
                  name,
                  orgNr: formatted,
                  legalForm: item.type || item.bolagsform || 'AB',
                  industry: item.industry || item.sni_text || item.bransch || '',
                  source: 'allabolag',
                  confidence: 'high',
                });
              }
            }
          }
        }
      }
    } catch (e) { /* allabolag source failed — continue */ }
  }

  // ── Source 3: Data.se / Open data portal ──
  if (results.length < 2) {
    try {
      const dsUrl = `https://ssbtek.se/foretagssok/?q=${encodeURIComponent(query)}&format=json`;
      const dsRes = await fetch(dsUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'VCFO-Terminal/1.0' },
      });
      if (dsRes.ok) {
        const dsData = await dsRes.json();
        const items = Array.isArray(dsData) ? dsData : (dsData.results || []);
        for (const item of items.slice(0, 4)) {
          const orgNr = item.organisationsnummer || item.orgnr || '';
          const name  = item.namn || item.name || '';
          if (orgNr && name) {
            const exists = results.some(r => r.orgNr.replace('-', '') === orgNr.replace('-', ''));
            if (!exists) {
              const formatted = orgNr.length === 10 && !orgNr.includes('-')
                ? orgNr.slice(0, 6) + '-' + orgNr.slice(6)
                : orgNr;
              results.push({
                name,
                orgNr: formatted,
                legalForm: item.bolagsform || 'AB',
                industry: item.bransch || '',
                source: 'datase',
                confidence: 'medium',
              });
            }
          }
        }
      }
    } catch (e) { /* data.se source failed */ }
  }

  // Deduplicate by orgNr
  const seen = new Set();
  const unique = results.filter(r => {
    const key = r.orgNr.replace('-', '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      count: unique.length,
      companies: unique.slice(0, 8),
    }),
  };
};
