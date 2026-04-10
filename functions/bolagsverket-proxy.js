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

  // Debug: return raw HTML sample for analysis
  if (event.queryStringParameters?.debug) {
    const testOrg = (event.queryStringParameters.debug || '').replace(/[^0-9]/g, '');
    if (!testOrg || testOrg.length < 6) {
      return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'v7', note: 'Pass org number as debug param: ?debug=5590016076' }) };
    }
    try {
      const res = await serverFetch(`https://www.allabolag.se/${testOrg}/bokslut`);
      const html = await res.text();
      // Find tables and extract a sample
      const tables = [];
      const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
      let m;
      while ((m = tableRegex.exec(html)) !== null) {
        tables.push(m[1].slice(0, 2000));
      }
      // Also find any div/section with financial data
      const finSection = html.match(/(?:Nettoomsättning|omsättning|Rörelseresultat|Resultaträkning)[\s\S]{0,3000}/i);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 'v7-debug',
          tablesFound: tables.length,
          tables: tables.slice(0, 3),
          financialSection: finSection ? finSection[0].slice(0, 2000) : null,
          htmlLength: html.length,
          hasNettoomsattning: html.includes('Nettoomsättning') || html.includes('nettoomsättning'),
          hasTable: html.includes('<table'),
          sampleH1: (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || null,
        }, null, 2),
      };
    } catch(e) {
      return { statusCode: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Health check
  if (event.queryStringParameters?.health) {
    const testOrg = '5590016076';
    const diagnostics = {
      version: 'v7-multiyear',
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
  // Allabolag uses MUI (Material UI) tables with scope attributes like
  // "resultat2024-12", "resultat2023-12" to identify year columns.
  // Strategy: work on stripped text + find year-keyed data patterns.

  // Step 1: Discover available years from scope/id attributes
  const yearMatches = html.match(/resultat(20\d{2})-\d{2}/g) || [];
  const years = [...new Set(yearMatches.map(m => m.match(/(20\d{2})/)[1]))].sort((a,b) => b-a);

  // Also try to find years from header cells or column headers
  if (years.length === 0) {
    const headerYears = html.match(/>(\d{4}(?:\/\d{2})?(?:-\d{2})?)<\/(?:th|td|span|p)/g) || [];
    for (const hy of headerYears) {
      const m = hy.match(/(20\d{2})/);
      if (m && !years.includes(m[1])) years.push(m[1]);
    }
    years.sort((a,b) => b-a);
  }

  if (years.length === 0) return null;

  // Step 2: Extract all table rows with their cell contents
  // Strip to text but preserve row/cell boundaries
  const allRows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const cells = [];
    const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
      const text = cellMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(text);
    }
    if (cells.length >= 2) {
      allRows.push(cells);
    }
  }

  // Step 3: Find rows that match financial labels and extract per-year values
  const FIELDS = [
    { field: 'netSales',    keywords: ['nettoomsättning', 'nettoomstning'] },
    { field: 'opProfit',    keywords: ['rörelseresultat', 'rrelseresultat'] },
    { field: 'netProfit',   keywords: ['resultat efter finansiella', 'årets resultat', 'resultat före skatt'] },
    { field: 'totalAssets', keywords: ['summa tillgångar', 'summa tillgngar', 'balansomslutning'] },
    { field: 'equity',      keywords: ['summa eget kapital', 'eget kapital'] },
    { field: 'employees',   keywords: ['antal anställda', 'medelantal anst'] },
  ];

  // For each field, find the matching row and extract numeric values
  const fieldData = {}; // { fieldName: { '2024': number, '2023': number, ... } }

  for (const f of FIELDS) {
    for (const row of allRows) {
      const label = row[0].toLowerCase();
      const matched = f.keywords.some(kw => label.includes(kw));
      if (matched) {
        fieldData[f.field] = {};
        // The numeric values are in cells after the label
        // Map them to years in order (first value = most recent year)
        const numericCells = [];
        for (let i = 1; i < row.length; i++) {
          const cleaned = row[i].replace(/\s/g, '').replace(/,/g, '.');
          const num = cleaned.match(/^-?\d+\.?\d*$/) ? parseFloat(cleaned) : null;
          numericCells.push(num);
        }
        // Map to years (columns align with years in order)
        for (let i = 0; i < Math.min(years.length, numericCells.length); i++) {
          if (numericCells[i] !== null) {
            fieldData[f.field][years[i]] = numericCells[i];
          }
        }
        break; // Use first matching row only
      }
    }
  }

  // Step 4: Extract metadata
  const sniMatch = html.match(/SNI[:\s-]*(\d{2,5})/i);
  const sni = sniMatch ? sniMatch[1].trim() : '';
  const legalMatch = html.match(/(Publikt aktiebolag|Aktiebolag|Handelsbolag|Enskild firma)/i);
  const legalForm = legalMatch ? legalMatch[1] : 'Aktiebolag';

  // Step 5: Build year objects
  const yearObjects = years.map(yr => {
    const obj = {
      name: companyName || `Company ${orgNr}`,
      registrationNumber: orgNr,
      companyName: companyName || `Company ${orgNr}`,
      financialYear: yr,
      reportPeriod: yr,
      sni,
      legalForm,
    };

    // Get values for this year
    const ns = fieldData.netSales?.[yr] ?? null;
    const op = fieldData.opProfit?.[yr] ?? null;
    const np = fieldData.netProfit?.[yr] ?? null;
    const ta = fieldData.totalAssets?.[yr] ?? null;
    const eq = fieldData.equity?.[yr] ?? null;
    const em = fieldData.employees?.[yr] ?? null;

    // Auto-detect scale (tkr vs full SEK)
    const maxVal = Math.max(Math.abs(ns || 0), Math.abs(ta || 0), Math.abs(eq || 0));
    const scale = maxVal > 100000000 ? 1 : 1000;

    obj.netSales = ns !== null ? ns * scale : 0;
    obj.revenues = obj.netSales;
    obj.operatingProfit = op !== null ? op * scale : 0;
    obj.netIncome = np !== null ? np * scale : 0;
    obj.profitForYear = obj.netIncome;
    obj.totalAssets = ta !== null ? ta * scale : 0;
    obj.equity = eq !== null ? eq * scale : 0;
    obj.totalEquity = obj.equity;
    obj.employees = em;

    return obj;
  });

  return { years: yearObjects };
}
