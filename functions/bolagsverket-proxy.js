// Netlify serverless function — fetches Swedish company financial data.
// Uses working public data sources since Bolagsverket's iXBRL API
// (xbrl.bolagsverket.se) was decommissioned and the official API
// requires OAuth2 registration.

const https = require('https');
const http = require('http');

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
        'Accept': options.accept || 'text/html,application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; VCFO-Terminal/1.0)',
        ...(options.headers || {}),
      },
      timeout: 15000,
    };

    const req = lib.request(reqOptions, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        serverFetch(res.headers.location, options).then(resolve).catch(reject);
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(body),
          json: () => { try { return Promise.resolve(JSON.parse(body)); } catch(e) { return Promise.reject(e); } },
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

  // Health check
  if (event.queryStringParameters?.health) {
    const diagnostics = {
      version: 'v5-allabolag',
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
      tests: {},
    };
    try {
      const res = await serverFetch('https://www.allabolag.se/5560004615/bokslut');
      const text = await res.text();
      diagnostics.tests.allabolag = { ok: res.ok, status: res.status, bodyLength: text.length, hasData: text.includes('Nettoomsättning') || text.includes('omsättning') };
    } catch(e) {
      diagnostics.tests.allabolag = { error: e.message };
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

  const results = {
    orgNr,
    reports: [],
    latestReport: null,
    source: null,
    errors: [],
    availableYears: [],
  };

  // ══════════════════════════════════════════════════════════════
  // Source: Allabolag.se — scrape the bokslut (financial) page
  // This is the most reliable free source for Swedish company data
  // ══════════════════════════════════════════════════════════════
  try {
    const url = `https://www.allabolag.se/${orgNr}/bokslut`;
    const res = await serverFetch(url);

    if (res.ok) {
      const html = await res.text();

      // Extract company name
      const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/) ||
                        html.match(/class="company-name"[^>]*>([^<]+)</) ||
                        html.match(/<title>([^<–|]+)/);
      const companyName = nameMatch ? nameMatch[1].trim().replace(/\s*[-–|].*$/, '').replace(/\s*bokslut.*$/i, '').trim() : null;

      // Extract financial data from the page
      // Allabolag shows key financials in a structured format
      const financials = parseAllabolagFinancials(html, orgNr, companyName);

      if (financials) {
        results.latestReport = financials;
        results.source = 'allabolag';
        results.availableYears = financials._availableYears || [];
      }
    } else {
      results.errors.push(`allabolag: HTTP ${res.status}`);
    }
  } catch (e) {
    results.errors.push(`allabolag: ${e.message}`);
  }

  // ══════════════════════════════════════════════════════════════
  // Fallback: Try the company info page for at least name + basic info
  // ══════════════════════════════════════════════════════════════
  if (!results.latestReport) {
    try {
      const url = `https://www.allabolag.se/${orgNr}`;
      const res = await serverFetch(url);

      if (res.ok) {
        const html = await res.text();
        const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/) ||
                          html.match(/<title>([^<–|]+)/);
        const companyName = nameMatch ? nameMatch[1].trim().replace(/\s*[-–|].*$/, '') : `Company ${orgNr}`;

        // Try to extract any visible financial numbers
        const basicInfo = parseAllabolagBasicInfo(html, orgNr, companyName);
        if (basicInfo) {
          results.latestReport = basicInfo;
          results.source = 'allabolag-basic';
        }
      }
    } catch (e) {
      results.errors.push(`allabolag-basic: ${e.message}`);
    }
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  };
};

// ══════════════════════════════════════════════════════════════
// HTML PARSERS — extract financial data from allabolag.se pages
// ══════════════════════════════════════════════════════════════

