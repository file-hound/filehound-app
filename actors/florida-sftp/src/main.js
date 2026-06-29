/**
 * FileHound — Florida SFTP Actor
 *
 * Downloads the daily corporate filing file from the Florida Division of
 * Corporations public SFTP server, parses the fixed-width format, normalises
 * records to the FileHound schema, and upserts to Supabase.
 *
 * Data source:  sftp.floridados.gov (public — no account needed)
 * Credentials:  Username: Public | Password: PubAccess1845!
 * File path:    doc/cor/YYYYMMDDc.txt
 * File format:  Fixed-width ASCII, 1440 chars per record
 *
 * Field positions verified against official definitions:
 * https://dos.sunbiz.org/data-definitions/cor.html
 * All positions below are 0-based (official docs use 1-based — subtract 1).
 */

import { Actor } from 'apify';
import SftpClient from 'ssh2-sftp-client';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// Fix for Node.js < 22 which lacks native WebSocket support
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = ws;
}

// ─── SFTP connection details ──────────────────────────────────────────────────
const SFTP_HOST = 'sftp.floridados.gov';
const SFTP_USER = 'Public';
const SFTP_PASS = 'PubAccess1845!';
const SFTP_PORT = 22;

const RECORD_LENGTH = 1440;
const SOURCE_STATE  = 'FL';

// ─── Field specification ──────────────────────────────────────────────────────
//
// Verified against: https://dos.sunbiz.org/data-definitions/cor.html
// Format: [startIndex_0based, length]
// Official docs are 1-based — each start here = official start minus 1.
//
const FIELD_SPEC = {
  // Field 1  — Corporation Number (doc number / entity ID)
  document_number:         [0,    12],

  // Field 2  — Corporation Name (192 chars)
  entity_name:             [12,  192],

  // Field 3  — Status: A=Active, I=Inactive
  status_code:             [204,   1],

  // Field 4  — Filing Type: FLAL, DOMP, FORP, DOMLP, etc.
  filing_type:             [205,  15],

  // Fields 5–10 — Principal address
  principal_addr1:         [220,  42],
  principal_addr2:         [262,  42],
  principal_city:          [304,  28],
  principal_state:         [332,   2],
  principal_zip:           [334,  10],
  principal_country:       [344,   2],

  // Fields 11–16 — Mailing address
  mailing_addr1:           [346,  42],
  mailing_addr2:           [388,  42],
  mailing_city:            [430,  28],
  mailing_state:           [458,   2],
  mailing_zip:             [460,  10],
  mailing_country:         [470,   2],

  // Field 17 — File date of the formation filing (MMDDYYYY)
  filing_date:             [472,   8],

  // Field 18 — FEI / EIN
  fei_number:              [480,  14],

  // Field 19 — More than 6 officers flag
  more_than_six_officers:  [494,   1],

  // Field 20 — Last transaction date (MMDDYYYY)
  last_transaction_date:   [495,   8],

  // Field 21 — State/Country of formation
  state_country:           [503,   2],

  // Fields 22–30 — Annual report years and dates (3 most recent)
  report_year_1:           [505,   4],
  report_date_1:           [510,   8],
  report_year_2:           [518,   4],
  report_date_2:           [523,   8],
  report_year_3:           [531,   4],
  report_date_3:           [536,   8],

  // Fields 31–36 — Registered Agent
  ra_name:                 [544,  42],
  ra_type:                 [586,   1],   // P=Person, C=Corporation
  ra_addr1:                [587,  42],
  ra_city:                 [629,  28],
  ra_state:                [657,   2],
  ra_zip:                  [659,   9],

  // Fields 37–43 — Officer 1
  officer_1_title:         [668,   4],
  officer_1_type:          [672,   1],
  officer_1_name:          [673,  42],
  officer_1_addr:          [715,  42],
  officer_1_city:          [757,  28],
  officer_1_state:         [785,   2],
  officer_1_zip:           [787,   9],

  // Fields 44–50 — Officer 2
  officer_2_title:         [796,   4],
  officer_2_type:          [800,   1],
  officer_2_name:          [801,  42],
  officer_2_addr:          [843,  42],
  officer_2_city:          [885,  28],
  officer_2_state:         [913,   2],
  officer_2_zip:           [915,   9],

  // Fields 51–57 — Officer 3
  officer_3_title:         [924,   4],
  officer_3_type:          [928,   1],
  officer_3_name:          [929,  42],
  officer_3_addr:          [971,  42],
  officer_3_city:          [1013, 28],
  officer_3_state:         [1041,  2],
  officer_3_zip:           [1043,  9],

  // Fields 58–64 — Officer 4
  officer_4_title:         [1052,  4],
  officer_4_type:          [1056,  1],
  officer_4_name:          [1057, 42],
  officer_4_addr:          [1099, 42],
  officer_4_city:          [1141, 28],
  officer_4_state:         [1169,  2],
  officer_4_zip:           [1171,  9],

  // Fields 65–71 — Officer 5
  officer_5_title:         [1180,  4],
  officer_5_type:          [1184,  1],
  officer_5_name:          [1185, 42],
  officer_5_addr:          [1227, 42],
  officer_5_city:          [1269, 28],
  officer_5_state:         [1297,  2],
  officer_5_zip:           [1299,  9],

  // Fields 72–78 — Officer 6
  officer_6_title:         [1308,  4],
  officer_6_type:          [1312,  1],
  officer_6_name:          [1313, 42],
  officer_6_addr:          [1355, 42],
  officer_6_city:          [1397, 28],
  officer_6_state:         [1425,  2],
  officer_6_zip:           [1427,  9],

  // Field 79 — Filler
  // filler:               [1436,  4],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function field(record, name) {
  const [start, len] = FIELD_SPEC[name];
  return record.substring(start, start + len).trim();
}

