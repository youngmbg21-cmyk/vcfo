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

  // Debug: full diagnostic of what the parser extracts for a given org number
  if (event.queryStringParameters?.debug) {
    const testOrg = (event.queryStringParameters.debug || '').replace(/[^0-9]/g, '');
    if (!testOrg || testOrg.length < 6) {
      return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'v9-diagnostic', note: 'Pass org number: ?debug=5590016076' }) };
    }
    try {
      const res = await serverFetch(`https://www.allabolag.se/${testOrg}/bokslut`);
      const html = await res.text();

      // Run the full parser
      const parsed = parseAllabolagMultiYear(html, testOrg, 'DEBUG');

      // Also extract ALL table rows so we can see what the parser sees
      const allTableRows = [];
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trMatch;
      while ((trMatch = trRegex.exec(html)) !== null) {
        const cells = [];
        const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
          cells.push(cellMatch[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim());
        }
        if (cells.length >= 2) allTableRows.push(cells);
      }

      // Build diagnostic: show which rows the parser found
      const latestYear = parsed?.years?.[0];
      const diagnostic = {
        version: 'v9-diagnostic',
        source: 'allabolag.se',
        url: `https://www.allabolag.se/${testOrg}/bokslut`,
        pageSize: html.length,
        totalTableRows: allTableRows.length,
        yearsDetected: parsed ? parsed.years.map(y => y.financialYear) : [],
        latestYear: latestYear?.financialYear || null,

        // Show all rows the parser sees (first 60)
        allRows: allTableRows.slice(0, 60).map((cells, idx) => ({
          rowIndex: idx,
          label: cells[0],
          values: cells.slice(1, 4),  // first 3 year columns
          cellCount: cells.length,
        })),

        // Named field extraction results
        fieldResults: latestYear ? {
          netSales:         { value: latestYear.netSales,         status: latestYear.netSales ? 'OK' : 'ZERO' },
          operatingProfit:  { value: latestYear.operatingProfit,  status: latestYear.operatingProfit ? 'OK' : 'ZERO' },
          netIncome:        { value: latestYear.netIncome,        status: latestYear.netIncome ? 'OK' : 'ZERO' },
          costOfGoods:      { value: latestYear.costOfGoods,      status: latestYear.costOfGoods != null ? 'OK' : 'NULL — not found in filing' },
          personnel:        { value: latestYear.personnel,        status: latestYear.personnel ? 'OK' : 'ZERO' },
          depreciation:     { value: latestYear.depreciation,     status: latestYear.depreciation ? 'OK' : 'ZERO' },
          otherExtCosts:    { value: latestYear.otherExtCosts,    status: latestYear.otherExtCosts != null ? 'OK' : 'NULL — not found in filing' },
          financialIncome:  { value: latestYear.financialIncome,  status: latestYear.financialIncome != null ? 'OK' : 'NULL' },
          financialExpenses:{ value: latestYear.financialExpenses, status: latestYear.financialExpenses != null ? 'OK' : 'NULL' },
          tax:              { value: latestYear.tax,              status: latestYear.tax != null ? 'OK' : 'NULL' },
          employees:        { value: latestYear.employees,        status: latestYear.employees != null ? 'OK' : 'NULL — not found in filing' },
          totalAssets:      { value: latestYear.totalAssets,       status: latestYear.totalAssets ? 'OK' : 'ZERO' },
          equity:           { value: latestYear.equity,           status: latestYear.equity ? 'OK' : 'ZERO' },
        } : 'No year data parsed',

        // Income statement rows for dynamic waterfall
        incomeStatementRows: latestYear?.incomeStatement || [],

        // Math check: do the costs add up to revenue - EBIT?
        mathCheck: latestYear ? (() => {
          const rev = latestYear.netSales;
          const ebit = latestYear.operatingProfit;
          const costs = (latestYear.costOfGoods || 0) + latestYear.personnel +
            latestYear.depreciation + (latestYear.otherExtCosts || 0);
          const gap = rev - costs - ebit;
          return {
            netSales: rev,
            knownCosts: costs,
            ebit: ebit,
            gap: gap,
            gapExplanation: Math.abs(gap) < 1000 ? 'OK — costs + EBIT = Net Sales'
              : `MISSING ${(gap/1000).toFixed(0)} tkr of costs between Net Sales and EBIT`,
            incomeRowCount: latestYear.incomeStatement?.length || 0,
          };
        })() : null,
      };

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(diagnostic, null, 2),
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
    { field: 'costOfGoods',            keywords: ['råvaror och förnödenheter', 'handelsvaror', 'varukostnad', 'kostnad sålda varor', 'kostnad för sålda varor', 'kostnad såld'] },
    { field: 'depreciation',           keywords: ['avskrivningar', 'av- och nedskrivningar', 'avskr'] },
    { field: 'personnel',              keywords: ['personalkostnader', 'löner och andra ersättningar', 'löner', 'personalkostn'] },
    { field: 'otherExtCosts',          keywords: ['övriga externa kostnader', 'övriga rörelsekostnader', 'övriga kostnader'] },
    { field: 'financialIncome',        keywords: ['ränteintäkter och liknande', 'ränteintäkter', 'finansiella intäkter', 'resultat från finansiella poster'] },
    { field: 'financialExpenses',      keywords: ['räntekostnader och liknande', 'räntekostnader', 'finansiella kostnader'] },
    { field: 'tax',                    keywords: ['skatt på årets resultat', 'inkomstskatt', 'skatt'] },
    { field: 'yearResult',             keywords: ['årets resultat'] },
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

  // Step 4b: Extract full income statement rows in filing order
  // Walk from header+1 until we hit a balance sheet section header.
  // Each row with at least one numeric value becomes an income statement line.
  const IS_STOP_KEYWORDS = ['balansräkning', 'tillgångar', 'eget kapital', 'skulder och eget'];
  const IS_SKIP_LABELS = [
    // Section headers (no financial data)
    'rörelsens intäkter', 'rörelsens kostnader', 'resultaträkning',
    'finansiella poster', 'bokslutsdispositioner', 'belopp i',
    // Non-financial metadata that some filings include in the table
    'startdatum', 'slutdatum', 'organisationsnummer', 'org.nr',
    'revisionsberättelse', 'verksamhetsår', 'räkenskapsår',
    'antal anställda', 'medelantal anst',  // employee count — parsed separately
  ];
  const incomeRows = [];
  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const label = allRows[i][0].toLowerCase().trim();
    if (!label) continue;
    // Stop at balance sheet section
    if (IS_STOP_KEYWORDS.some(kw => label.includes(kw))) break;
    // Skip non-financial metadata and section headers
    if (IS_SKIP_LABELS.some(kw => label.includes(kw))) continue;
    // Parse values for each year
    const rowValues = {};
    let hasAny = false;
    for (let j = 0; j < years.length; j++) {
      const cellIdx = j + 1;
      if (cellIdx < allRows[i].length) {
        const val = parseNum(allRows[i][cellIdx]);
        if (val !== null) { rowValues[years[j]] = val; hasAny = true; }
      }
    }
    if (hasAny) {
      incomeRows.push({ label: allRows[i][0].trim(), values: rowValues });
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

  // Step 6: Detect the filing denomination from the header row
  // The header cell typically contains "RESULTATRÄKNING ( Belopp i 1000 )" or "Belopp i 1 000 000"
  let scale = 1000; // default TKR
  if (headerIdx >= 0) {
    const headerText = allRows[headerIdx][0].toLowerCase().replace(/\s/g, '');
    // Check for explicit denomination markers
    if (headerText.includes('beloppitusen') || headerText.includes('beloppikr') || headerText.includes('beloppi1000)')) {
      scale = 1000;
    } else if (headerText.includes('beloppi1000000') || headerText.includes('beloppimilj') || headerText.includes('beloppimkr') || headerText.includes('beloppimsek')) {
      scale = 1000000;
    } else {
      // Try to extract numeric value from "Belopp i NNNN"
      const denomMatch = allRows[headerIdx][0].replace(/\s/g, '').match(/[Bb]elopp\s*i\s*(\d+)/);
      if (denomMatch) {
        const parsed = parseInt(denomMatch[1]);
        if (parsed >= 1000000) scale = 1000000;
        else if (parsed >= 1000) scale = 1000;
        else scale = parsed || 1000;
      }
    }
  }
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
    profitForYear:         (fieldData.yearResult?.[yr] != null ? fieldData.yearResult[yr] : (fieldData.netProfit?.[yr] ?? 0)) * scale,
    costOfGoods:           fieldData.costOfGoods?.[yr] != null  ? Math.abs(fieldData.costOfGoods[yr]) * scale  : null,
    depreciation:          (fieldData.depreciation?.[yr] ?? 0) * scale,
    otherExtCosts:         fieldData.otherExtCosts?.[yr] != null ? Math.abs(fieldData.otherExtCosts[yr]) * scale : null,
    financialIncome:       fieldData.financialIncome?.[yr] != null ? Math.abs(fieldData.financialIncome[yr]) * scale : null,
    financialExpenses:     fieldData.financialExpenses?.[yr] != null ? Math.abs(fieldData.financialExpenses[yr]) * scale : null,
    tax:                   fieldData.tax?.[yr] != null ? Math.abs(fieldData.tax[yr]) * scale : null,
    nonCurrentAssets:      (fieldData.totalFixedAssets?.[yr] ?? 0) * scale,
    currentAssets:         (fieldData.totalCurrentAssets?.[yr] ?? 0) * scale,
    totalAssets:           (fieldData.totalAssets?.[yr] ?? 0) * scale,
    equity:                (fieldData.equity?.[yr] ?? 0) * scale,
    totalEquity:           (fieldData.equity?.[yr] ?? 0) * scale,
    longTermLiabilities:   (fieldData.longTermLiabilities?.[yr] ?? 0) * scale,
    currentLiabilities:    (fieldData.currentLiabilities?.[yr] ?? 0) * scale,
    periodiseringsfonder:  (fieldData.periodiseringsfonder?.[yr] ?? 0) * scale,
    andelarKoncern:        (fieldData.andelarKoncern?.[yr] ?? 0) * scale,
    personnel:             Math.abs((fieldData.personnel?.[yr] ?? 0) * scale),
    auditorRemark,
    auditorRemarkText,
    employees:             fieldData.employees?.[yr] ?? null,
    // Full income statement rows in filing order (for dynamic waterfall chart)
    incomeStatement:       incomeRows
      .filter(r => r.values[yr] != null)
      .map(r => ({ label: r.label, value: r.values[yr] * scale })),
  }));

  return { years: yearObjects };
}
