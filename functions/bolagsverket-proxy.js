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

  // Health check — also tests year-specific URL patterns
  if (event.queryStringParameters?.health) {
    const testOrg = '5590016076'; // Stadstak Sthlm AB
    const diagnostics = {
      version: 'v6-year-fix',
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
      tests: {},
    };

    // Test different URL patterns to find which one works for year-specific data
    const patterns = [
      { name: 'default',      url: `https://www.allabolag.se/${testOrg}/bokslut` },
      { name: 'year-slash',   url: `https://www.allabolag.se/${testOrg}/bokslut/2023` },
      { name: 'year-query',   url: `https://www.allabolag.se/${testOrg}/bokslut?year=2023` },
      { name: 'year-hash',    url: `https://www.allabolag.se/${testOrg}/bokslut#2023` },
    ];

    for (const p of patterns) {
      try {
        const res = await serverFetch(p.url);
        const text = await res.text();
        // Look for a year indicator in the response
        const has2023 = text.includes('2023');
        const has2024 = text.includes('2024');
        const hasData = text.includes('Nettoomsättning') || text.includes('omsättning');
        // Try to find which fiscal year the page is showing
        const fyMatch = text.match(/Bokslut\s+(\d{4})/i) || text.match(/Räkenskapsår[:\s]*(\d{4})/i);
        diagnostics.tests[p.name] = {
          ok: res.ok,
          status: res.status,
          finalUrl: p.url,
          bodyLength: text.length,
          hasData,
          detectedFY: fyMatch ? fyMatch[1] : null,
          has2023,
          has2024,
        };
      } catch(e) {
        diagnostics.tests[p.name] = { error: e.message };
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
  // Source: Allabolag.se — multi-year bokslut page
  // The page always shows ALL years in one table. We parse all
  // columns and return data for the requested year.
  // ══════════════════════════════════════════════════════════════
  try {
    // Always fetch the base bokslut page (year in URL is ignored by allabolag)
    const url = `https://www.allabolag.se/${orgNr}/bokslut`;
    const res = await serverFetch(url);

    if (res.ok) {
      const html = await res.text();

      // Extract company name
      const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/) ||
                        html.match(/class="company-name"[^>]*>([^<]+)</) ||
                        html.match(/<title>([^<–|]+)/);
      const companyName = nameMatch ? nameMatch[1].trim().replace(/\s*[-–|].*$/, '').replace(/\s*bokslut.*$/i, '').trim() : null;

      // Parse ALL years from the multi-year table
      const allYearsData = parseAllabolagMultiYear(html, orgNr, companyName);

      if (allYearsData && allYearsData.years.length > 0) {
        results.availableYears = allYearsData.years.map(y => y.fiscalYear).filter(Boolean);
        results.source = 'allabolag';

        // Select the requested year, or latest
        let selected = null;
        if (requestedYear && requestedYear !== 'latest') {
          selected = allYearsData.years.find(y => y.fiscalYear === requestedYear);
        }
        if (!selected) {
          selected = allYearsData.years[0]; // first = most recent
        }

        if (selected) {
          results.latestReport = selected;
          results.resolvedYear = selected.fiscalYear;
        } else {
          results.errors.push(`No data for FY${requestedYear}. Available: ${results.availableYears.join(', ')}`);
        }
      } else {
        results.errors.push('Page loaded but no financial table found');
      }
    } else {
      results.errors.push(`allabolag: HTTP ${res.status}`);
    }
  } catch (e) {
    results.errors.push(`allabolag: ${e.message}`);
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  };
};

// ══════════════════════════════════════════════════════════════
// MULTI-YEAR PARSER — allabolag.se shows all years in one table
// The table has: [Label] [Year1] [Year2] [Year3] ...
// We parse ALL columns and return an array of year objects.
// ══════════════════════════════════════════════════════════════

function parseAllabolagMultiYear(html, orgNr, companyName) {
  // Step 1: Extract all <table> blocks and find the financial table
  // The financial table contains rows with labels like "Nettoomsättning"
  const tables = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    tables.push(tableMatch[1]);
  }

  // Find the table that contains financial keywords
  let finTable = null;
  for (const t of tables) {
    const lower = t.toLowerCase();
    if (lower.includes('nettoomsättning') || lower.includes('nettoomstning') ||
        lower.includes('omsättning') || lower.includes('rörelseresultat') ||
        lower.includes('balansomslutning') || lower.includes('summa tillgångar')) {
      finTable = t;
      break;
    }
  }

  if (!finTable) return null;

  // Step 2: Parse header row to find year columns
  const headerMatch = finTable.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
  if (!headerMatch) return null;

  const headerCells = [];
  const thRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let thMatch;
  while ((thMatch = thRegex.exec(headerMatch[1])) !== null) {
    headerCells.push(thMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
  }

  // Find which columns are years (4-digit numbers)
  const yearColumns = []; // [{index, year}]
  headerCells.forEach((cell, idx) => {
    const ym = cell.match(/(20\d{2})/);
    if (ym && idx > 0) { // skip first column (labels)
      yearColumns.push({ index: idx, year: ym[1] });
    }
  });

  if (yearColumns.length === 0) return null;

  // Step 3: Parse all data rows — extract label + values per year column
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  // Skip the first match (header)
  trRegex.exec(finTable); // consume header
  while ((trMatch = trRegex.exec(finTable)) !== null) {
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      tds.push(tdMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\u00a0/g, '').trim());
    }
    if (tds.length >= 2) {
      const label = tds[0].toLowerCase().replace(/\s+/g, ' ').trim();
      const values = {};
      for (const yc of yearColumns) {
        if (tds[yc.index] !== undefined) {
          const raw = tds[yc.index].replace(/\s/g, '').replace(/,/g, '.');
          const num = raw.match(/^-?\d+\.?\d*$/) ? parseFloat(raw) : null;
          values[yc.year] = num;
        }
      }
      rows.push({ label, values });
    }
  }

  // Step 4: Map labels to financial fields per year
  const FIELD_MAP = [
    { field: 'netSales',    keywords: ['nettoomsättning', 'nettoomstning', 'net sales'] },
    { field: 'opProfit',    keywords: ['rörelseresultat', 'rrelseresultat', 'operating'] },
    { field: 'netProfit',   keywords: ['resultat efter finansiella', 'resultat e. fin', 'årets resultat', 'resultat före skatt'] },
    { field: 'totalAssets', keywords: ['summa tillgångar', 'summa tillgngar', 'balansomslutning'] },
    { field: 'equity',      keywords: ['summa eget kapital', 'eget kapital'] },
    { field: 'employees',   keywords: ['antal anställda', 'anställda', 'medelantal anst'] },
  ];

  function findRow(keywords) {
    for (const row of rows) {
      for (const kw of keywords) {
        if (row.label.includes(kw)) return row;
      }
    }
    return null;
  }

  // Extract metadata from the full HTML
  const sniMatch = html.match(/SNI[:\s-]*(\d{2,5})/i);
  const sni = sniMatch ? sniMatch[1].trim() : '';
  const legalMatch = html.match(/(Publikt aktiebolag|Aktiebolag|Handelsbolag|Enskild firma)/i);
  const legalForm = legalMatch ? legalMatch[1] : 'Aktiebolag';

  // Step 5: Build data object for each year
  const yearObjects = yearColumns.map(yc => {
    const yr = yc.year;
    const obj = {
      name: companyName || `Company ${orgNr}`,
      registrationNumber: orgNr,
      companyName: companyName || `Company ${orgNr}`,
      financialYear: yr,
      reportPeriod: yr,
      sni,
      legalForm,
    };

    for (const fm of FIELD_MAP) {
      const row = findRow(fm.keywords);
      obj[fm.field] = row ? (row.values[yr] || null) : null;
    }

    // Allabolag shows values in tkr — auto-detect and scale
    const maxVal = Math.max(
      Math.abs(obj.netSales || 0),
      Math.abs(obj.totalAssets || 0),
      Math.abs(obj.equity || 0)
    );
    const scale = maxVal > 100000000 ? 1 : 1000;

    // Apply scale and set API-compatible field names
    obj.netSales = obj.netSales !== null ? obj.netSales * scale : 0;
    obj.revenues = obj.netSales;
    obj.operatingProfit = obj.opProfit !== null ? obj.opProfit * scale : 0;
    delete obj.opProfit;
    obj.netIncome = obj.netProfit !== null ? obj.netProfit * scale : 0;
    obj.profitForYear = obj.netIncome;
    delete obj.netProfit;
    obj.totalAssets = obj.totalAssets !== null ? obj.totalAssets * scale : 0;
    obj.equity = obj.equity !== null ? obj.equity * scale : 0;
    obj.totalEquity = obj.equity;

    return obj;
  });

  // Sort by year descending (most recent first)
  yearObjects.sort((a, b) => parseInt(b.financialYear) - parseInt(a.financialYear));

  return {
    years: yearObjects,
  };
}