/**
 * Florida dates in this file are MMDDYYYY (not YYYYMMDD).
 * Convert to ISO YYYY-MM-DD or return null if empty/invalid.
 */
function parseDate(mmddyyyy) {
  if (!mmddyyyy || mmddyyyy.trim() === '' || mmddyyyy === '00000000') return null;
  const s = mmddyyyy.trim();
  if (s.length !== 8 || !/^\d{8}$/.test(s)) return null;
  // MMDDYYYY → YYYY-MM-DD
  return `${s.slice(4, 8)}-${s.slice(0, 2)}-${s.slice(2, 4)}`;
}

function parseStatus(code) {
  const map = { A: 'Active', I: 'Inactive' };
  return map[code?.trim()] ?? code?.trim() ?? 'Unknown';
}

/**
 * Map Florida filing type codes to human-readable entity types.
 * These come from field 4 (Filing Type) in the official spec.
 */
function parseEntityType(filingType) {
  const map = {
    'FLAL':  'LLC',
    'FORL':  'Foreign LLC',
    'DOMP':  'Corporation',
    'FORP':  'Foreign Corporation',
    'DOMNP': 'Non-Profit Corporation',
    'FORNP': 'Foreign Non-Profit Corporation',
    'DOMLP': 'Limited Partnership',
    'FORLP': 'Foreign Limited Partnership',
    'NPREG': 'Non-Profit Registration',
    'TRUST': 'Declaration of Trust',
    'AGENT': 'Registered Agent Designation',
  };
  const key = filingType?.trim();
  return map[key] ?? key ?? 'Other';
}

function parseOfficers(record) {
  const officers = [];
  for (let i = 1; i <= 6; i++) {
    const name  = field(record, `officer_${i}_name`);
    const title = field(record, `officer_${i}_title`);
    if (!name) break;
    officers.push({
      name,
      title,
      address: field(record, `officer_${i}_addr`),
      city:    field(record, `officer_${i}_city`),
      state:   field(record, `officer_${i}_state`),
      zip:     field(record, `officer_${i}_zip`),
    });
  }
  return officers;
}

