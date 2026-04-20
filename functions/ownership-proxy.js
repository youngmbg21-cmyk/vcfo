// Netlify serverless function — fetches board members, shareholders, and
// county from the allabolag.se company overview page for a given org number.
// Results are used by the Succession Radar to compute owner age signals.

const https = require('https');
const http = require('http');

function serverFetch(url, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > 5) { reject(new Error('Too many redirects')); return; }
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch(e) { reject(new Error(`Invalid URL: ${url}`)); return; }
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'sv-SE,sv;q=0.9',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        serverFetch(redirectUrl, _redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: () => Promise.resolve(body) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=86400',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const orgNr = (event.queryStringParameters?.orgNr || '').replace(/[^0-9]/g, '');
  if (!orgNr || orgNr.length < 10) {
    return { statusCode: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Parameter orgNr required (10 digits)' }) };
  }

  try {
    const res = await serverFetch(`https://www.allabolag.se/${orgNr}`);
    if (!res.ok) {
      return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgNr, boardMembers: [], shareholders: [], county: null, primaryOwner: null, fetchedAt: new Date().toISOString() }) };
    }
    const html = await res.text();
    const data = parseOwnershipPage(html, orgNr);
    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(data) };
  } catch(e) {
    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgNr, boardMembers: [], shareholders: [], county: null, primaryOwner: null, fetchedAt: new Date().toISOString(), error: e.message }) };
  }
};

function parseOwnershipPage(html, orgNr) {
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

  // ── County from address ──────────────────────────────────────────────────
  const COUNTY_NAMES = [
    'Stockholms','Uppsala','Södermanlands','Östergötlands','Jönköpings',
    'Kronobergs','Kalmar','Gotlands','Blekinge','Skåne','Hallands',
    'Västra Götalands','Värmlands','Örebro','Västmanlands','Dalarnas',
    'Gävleborgs','Västernorrlands','Jämtlands','Västerbottens','Norrbottens',
  ];
  let county = null;
  for (const c of COUNTY_NAMES) {
    if (html.includes(c + ' ') || html.includes(c + '<') || html.includes(c + ',')) {
      county = c;
      break;
    }
  }

  // ── Board members ────────────────────────────────────────────────────────
  // Allabolag renders board in sections like "Styrelseledamot", "Ordförande", "VD"
  // Names are typically in <td>, <dd>, or <li> elements near role labels.
  const boardMembers = [];
  const roles = ['Styrelseordförande','Ordförande','Styrelseledamot','Verkställande direktör','VD',
                  'Suppleant','Firmatecknare','Revisor'];

  // Strategy: find text blocks around role keywords, extract names
  for (const role of roles) {
    // Look for the role keyword then the name nearby
    const rolePattern = new RegExp(role + '[^<]{0,200}', 'gi');
    let m;
    while ((m = rolePattern.exec(html)) !== null) {
      const block = strip(m[0]);
      // Extract name: typically a capitalised 2-3 word sequence
      const nameMatch = block.match(/([A-ZÅÄÖ][a-zåäö]+(?:\s+[A-ZÅÄÖ][a-zåäö]+){1,3})/);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        if (name.length > 4 && !boardMembers.some(b => b.name === name)) {
          const parts = name.split(/\s+/);
          boardMembers.push({
            name,
            role,
            lastName: parts[parts.length - 1],
            birthYear: null, // hard to reliably extract without personnummer exposure
          });
        }
      }
    }
  }

  // ── Birth year from personnummer patterns ────────────────────────────────
  // Some pages expose partial personnummer like "YYMMDD-XXXX" or "born YYYY"
  // Try to match 6-digit date patterns near board member names
  const bornYearPattern = /(?:f(?:ödd|öddes?)|born?)[:\s]*(\d{4})/gi;
  let bm;
  while ((bm = bornYearPattern.exec(html)) !== null) {
    const yr = parseInt(bm[1]);
    // Plausible birth years for business owners: 1930–1985
    if (yr >= 1930 && yr <= 1985) {
      // Assign to first board member without a birthYear if possible
      const unset = boardMembers.find(b => b.birthYear === null);
      if (unset) unset.birthYear = yr;
    }
  }

  // Also try YYMMDD pattern (personnummer style)
  const pnrPattern = /\b(\d{2})(\d{2})(\d{2})-\d{4}\b/g;
  while ((bm = pnrPattern.exec(html)) !== null) {
    const yy = parseInt(bm[1]);
    // Heuristic: business owners born 1930-1985 → century prefix
    const fullYear = yy >= 30 ? 1900 + yy : 2000 + yy;
    if (fullYear >= 1930 && fullYear <= 1985) {
      const unset = boardMembers.find(b => b.birthYear === null);
      if (unset) unset.birthYear = fullYear;
    }
  }

  // ── Shareholders ─────────────────────────────────────────────────────────
  const shareholders = [];
  // Look for ownership percentage patterns: "Johan Andersson 100 %"
  const ownershipPattern = /([A-ZÅÄÖ][a-zåäöA-ZÅÄÖ\s]{3,40}?)\s+(\d{1,3}(?:[,\.]\d{1,2})?)\s*%/g;
  let om;
  while ((om = ownershipPattern.exec(html)) !== null) {
    const name = om[1].trim();
    const pct = parseFloat(om[2].replace(',', '.'));
    if (pct > 5 && pct <= 100 && !shareholders.some(s => s.name === name)) {
      const parts = name.split(/\s+/);
      shareholders.push({ name, ownership: pct, lastName: parts[parts.length - 1], birthYear: null });
    }
  }

  // ── Primary owner ────────────────────────────────────────────────────────
  // Best guess: largest shareholder, or board chair if no shareholders found
  let primaryOwner = null;
  if (shareholders.length > 0) {
    primaryOwner = shareholders.sort((a, b) => b.ownership - a.ownership)[0];
    // Try to enrich with birthYear from board members if names match
    const boardMatch = boardMembers.find(b => b.lastName === primaryOwner.lastName);
    if (boardMatch?.birthYear) primaryOwner.birthYear = boardMatch.birthYear;
  } else if (boardMembers.length > 0) {
    const chair = boardMembers.find(b => b.role === 'Styrelseordförande' || b.role === 'Ordförande') || boardMembers[0];
    primaryOwner = { ...chair, ownership: null };
  }

  return {
    orgNr,
    county,
    boardMembers: boardMembers.slice(0, 10),
    shareholders: shareholders.slice(0, 5),
    primaryOwner,
    fetchedAt: new Date().toISOString(),
  };
}
