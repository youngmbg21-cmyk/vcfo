// Netlify serverless function — fetches Swedish company financial data.
// Uses working public data sources since Bolagsverket's iXBRL API
// (xbrl.bolagsverket.se) was decommissioned and the official API
// requires OAuth2 registration.

const https = require('https');
const http = require('http');

function serverFetch(url, options = {}, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > 5) { reject(new Error('Too many redirects')); return; }

    let parsedUrl;
    try { parsedUrl = new URL(url); }
    catch(e) { reject(new Error(`Invalid URL: ${url}`)); return; }

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Accept': options.accept || 'text/html,application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(options.headers || {}),
      },
      timeout: 15000,
    };

    const req = lib.request(reqOptions, (res) => {
      // Follow redirects — resolve relative URLs against the original
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl;
        try {
          redirectUrl = new URL(res.headers.location, url).href;
        } catch(e) {
          redirectUrl = res.headers.location;
        }
        serverFetch(redirectUrl, options, _redirectCount + 1).then(resolve).catch(reject);
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

  const requestedYear = event.queryStringParameters?.year || '';

  const results = {
    orgNr,
    requestedYear: requestedYear || 'latest',
    resolvedYear: null,
    reports: [],
    latestReport: null,
    source: null,
    errors: [],
    availableYears: [],
  };

  // ══════════════════════════════════════════════════════════════
  // Source: Allabolag.se — scrape the bokslut (financial) page
  // Use year-specific URL when a year is selected
  // ══════════════════════════════════════════════════════════════
  try {
    // Allabolag supports year-specific URLs: /{orgNr}/bokslut/{year}
    const yearPath = (requestedYear && requestedYear !== 'latest') ? `/${requestedYear}` : '';
    const url = `https://www.allabolag.se/${orgNr}/bokslut${yearPath}`;
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
        results.resolvedYear = financials.financialYear || requestedYear || null;
        results.availableYears = financials._availableYears || [];
      } else {
        // Page loaded but no financials parsed — report clearly
        results.errors.push(`allabolag: Page loaded but no financial data found for ${requestedYear || 'latest'} year`);
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
  const data = {
    name: companyName || `Company ${orgNr}`,
    registrationNumber: orgNr,
    companyName: companyName || `Company ${orgNr}`,
  };

  // Strategy: extract numbers from table rows in the HTML.
  // Allabolag.se puts financials in <tr> rows with label in one <td> and value in next <td>.
  // Values can be in tkr (thousands) or full SEK depending on company size.

  // Step 1: Find all table rows and extract label-value pairs
  const pairs = {};
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const row = trMatch[1];
    // Extract all td contents
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(row)) !== null) {
      tds.push(tdMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    }
    if (tds.length >= 2) {
      const label = tds[0].toLowerCase().replace(/\s+/g, ' ').trim();
      // Take the first numeric value column (skip label column)
      for (let i = 1; i < tds.length; i++) {
        const raw = tds[i].replace(/\u00a0/g, '').replace(/\s/g, '').replace(/,/g, '.');
        // Match numbers like: 123456, -123456, 123.456
        const numMatch = raw.match(/^-?\d+\.?\d*$/);
        if (numMatch) {
          pairs[label] = parseFloat(numMatch[0]);
          break;
        }
      }
    }
  }

  // Step 2: Also try extracting from definition lists and divs
  const stripped = html.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"');

  // Step 3: Map Swedish labels to our fields
  function findInPairs(keywords) {
    for (const [label, val] of Object.entries(pairs)) {
      for (const kw of keywords) {
        if (label.includes(kw.toLowerCase())) return val;
      }
    }
    return null;
  }

  const netSales    = findInPairs(['nettoomsättning', 'nettoomstning', 'omsättning', 'net sales']);
  const opProfit    = findInPairs(['rörelseresultat', 'rrelseresultat', 'operating profit']);
  const netProfit   = findInPairs(['resultat efter finansiella', 'resultat e. finansiella', 'årets resultat', 'resultat före skatt']);
  const totalAssets = findInPairs(['summa tillgångar', 'summa tillgngar', 'balansomslutning']);
  const equity      = findInPairs(['summa eget kapital', 'eget kapital']);
  const employees   = findInPairs(['antal anställda', 'anställda', 'medelantal']);

  // Check if we found anything
  if (netSales === null && totalAssets === null && equity === null) {
    // If table parsing failed, try a simpler line-by-line approach on stripped text
    return parseAllabolagSimple(stripped, orgNr, companyName, html);
  }

  // Allabolag shows values in tkr (thousands SEK) for most companies
  // Detect if values seem to already be in full SEK (very large numbers)
  const maxVal = Math.max(Math.abs(netSales || 0), Math.abs(totalAssets || 0), Math.abs(equity || 0));
  const scale = maxVal > 100000000 ? 1 : 1000; // If already > 100M, don't multiply

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

// Simpler line-by-line parser as fallback
function parseAllabolagSimple(stripped, orgNr, companyName, html) {
  const data = {
    name: companyName || `Company ${orgNr}`,
    registrationNumber: orgNr,
    companyName: companyName || `Company ${orgNr}`,
  };

  // Look for "label ... number" patterns in the text, limiting number to reasonable length
  function findNearLabel(text, keywords) {
    for (const kw of keywords) {
      // Find keyword, then look for a number within 100 chars after it
      const idx = text.toLowerCase().indexOf(kw.toLowerCase());
      if (idx >= 0) {
        const after = text.slice(idx + kw.length, idx + kw.length + 100);
        // Match a number: optional minus, 1-12 digits (with optional spaces as thousands sep)
        const m = after.match(/(-?\d[\d\s]{0,15}\d|\d)/);
        if (m) {
          const cleaned = m[0].replace(/\s/g, '');
          if (cleaned.length <= 12) { // Sanity: max ~999 billion
            const val = parseInt(cleaned, 10);
            if (!isNaN(val)) return val;
          }
        }
      }
    }
    return null;
  }

  const netSales    = findNearLabel(stripped, ['Nettoomsättning', 'Nettoomstning']);
  const opProfit    = findNearLabel(stripped, ['Rörelseresultat', 'Rrelseresultat']);
  const netProfit   = findNearLabel(stripped, ['Resultat efter finansiella', 'Årets resultat']);
  const totalAssets = findNearLabel(stripped, ['Summa tillgångar', 'Balansomslutning']);
  const equity      = findNearLabel(stripped, ['Summa eget kapital', 'Eget kapital']);

  if (netSales === null && totalAssets === null) return null;

  // Auto-detect scale
  const maxVal = Math.max(Math.abs(netSales || 0), Math.abs(totalAssets || 0));
  const scale = maxVal > 100000000 ? 1 : 1000;

  data.netSales = netSales !== null ? netSales * scale : 0;
  data.revenues = data.netSales;
  data.operatingProfit = opProfit !== null ? opProfit * scale : 0;
  data.netIncome = netProfit !== null ? netProfit * scale : 0;
  data.totalAssets = totalAssets !== null ? totalAssets * scale : 0;
  data.equity = equity !== null ? equity * scale : 0;
  data.totalEquity = data.equity;

  const yearMatch = html.match(/bokslut\/(\d{4})/) || html.match(/(\d{4})-(?:01|12)-\d{2}/);
  data.financialYear = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
  data.reportPeriod = data.financialYear;

  const sniMatch = html.match(/SNI[:\s-]*(\d{2,5})/i);
  data.sni = sniMatch ? sniMatch[1].trim() : '';

  const legalMatch = html.match(/(Aktiebolag|Handelsbolag|Publikt aktiebolag)/i);
  data.legalForm = legalMatch ? legalMatch[1] : 'Aktiebolag';

  const yearLinks = html.match(/bokslut\/(\d{4})/g) || [];
  data._availableYears = [...new Set(yearLinks.map(y => y.replace('bokslut/', '')))].sort((a,b) => b-a);

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