function normalise(record) {
  // Strip any trailing \r from Windows line endings
  const r = record.replace(/\r$/, '');
  if (r.length < RECORD_LENGTH) return null;

  const docNum     = field(r, 'document_number');
  const entityName = field(r, 'entity_name');
  const filedDate  = parseDate(field(r, 'filing_date'));

  if (!docNum || !entityName || !filedDate) return null;

  return {
    business_name:         entityName,
    entity_type:           parseEntityType(field(r, 'filing_type')),
    filing_date:           filedDate,
    street_address:        field(r, 'principal_addr1'),
    city:                  field(r, 'principal_city'),
    state:                 SOURCE_STATE,
    zip:                   field(r, 'principal_zip'),
    source_state:          SOURCE_STATE,
    state_filing_id:       docNum,
    state_of_formation:    field(r, 'state_country') || SOURCE_STATE,
    registered_agent_name: field(r, 'ra_name'),
    raw_data: {
      status:                parseStatus(field(r, 'status_code')),
      filing_type:           field(r, 'filing_type').trim(),
      fei_number:            field(r, 'fei_number'),
      last_transaction_date: parseDate(field(r, 'last_transaction_date')),
      more_than_six_officers: field(r, 'more_than_six_officers') === 'Y',
      principal_addr2:       field(r, 'principal_addr2'),
      mailing_address:       [
        field(r, 'mailing_addr1'),
        field(r, 'mailing_addr2'),
        field(r, 'mailing_city'),
        field(r, 'mailing_state'),
        field(r, 'mailing_zip'),
      ].filter(Boolean).join(', '),
      ra_type:    field(r, 'ra_type'),
      ra_address: [
        field(r, 'ra_addr1'),
        field(r, 'ra_city'),
        field(r, 'ra_state'),
        field(r, 'ra_zip'),
      ].filter(Boolean).join(', '),
      annual_reports: [
        { year: field(r, 'report_year_1'), date: parseDate(field(r, 'report_date_1')) },
        { year: field(r, 'report_year_2'), date: parseDate(field(r, 'report_date_2')) },
        { year: field(r, 'report_year_3'), date: parseDate(field(r, 'report_date_3')) },
      ].filter(ar => ar.year),
      officers: parseOfficers(r),
    },
  };
}

/** Build the SFTP remote file path — no leading slash. */
function buildSftpPath(date) {
  const d = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `doc/cor/${d}c.txt`;
}

/** Return today's date as YYYY-MM-DD in US Eastern time. */
function todayEastern() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Main ──────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
  targetDate = todayEastern(),
  supabaseUrl,
  supabaseServiceKey,
  calibrationMode = false,
  dryRun = false,
} = input;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('supabaseUrl and supabaseServiceKey are required inputs.');
}

const runDate  = new Date(targetDate + 'T00:00:00');
const sftp     = new SftpClient();
const supabase = createClient(supabaseUrl, supabaseServiceKey);

let status          = 'success';
let recordsFound    = 0;
let recordsInserted = 0;
let errorMessage    = null;
const startMs       = Date.now();

