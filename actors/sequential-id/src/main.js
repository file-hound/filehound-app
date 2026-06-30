/**
 * FileHound — Sequential Entity ID Sweep Actor
 *
 * For states with NO date-range search but sequential entity IDs
 * (Alabama, Arizona, Georgia, Virginia, possibly Idaho).
 *
 * Strategy: instead of asking "what filed today," we track a CURSOR — the
 * highest entity ID already collected for this state — and walk forward
 * fetching each entity's detail page by ID. We stop once we hit a run of
 * consecutive "not found" responses, meaning we've caught up to IDs that
 * haven't been issued yet.
 *
 * The cursor is derived automatically from existing Supabase data (the most
 * recently inserted record for this state), so no separate tracking table
 * is needed. On the very first run for a new state, `startId` is used.
 *
 * Each state needs its own CSS selectors and URL template — these are NOT
 * hardcoded, they come entirely from Apify input. Run with calibrationMode:
 * true first to see the actual page structure before trusting any selectors.
 */

import { Actor } from 'apify';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import ws from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws;
}

/** Build the detail-page URL for a given numeric ID, applying zero-padding if configured. */
function buildUrl(template, id, padLength) {
  const idStr = padLength > 0 ? String(id).padStart(padLength, '0') : String(id);
  return template.replace('{ID}', idStr);
}

/**
 * Some states (Alabama) return the full address as one combined field like
 * "4832 Keith Drive\nBirmingham, AL 35242-3239" (line break between street
 * and city/state/zip). Splits it into parts.
 */
function splitCombinedAddress(combined) {
  if (!combined) return { street: '', city: '', state: '', zip: '' };
  const parts = combined.split('\n').map(s => s.trim()).filter(Boolean);
  const street = parts[0] || '';
  const cityStateZip = parts[1] || '';
  // "Birmingham, AL 35242-3239"
  const match = cityStateZip.match(/^(.*),\s*([A-Z]{2})\s+(\d{5}(-\d{4})?)$/);
  if (match) {
    return { street, city: match[1].trim(), state: match[2], zip: match[3] };
  }
  return { street, city: cityStateZip, state: '', zip: '' };
}

/** Extract text from the page using a CSS selector, trimmed. Returns '' if not found. */
function extract($, selector) {
  if (!selector) return '';
  const el = $(selector).first();
  return el.length ? el.text().trim() : '';
}

/**
 * Extract a value from a label/value table structure — common on older
 * government sites (e.g. Alabama) where every row looks like:
 *   <td class="...Desc">Some Label</td><td class="...Value">The Value</td>
 * Matches the label cell by its text (case-insensitive, partial match),
 * then returns the trimmed text of the next sibling cell.
 */
function extractByLabel($, labelSelector, valueSelector, labelText) {
  if (!labelSelector || !labelText) return '';
  let result = '';
  $(labelSelector).each((i, el) => {
    const cellText = $(el).text().trim().toLowerCase();
    if (cellText.includes(labelText.toLowerCase())) {
      const valueCell = valueSelector
        ? $(el).nextAll(valueSelector).first()
        : $(el).next();
      // Convert <br> to newline before extracting text, since cheerio's
      // .text() otherwise concatenates lines with no separator at all.
      valueCell.find('br').replaceWith('\n');
      result = valueCell.text().split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
      return false; // stop iterating, found it
    }
  });
  return result;
}

/** Check whether the page indicates the entity ID doesn't exist. */
function isNotFound(html, notFoundIndicatorText) {
  if (!notFoundIndicatorText) return false;
  return html.toLowerCase().includes(notFoundIndicatorText.toLowerCase());
}

/** Parse a single entity detail page into the FileHound schema using configured selectors. */
function parseEntityPage(html, id, sourceState, selectors) {
  const $ = cheerio.load(html);

  // Label-based mode (e.g. Alabama's label/value table structure)
  const useLabelMode = selectors.mode === 'label';

  function field(key, labelText) {
    if (useLabelMode) {
      return extractByLabel($, selectors.labelCellSelector, selectors.valueCellSelector, labelText);
    }
    return extract($, selectors[key]);
  }

  const businessName = useLabelMode
    ? extract($, selectors.businessNameSelector) // title/header is usually its own selector even in label mode
    : extract($, selectors.businessName);

  if (!businessName) return null; // treat as unparseable / not a real entity record

  // Address may come back as one combined field with a line break
  // (street on one line, "City, ST ZIP" on the next) — split it apart.
  const rawAddress = field('streetAddress', selectors.labels?.streetAddress);
  const addressParts = useLabelMode ? splitCombinedAddress(rawAddress) : null;

  return {
    business_name:         businessName,
    entity_type:           field('entityType', selectors.labels?.entityType) || 'Other',
    filing_date:           parseLooseDate(field('filingDate', selectors.labels?.filingDate)),
    street_address:        useLabelMode ? addressParts.street : field('streetAddress', selectors.labels?.streetAddress),
    city:                  useLabelMode ? addressParts.city   : field('city', selectors.labels?.city),
    state:                 sourceState,
    zip:                   useLabelMode ? addressParts.zip    : field('zip', selectors.labels?.zip),
    county:                '',
    source_state:          sourceState,
    state_filing_id:       String(id),
    state_of_formation:    sourceState,
    registered_agent_name: field('registeredAgent', selectors.labels?.registeredAgent),
    raw_data: {
      status: field('status', selectors.labels?.status),
      raw_html_length: html.length,
    },
  };
}

