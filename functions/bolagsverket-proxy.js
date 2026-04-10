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

  // Debug: show parsed rows and year mapping
  if (event.queryStringParameters?.debug) {
    const testOrg = (event.queryStringParameters.debug || '').replace(/[^0-9]/g, '');
    if (!testOrg || testOrg.length < 6) {
      return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'v8', note: 'Pass org number: ?debug=5590016076' }) };
    }
    try {
      const res = await serverFetch(`https://www.allabolag.se/${testOrg}/bokslut`);
      const html = await res.text();

      // Show what the parser sees
      const yearMatches = html.match(/resultat(20\d{2})-\d{2}/g) || [];
      const years = [...new Set(yearMatches.map(m => m.match(/(20\d{2})/)[1]))].sort((a,b) => b-a);

      // Extract sample rows
      const sampleRows = [];
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch;
      let rowCount = 0;
      while ((trMatch = trRegex.exec(html)) !== null && rowCount < 30) {
        const cells = [];
        const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
          cells.push(cellMatch[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim());
        }
        if (cells.length >= 2) {
          const isFinancial = cells[0].toLowerCase().match(/omsättning|resultat|tillgångar|kapital|balans/);
          if (isFinancial) {
            sampleRows.push({ label: cells[0], values: cells.slice(1), cellCount: cells.length });
            rowCount++;
          }
        }
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 'v8-debug',
          yearsFromScope: years,
          financialRows: sampleRows.slice(0, 15),
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
        // Filter out years with no actual data (all zeros)
        const yearsWithData = allYearsData.years.filter(y =>
          y.netSales !== 0 || y.totalAssets !== 0 || y.equity !== 0
        );
        results.availableYears = yearsWithData.map(y => y.financialYear).filter(Boolean);
        results.reports = yearsWithData;
        results.source = 'allabolag';

        // Select the requested year from years that have actual data
        let selected = null;
        if (requestedYear && requestedYear !== 'latest') {
          selected = yearsWithData.find(y => y.financialYear === requestedYear);
        }
        if (!selected && yearsWithData.length > 0) {
          selected = yearsWithData[0]; // first with data = most recent
        }

        if (selected) {
          results.latestReport = selected;
          results.resolvedYear = selected.financialYear;
        } else if (results.availableYears.length > 0) {
          results.errors.push(`No data for FY${requestedYear}. Available: ${results.availableYears.join(', ')}`);
        } else {
          results.errors.push('Financial table found but all values are zero');
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
  // Based on actual HTML analysis: allabolag's bokslut page has rows like:
  //   Row 0: ["RESULTATRÄKNING ( Belopp i 1000 )", "2024-12", "2023-12", "2022-12", ...]  ← header
  //   Row 1: ["Nettoomsättning", "31 927", "29 425", "27 016", ...]                       ← data
  // Values use spaces as thousands separators. Scale is tkr (Belopp i 1000).

  // Step 1: Extract ALL table rows as arrays of cell text
  const allRows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const cells = [];
    const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.length >= 2) allRows.push(cells);
  }

  // Step 2: Find header row — the one where cells[1..N] contain year patterns like "2024-12" or "2024"
  let years = [];
  let headerIdx = -1;
  for (let i = 0; i < allRows.length; i++) {
    const yCells = [];
    for (let j = 1; j < allRows[i].length; j++) {
      const ym = allRows[i][j].match(/(20\d{2})/);
      if (ym) yCells.push(ym[1]);
    }
    // Need at least 2 year columns to be a valid header
    if (yCells.length >= 2) { years = yCells; headerIdx = i; break; }
  }

  if (years.length === 0 || headerIdx === -1) return null;

  // Step 3: Parse number from cell text (handles "31 927", "-4 524", "0", empty)
  function parseNum(text) {
    if (!text || text.trim() === '' || text === '-') return null;
    const cleaned = text.replace(/\s/g, '').replace(/,/g, '.');
    if (cleaned === '') return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }

  // Step 4: Extract financial data from rows after the header
  const FIELDS = [
    { field: 'netSales',               keywords: ['nettoomsättning', 'nettoomstning'] },
    { field: 'opProfit',               keywords: ['rörelseresultat', 'rrelseresultat'] },
    { field: 'netProfit',              keywords: ['resultat efter finansiella', 'resultat e. fin', 'årets resultat', 'resultat före skatt'] },
    { field: 'depreciation',           keywords: ['avskrivningar', 'av- och nedskrivningar', 'avskr'] },
    { field: 'totalFixedAssets',       keywords: ['summa anläggningstillgångar', 'summa anlggningstillgngar', 'anläggningstillgångar'] },
    { field: 'totalCurrentAssets',     keywords: ['summa omsättningstillgångar', 'summa omsttningstillgngar', 'omsättningstillgångar'] },
    { field: 'totalAssets',            keywords: ['summa tillgångar', 'summa tillgngar', 'balansomslutning'] },
    { field: 'equity',                 keywords: ['summa eget kapital', 'eget kapital'] },
    { field: 'longTermLiabilities',    keywords: ['summa långfristiga skulder', 'långfristiga skulder', 'lngfristiga skulder'] },
    { field: 'currentLiabilities',     keywords: ['summa kortfristiga skulder', 'kortfristiga skulder'] },
    { field: 'periodiseringsfonder',   keywords: ['periodiseringsfonder', 'obeskattade reserver', 'avsättning till periodiseringsfond'] },
    { field: 'andelarKoncern',         keywords: ['andelar i koncernföretag', 'andelar i dotterföretag', 'andelar koncern'] },
    { field: 'employees',              keywords: ['antal anställda', 'medelantal anst'] },
  ];

  // fieldData[field][year] = number
  const fieldData = {};
  for (const f of FIELDS) {
    for (let i = headerIdx + 1; i < allRows.length; i++) {
      const label = allRows[i][0].toLowerCase();
      if (f.keywords.some(kw => label.includes(kw))) {
        fieldData[f.field] = {};
        // cells[1] → years[0], cells[2] → years[1], etc.
        for (let j = 0; j < years.length; j++) {
          const cellIdx = j + 1; // skip label column
          if (cellIdx < allRows[i].length) {
            const val = parseNum(allRows[i][cellIdx]);
            if (val !== null) fieldData[f.field][years[j]] = val;
          }
        }
        break; // first match only
      }
    }
  }

  // Step 5: Metadata
  const sniMatch = html.match(/SNI[:\s-]*(\d{2,5})/i);
  const sni = sniMatch ? sniMatch[1].trim() : '';
  const legalMatch = html.match(/(Publikt aktiebolag|Aktiebolag|Handelsbolag|Enskild firma)/i);
  const legalForm = legalMatch ? legalMatch[1] : 'Aktiebolag';

  // Step 5b: Auditor remarks — parse from page text
  // Allabolag surfaces "Anmärkning" from the auditor's report
  const auditorRemark = /anm[äa]rkning/i.test(html) || /revisorsanm[äa]rkning/i.test(html);
  let auditorRemarkText = '';
  if (auditorRemark) {
    const remarkMatch = html.match(/anm[äa]rkning[^<]{0,30}<[^>]+>([^<]{10,300})/i);
    if (remarkMatch) auditorRemarkText = remarkMatch[1].replace(/\s+/g, ' ').trim();
    if (!auditorRemarkText) {
      auditorRemarkText = 'Auditor remark (Anmärkning) noted in annual report.';
    }
  }

  // Step 6: Build per-year objects (values in tkr, scale ×1000)
  const scale = 1000;
  const yearObjects = years.map(yr => ({
    name: companyName || `Company ${orgNr}`,
    registrationNumber: orgNr,
    companyName: companyName || `Company ${orgNr}`,
    financialYear: yr,
    reportPeriod: yr,
    sni,
    legalForm,
    netSales:              (fieldData.netSales?.[yr] ?? 0) * scale,
    revenues:              (fieldData.netSales?.[yr] ?? 0) * scale,
    operatingProfit:       (fieldData.opProfit?.[yr] ?? 0) * scale,
    netIncome:             (fieldData.netProfit?.[yr] ?? 0) * scale,
    profitForYear:         (fieldData.netProfit?.[yr] ?? 0) * scale,
    depreciation:          (fieldData.depreciation?.[yr] ?? 0) * scale,
    nonCurrentAssets:      (fieldData.totalFixedAssets?.[yr] ?? 0) * scale,
    currentAssets:         (fieldData.totalCurrentAssets?.[yr] ?? 0) * scale,
    totalAssets:           (fieldData.totalAssets?.[yr] ?? 0) * scale,
    equity:                (fieldData.equity?.[yr] ?? 0) * scale,
    totalEquity:           (fieldData.equity?.[yr] ?? 0) * scale,
    longTermLiabilities:   (fieldData.longTermLiabilities?.[yr] ?? 0) * scale,
    currentLiabilities:    (fieldData.currentLiabilities?.[yr] ?? 0) * scale,
    periodiseringsfonder:  (fieldData.periodiseringsfonder?.[yr] ?? 0) * scale,
    andelarKoncern:        (fieldData.andelarKoncern?.[yr] ?? 0) * scale,
    auditorRemark,
    auditorRemarkText,
    employees:             fieldData.employees?.[yr] ?? null,
  }));

  return { years: yearObjects };
}