try {
  // ── 1. Connect to SFTP ──────────────────────────────────────────────────────
  console.log(`Connecting to ${SFTP_HOST}...`);
  await sftp.connect({
    host: SFTP_HOST, port: SFTP_PORT, username: SFTP_USER, password: SFTP_PASS,
  });

  // ── 2. Download the daily file ──────────────────────────────────────────────
  const remotePath = buildSftpPath(runDate);
  console.log(`Downloading ${remotePath}...`);

  let fileBuffer;
  try {
    fileBuffer = await sftp.get(remotePath);
  } catch (err) {
    if (err.message?.includes('No such file') || err.code === 2) {
      console.log(`No file for ${targetDate} (weekend or holiday). Exiting cleanly.`);
      await sftp.end();
      await logScrapeRun({ supabase, status: 'success', recordsFound: 0, recordsInserted: 0, errorMessage: 'No file (weekend/holiday)', durationMs: Date.now() - startMs });
      await Actor.exit();
    }
    throw err;
  }

  await sftp.end();

  const fileContent = fileBuffer.toString('latin1');
  const lines       = fileContent.split('\n').filter(l => l.length > 0);
  console.log(`Downloaded ${lines.length} records.`);
  recordsFound = lines.length;

  // ── 3. Calibration mode ─────────────────────────────────────────────────────
  if (calibrationMode) {
    console.log('--- CALIBRATION MODE (field positions verified against official docs) ---');
    const sample = lines.slice(0, 5);
    for (const [i, line] of sample.entries()) {
      const r = line.replace(/\r$/, '');
      console.log(`\n--- Record ${i + 1} (${r.length} chars) ---`);
      console.log(`document_number: "${field(r, 'document_number')}"`);
      console.log(`entity_name:     "${field(r, 'entity_name')}"`);
      console.log(`status_code:     "${field(r, 'status_code')}"`);
      console.log(`filing_type:     "${field(r, 'filing_type')}"`);
      console.log(`filing_date:     "${field(r, 'filing_date')}" → ${parseDate(field(r, 'filing_date'))}`);
      console.log(`principal_addr1: "${field(r, 'principal_addr1')}"`);
      console.log(`principal_city:  "${field(r, 'principal_city')}"`);
      console.log(`principal_state: "${field(r, 'principal_state')}"`);
      console.log(`principal_zip:   "${field(r, 'principal_zip')}"`);
      console.log(`ra_name:         "${field(r, 'ra_name')}"`);
      console.log(`officer_1_name:  "${field(r, 'officer_1_name')}"`);
      console.log(`officer_1_title: "${field(r, 'officer_1_title')}"`);
    }
    await Actor.pushData(sample.map((raw, i) => {
      const r = raw.replace(/\r$/, '');
      return {
        record_index: i + 1,
        raw_length: r.length,
        parsed: normalise(r),
      };
    }));
    await Actor.exit();
  }

  // ── 4. Parse and normalise ──────────────────────────────────────────────────
  const normalised = [];
  for (const line of lines) {
    const record = normalise(line);
    if (record) normalised.push(record);
  }
  console.log(`Parsed ${normalised.length} valid records from ${lines.length} raw lines.`);

  if (dryRun) {
    console.log('Dry run — skipping Supabase upsert.');
    await Actor.pushData(normalised.slice(0, 20));
    await Actor.exit();
  }

  // ── 5. Upsert to Supabase ───────────────────────────────────────────────────
  const BATCH_SIZE = 500;
  for (let i = 0; i < normalised.length; i += BATCH_SIZE) {
    const batch = normalised.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('filings')
      .upsert(batch, { onConflict: 'source_state,state_filing_id', ignoreDuplicates: false });
    if (error) {
      console.error(`Batch ${i} upsert error:`, error.message);
      status = 'partial';
      errorMessage = error.message;
    } else {
      recordsInserted += batch.length;
    }
    if (i + BATCH_SIZE < normalised.length) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Upserted ${recordsInserted} records to Supabase.`);

} catch (err) {
  console.error('Actor error:', err.message);
  status = 'failed';
  errorMessage = err.message;
  try { await sftp.end(); } catch {}
}

// ── 6. Log to scrape_runs ────────────────────────────────────────────────────
await logScrapeRun({ supabase, status, recordsFound, recordsInserted, errorMessage, durationMs: Date.now() - startMs });

if (status === 'failed') throw new Error(`Actor failed: ${errorMessage}`);

await Actor.exit();

// ─── Scrape run logger ────────────────────────────────────────────────────────

async function logScrapeRun({ supabase, status, recordsFound, recordsInserted, errorMessage, durationMs }) {
  try {
    const { error } = await supabase.from('scrape_runs').insert({
      state: SOURCE_STATE, status,
      records_found: recordsFound, records_inserted: recordsInserted,
      error_message: errorMessage, duration_ms: durationMs,
    });
    if (error) console.error('Failed to log scrape_run:', error.message);
  } catch (err) {
    console.error('Failed to log scrape_run:', err.message);
  }
}