/** Best-effort date parser for whatever format a state's portal uses. */
function parseLooseDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // MM/DD/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;

  // YYYY-MM-DD already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // Month DD, YYYY (e.g. "June 26, 2026")
  const parsed = Date.parse(s);
  if (!isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);

  return null;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  sourceState,
  idUrlTemplate,
  idPadLength             = 0,
  startId,
  sweepCount              = 200,
  consecutiveMissesToStop = 30,
  requestDelayMs          = 300,
  notFoundIndicatorText   = '',
  selectors               = {},
  supabaseUrl,
  supabaseServiceKey,
  calibrationMode         = false,
  dryRun                  = false,
} = input;

if (!sourceState || !idUrlTemplate || !supabaseUrl || !supabaseServiceKey) {
  throw new Error('sourceState, idUrlTemplate, supabaseUrl, and supabaseServiceKey are required inputs.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

let status          = 'success';
let recordsFound    = 0;
let recordsInserted = 0;
let errorMessage    = null;
const startMs       = Date.now();

try {
  // ── 1. Determine starting cursor ────────────────────────────────────────────
  console.log(`Determining starting ID for ${sourceState}...`);

  const { data: lastRecord, error: cursorError } = await supabase
    .from('filings')
    .select('state_filing_id')
    .eq('source_state', sourceState)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cursorError) console.warn('Cursor lookup warning:', cursorError.message);

  let currentId;
  if (lastRecord?.state_filing_id && /^\d+$/.test(lastRecord.state_filing_id)) {
    currentId = parseInt(lastRecord.state_filing_id, 10) + 1;
    console.log(`Resuming from cursor: ${currentId} (last known ID was ${lastRecord.state_filing_id})`);
  } else if (startId) {
    currentId = startId;
    console.log(`No prior records found — starting from configured startId: ${currentId}`);
  } else {
    throw new Error('No prior records exist for this state and no startId was provided. Set startId for the first run.');
  }

  // ── 2. Sweep forward ─────────────────────────────────────────────────────────
  const normalised      = [];
  const calibrationDump = [];
  let consecutiveMisses = 0;
  let idsChecked         = 0;

  for (let id = currentId; idsChecked < sweepCount; id++, idsChecked++) {
    const url = buildUrl(idUrlTemplate, id, idPadLength);

    let html;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FileHoundBot/1.0)' },
      });
      html = await response.text();
    } catch (err) {
      console.warn(`Fetch error for ID ${id}: ${err.message}`);
      consecutiveMisses++;
      if (consecutiveMisses >= consecutiveMissesToStop) {
        console.log(`${consecutiveMisses} consecutive fetch errors — stopping sweep.`);
        break;
      }
      continue;
    }

    if (calibrationMode && calibrationDump.length < 5) {
      calibrationDump.push({
        id,
        url,
        html_length: html.length,
        html_snippet: html.slice(0, 3000),
        parsed: parseEntityPage(html, id, sourceState, selectors),
      });
    }

    if (isNotFound(html, notFoundIndicatorText)) {
      consecutiveMisses++;
      if (consecutiveMisses >= consecutiveMissesToStop) {
        console.log(`${consecutiveMisses} consecutive misses at ID ${id} — assuming we've caught up. Stopping sweep.`);
        break;
      }
    } else {
      consecutiveMisses = 0;
      const record = parseEntityPage(html, id, sourceState, selectors);
      if (record) {
        normalised.push(record);
        recordsFound++;
      }
    }

    if (requestDelayMs > 0) await new Promise(r => setTimeout(r, requestDelayMs));
  }

  console.log(`Swept ${idsChecked} IDs starting from ${currentId}. Found ${recordsFound} valid entities.`);

  // ── 3. Calibration mode — dump and exit ─────────────────────────────────────
  if (calibrationMode) {
    console.log('\n--- CALIBRATION MODE ---');
    console.log(`Dumping first ${calibrationDump.length} ID attempts (raw HTML truncated to 3000 chars each).`);
    for (const item of calibrationDump) {
      console.log(`\nID ${item.id} (${item.url})`);
      console.log(`HTML length: ${item.html_length}`);
      console.log(`Parsed:`, JSON.stringify(item.parsed, null, 2));
    }
    await Actor.pushData(calibrationDump);
    await Actor.exit();
  }

  if (dryRun) {
    console.log('Dry run — skipping Supabase upsert.');
    await Actor.pushData(normalised.slice(0, 20));
    await Actor.exit();
  }

  // ── 4. Upsert to Supabase ───────────────────────────────────────────────────
  if (normalised.length > 0) {
    const { error } = await supabase
      .from('filings')
      .upsert(normalised, { onConflict: 'source_state,state_filing_id', ignoreDuplicates: false });
    if (error) {
      console.error('Upsert error:', error.message);
      status = 'partial';
      errorMessage = error.message;
    } else {
      recordsInserted = normalised.length;
    }
  }
  console.log(`Upserted ${recordsInserted} records to Supabase.`);

} catch (err) {
  console.error('Actor error:', err.message);
  status = 'failed';
  errorMessage = err.message;
}

await logScrapeRun({ supabase, sourceState, status, recordsFound, recordsInserted, errorMessage, durationMs: Date.now() - startMs });

if (status === 'failed') throw new Error(`Actor failed: ${errorMessage}`);

await Actor.exit();

async function logScrapeRun({ supabase, sourceState, status, recordsFound, recordsInserted, errorMessage, durationMs }) {
  try {
    const { error } = await supabase.from('scrape_runs').insert({
      state:            sourceState,
      status,
      records_found:    recordsFound,
      records_inserted: recordsInserted,
      error_message:    errorMessage,
      duration_ms:      durationMs,
    });
    if (error) console.error('Failed to log scrape_run:', error.message);
  } catch (err) {
    console.error('Failed to log scrape_run:', err.message);
  }
}