function parseAllabolagFinancials(html, orgNr, companyName) {
  // Allabolag.se shows financial data in tables and structured elements
  // We extract key metrics by searching for known Swedish financial terms

  const data = {
    name: companyName || `Company ${orgNr}`,
    registrationNumber: orgNr,
    companyName: companyName || `Company ${orgNr}`,
  };

  // Helper: extract a number near a label
  function findValue(label, text) {
    // Look for patterns like "Nettoomsättning\n123 456" or "Nettoomsättning</td><td>123 456"
    const patterns = [
      new RegExp(label + '[^\\d-]*?([\\-]?[\\d\\s]+(?:\\s\\d{3})*)', 'i'),
      new RegExp(label + '[^>]*>[^>]*>([\\-]?[\\d\\s,.]+)<', 'i'),
      new RegExp(label + '</(?:td|th|dt|div|span)>\\s*<(?:td|dd|div|span)[^>]*>\\s*([\\-]?[\\d\\s,.]+)', 'i'),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const cleaned = m[1].replace(/\s/g, '').replace(/,/g, '.');
        const num = parseFloat(cleaned);
        if (!isNaN(num)) return num;
      }
    }
    return null;
  }

  // Strip HTML tags for easier number extraction
  const stripped = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

  // Key financial fields (Swedish terms from annual reports)
  // Values on allabolag are typically in tkr (thousands SEK)
  const netSales = findValue('(?:Nettoomsättning|Nettoomstning|Net sales)', stripped);
  const opProfit = findValue('(?:Rörelseresultat|Rrelseresultat|Operating profit)', stripped);
  const netProfit = findValue('(?:Resultat efter finansiella poster|Årets resultat|Resultat före skatt)', stripped);
  const totalAssets = findValue('(?:Summa tillgångar|Summa tillgngar|Balansomslutning|Total assets)', stripped);
  const equity = findValue('(?:Eget kapital|Summa eget kapital)', stripped);
  const employees = findValue('(?:Antal anställda|Anställda|Medelantal anstllda)', stripped);

  // Check if we got meaningful data (at least revenue or assets)
  if (netSales === null && totalAssets === null && equity === null) {
    return null; // No financial data found on page
  }

  // Allabolag typically shows values in tkr (thousands)
  const scale = 1000; // Convert tkr to kr

  data.netSales = netSales !== null ? netSales * scale : 0;
  data.revenues = data.netSales;
  data.operatingProfit = opProfit !== null ? opProfit * scale : 0;
  data.netIncome = netProfit !== null ? netProfit * scale : (opProfit !== null ? opProfit * scale * 0.8 : 0);
  data.totalAssets = totalAssets !== null ? totalAssets * scale : 0;
  data.equity = equity !== null ? equity * scale : 0;
  data.totalEquity = data.equity;
  data.employees = employees;

  // Try to find fiscal year
  const yearMatch = html.match(/(?:Bokslut|Räkenskapsår|bokslut)\s*(\d{4})/i) ||
                    html.match(/20[12]\d-(?:01|12)-\d{2}/);
  data.financialYear = yearMatch ? yearMatch[1] || yearMatch[0].slice(0, 4) : new Date().getFullYear().toString();
  data.reportPeriod = data.financialYear;

  // Try to find SNI code
  const sniMatch = html.match(/SNI[:\s-]*(\d{2,5})/i) || html.match(/bransch[^>]*>([^<]*\d{2,5})/i);
  data.sni = sniMatch ? sniMatch[1].trim() : '';

  // Try to find legal form
  const legalMatch = html.match(/(Aktiebolag|Handelsbolag|Enskild firma|Publikt aktiebolag|Ekonomisk förening)/i);
  data.legalForm = legalMatch ? legalMatch[1] : 'Aktiebolag';

  // Available years — look for year links/tabs on the page
  const yearLinks = html.match(/bokslut\/(\d{4})/g) || [];
  data._availableYears = [...new Set(yearLinks.map(y => y.replace('bokslut/', '')))].sort((a,b) => b-a);
  if (data.financialYear && !data._availableYears.includes(data.financialYear)) {
    data._availableYears.unshift(data.financialYear);
  }

  return data;
}

function parseAllabolagBasicInfo(html, orgNr, companyName) {
  const stripped = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

  // Try to find at least the company name and any numbers
  const data = {
    name: companyName || `Company ${orgNr}`,
    registrationNumber: orgNr,
    companyName: companyName || `Company ${orgNr}`,
  };

  // Look for omsättning (revenue) in any format
  const revenueMatch = stripped.match(/(?:omsättning|omstning)[:\s]*([\\-]?\d[\d\s]*)/i);
  if (revenueMatch) {
    const val = parseFloat(revenueMatch[1].replace(/\s/g, ''));
    if (!isNaN(val)) data.netSales = val * 1000;
    data.revenues = data.netSales;
  }

  // Look for resultat (profit)
  const profitMatch = stripped.match(/(?:resultat)[:\s]*([\\-]?\d[\d\s]*)/i);
  if (profitMatch) {
    const val = parseFloat(profitMatch[1].replace(/\s/g, ''));
    if (!isNaN(val)) data.netIncome = val * 1000;
  }

  const sniMatch = html.match(/SNI[:\s-]*(\d{2,5})/i);
  data.sni = sniMatch ? sniMatch[1].trim() : '';

  const legalMatch = html.match(/(Aktiebolag|Handelsbolag|Enskild firma|Publikt aktiebolag)/i);
  data.legalForm = legalMatch ? legalMatch[1] : 'Aktiebolag';

  // Only return if we found a name at least
  return data.name !== `Company ${orgNr}` ? data : null;
}
