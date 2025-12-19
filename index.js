// index.js (AUD.VC - full code with SAFE IP throttling + metadata + async XLSX jobs)
// - Default short domain: https://aud.vc (used if no domains provided)
// - Domains override: Header "X-Short-Domains" (comma-separated) OR query ?domains=...
// - Upload XLSX async: POST /upload-file -> {jobId}, poll GET /jobs/:jobId, download GET /download/:jobId
// - Firestore batch writes (500 max per batch)
// - Redirect: immediate 302, then async metadata update (device/os/browser/ip/referer/UA)
// - IP protection: DO NOT block on first 404. Throttle: N not-found within window => temporary block.
// - No /unblock-ip route (as requested)

const admin = require('firebase-admin');
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const readXlsxFile = require('read-excel-file/node');
const xl = require('excel4node');
const { customAlphabet } = require('nanoid');
const express = require('express');
const UAParser = require('ua-parser-js');

const app = express();
const port = process.env.PORT || 8002;

// ----------------------------- FIREBASE -----------------------------
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : null,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: "googleapis.com",
};

if (!serviceAccount.private_key) {
  console.error('❌ FIREBASE_PRIVATE_KEY is not defined. Check your .env file.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ----------------------------- APP CONFIG -----------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(fileUpload({
  createParentPath: true,
  limits: { fileSize: 512 * 1024 * 1024 }, // 512MB
}));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet(alphabet, 5);

// ----------------------------- JOB STATUS STORE -----------------------------
const jobs = {}; // { [jobId]: { status: 'processing'|'done'|'error', filePath?: string, message?: string } }

// ----------------------------- DOMAINS HELPERS -----------------------------
function normalizeDomains(raw) {
  if (!raw) return null;
  const arr = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s.startsWith('http://') || s.startsWith('https://')) ? s : `https://${s}`);
  return arr.length ? arr : null;
}

function parseDomainsFromHeader(req) {
  return normalizeDomains(req.header('X-Short-Domains'));
}

function parseDomainsFromQuery(req) {
  return normalizeDomains(req.query.domains || req.query.domain || req.query.short_domains);
}

// ✅ Default if nothing provided: https://aud.vc
function getShortDomains(req) {
  return parseDomainsFromHeader(req) || parseDomainsFromQuery(req) || ['https://aud.vc'];
}

function getRandomDomain(domains) {
  const safe = (domains && domains.length) ? domains : ['https://aud.vc'];
  return safe[Math.floor(Math.random() * safe.length)];
}

// ----------------------------- IP HELPERS -----------------------------
function nowMs() { return Date.now(); }

function getClientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString();
  const ip = raw.split(',')[0].trim();
  return ip.replace(/:\d+$/, ''); // remove port if present
}

// ----------------------------- IP THROTTLE CONFIG -----------------------------
const IP_FAIL_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes
const IP_FAIL_THRESHOLD = 10;              // 10 "not found" in the window
const IP_BLOCK_MS = 60 * 60 * 1000;        // 1 hour block

function ipDocRef(ip) {
  return db.collection('blockedIps').doc(ip);
}

async function isIpBlocked(ip) {
  const doc = await ipDocRef(ip).get();
  if (!doc.exists) return false;

  const data = doc.data() || {};
  if (!data.blocked) return false;

  const blockedUntil = data.blockedUntil?.toMillis?.() ?? 0;
  if (blockedUntil && blockedUntil <= nowMs()) return false; // expired

  return true;
}

/**
 * Record a short-not-found for IP and block only if threshold reached within window.
 * Returns: { blockedNow: boolean, remaining: number, failCount: number }
 */
async function recordNotFound(ip) {
  const ref = ipDocRef(ip);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = nowMs();

    const existing = snap.exists ? (snap.data() || {}) : {};

    // If already blocked and still active -> keep blocked
    const existingBlockedUntil = existing.blockedUntil?.toMillis?.() ?? 0;
    if (existing.blocked && existingBlockedUntil && existingBlockedUntil > n) {
      return {
        blockedNow: true,
        remaining: existingBlockedUntil - n,
        failCount: existing.failCount || 0
      };
    }

    const firstFailAtMs = existing.firstFailAt?.toMillis?.() ?? 0;
    let failCount = existing.failCount || 0;

    // Reset window if expired or not set
    let firstFailAt = existing.firstFailAt;
    if (!firstFailAtMs || (n - firstFailAtMs) > IP_FAIL_WINDOW_MS) {
      failCount = 0;
      firstFailAt = admin.firestore.Timestamp.fromMillis(n);
    }

    failCount += 1;

    const updates = {
      ip,
      failCount,
      firstFailAt,
      lastFailAt: admin.firestore.Timestamp.fromMillis(n),
      blocked: false,
      reason: 'not_found_throttle',
      blockedAt: admin.firestore.FieldValue.delete(),
      blockedUntil: admin.firestore.FieldValue.delete(),
    };

    if (failCount >= IP_FAIL_THRESHOLD) {
      updates.blocked = true;
      updates.blockedAt = admin.firestore.Timestamp.fromMillis(n);
      updates.blockedUntil = admin.firestore.Timestamp.fromMillis(n + IP_BLOCK_MS);
    }

    tx.set(ref, updates, { merge: true });

    return {
      blockedNow: !!updates.blocked,
      remaining: updates.blocked ? IP_BLOCK_MS : 0,
      failCount
    };
  });

  return result;
}

// ----------------------------- IP BLOCK MIDDLEWARE -----------------------------
app.use(async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    if (await isIpBlocked(ip)) {
      return res.status(403).send('Your IP has been temporarily blocked due to suspicious activity.');
    }
    next();
  } catch (e) {
    console.error('IP middleware error:', e.message);
    next();
  }
});

// ----------------------------- HOME -----------------------------
app.get('/', (req, res) => {
  res.send('AUD.VC shortener is running ✅');
});

// ----------------------------- JOB STATUS -----------------------------
app.get('/jobs/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ status: 'not_found' });
  res.json(job);
});

// ----------------------------- DOWNLOAD -----------------------------
app.get('/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done' || !job.filePath) {
    return res.status(404).send('File not ready or not found');
  }
  res.download(job.filePath);
});

// ----------------------------- STATS PAR CAMPAGNE -----------------------------
app.get('/campaign/:campaignId/stats', async (req, res) => {
  const { campaignId } = req.params;

  try {
    const snapshot = await db.collection('urls').where('campaign', '==', campaignId).get();

    let totalClicks = 0;
    let totalMobileClicks = 0;

    snapshot.forEach(doc => {
      const data = doc.data();
      totalClicks += data.clicks || 0;
      totalMobileClicks += data.mobileClicks || 0;
    });

    res.json({
      campaign: campaignId,
      totalUrls: snapshot.size,
      totalClicks,
      mobileClicks: totalMobileClicks
    });
  } catch (err) {
    console.error('Error fetching campaign stats:', err.message);
    res.status(500).send('Internal Server Error');
  }
});

// ----------------------------- STATS GLOBALES -----------------------------
app.get('/stats/global', async (req, res) => {
  try {
    const snapshot = await db.collection('urls').get();

    let totalClicks = 0;
    let totalMobileClicks = 0;
    const campaignStats = {};
    const domainStats = {};
    const deviceStats = {};

    snapshot.forEach(doc => {
      const d = doc.data() || {};
      totalClicks += d.clicks || 0;
      totalMobileClicks += d.mobileClicks || 0;

      const campaign = d.campaign || 'unknown';
      if (!campaignStats[campaign]) campaignStats[campaign] = { count: 0, clicks: 0, mobileClicks: 0 };
      campaignStats[campaign].count += 1;
      campaignStats[campaign].clicks += d.clicks || 0;
      campaignStats[campaign].mobileClicks += d.mobileClicks || 0;

      const domain = d.domain || 'unknown';
      if (!domainStats[domain]) domainStats[domain] = { count: 0, clicks: 0, mobileClicks: 0 };
      domainStats[domain].count += 1;
      domainStats[domain].clicks += d.clicks || 0;
      domainStats[domain].mobileClicks += d.mobileClicks || 0;

      const device = d.deviceType || 'unknown';
      if (!deviceStats[device]) deviceStats[device] = { count: 0, clicks: 0 };
      deviceStats[device].count += 1;
      deviceStats[device].clicks += d.clicks || 0;
    });

    res.json({
      totalUrls: snapshot.size,
      totalClicks,
      mobileClicks: totalMobileClicks,
      campaigns: campaignStats,
      domains: domainStats,
      devices: deviceStats
    });
  } catch (e) {
    console.error('Global stats error:', e.message);
    res.status(500).send('Internal Server Error');
  }
});

// ----------------------------- UPLOAD FILE (ASYNC) -----------------------------
app.post('/upload-file', async (req, res) => {
  try {
    if (!req.files || !req.files.xlsxFile) {
      return res.status(400).json({ error: 'No file uploaded (xlsxFile)' });
    }

    const xlsxFile = req.files.xlsxFile;
    const uploadPath = path.join(uploadsDir, xlsxFile.name);
    await xlsxFile.mv(uploadPath);

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    jobs[jobId] = { status: 'processing', filePath: null };

    // ✅ Immediate response
    res.status(202).json({ status: 'received', jobId });

    // 🚀 async processing
    const domains = getShortDomains(req); // default ['https://aud.vc']
    processFileAsync(uploadPath, jobId, domains);

  } catch (e) {
    console.error('Upload error:', e.message);
    res.status(500).send('Internal Server Error');
  }
});

async function processFileAsync(uploadPath, jobId, shortUrlDomains) {
  console.log(`🚀 Job ${jobId} started: ${uploadPath}`);

  const wb = new xl.Workbook();
  const ws = wb.addWorksheet('FileSheet');

  try {
    const rows = await readXlsxFile(uploadPath);
    if (!rows || rows.length === 0) {
      jobs[jobId] = { status: 'error', message: 'Empty file' };
      return;
    }

    // Columns compatible with your old aud.vc app
    const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'code', 'code_postal', 'utm', 'ville'];

    // remove header row
    rows.shift();

    const formattedRows = [];

    let batch = db.batch();
    let batchCount = 0;
    let totalWritten = 0;

    for (const row of rows) {
      const url = row[4];
      const campaignId = row[8];
      const phone = row[3];
      const newRow = [...row];

      if (url && String(url).startsWith('http')) {
        const id = nanoid();
        const selectedDomain = getRandomDomain(shortUrlDomains);
        const domainOnly = selectedDomain.replace(/^https?:\/\//, '');

        const docRef = db.collection('urls').doc(id);

        batch.set(docRef, {
          id,
          url,
          short: `${selectedDomain}/${id}`,
          domain: domainOnly,
          phone: phone || '',
          campaign: campaignId || '',
          clicks: 0,
          mobileClicks: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        batchCount++;
        totalWritten++;

        if (batchCount >= 500) {
          await batch.commit();
          console.log(`✅ Batch committed (500). Total docs: ${totalWritten}`);
          batch = db.batch();
          batchCount = 0;
        }

        // replace destination cell with short
        newRow[4] = `${selectedDomain}/${id}`;
      }

      const obj = cols.reduce((acc, col, i) => {
        acc[col] = newRow[i] || '';
        return acc;
      }, {});
      formattedRows.push(obj);
    }

    if (batchCount > 0) {
      await batch.commit();
      console.log(`✅ Final batch committed (${batchCount}). Total docs: ${totalWritten}`);
    }

    // write output XLSX
    cols.forEach((h, i) => ws.cell(1, i + 1).string(h));
    formattedRows.forEach((rec, r) => {
      Object.values(rec).forEach((v, c) => ws.cell(r + 2, c + 1).string(String(v ?? '')));
    });

    const parsedPath = path.join(uploadsDir, `parsed_${path.basename(uploadPath)}`);

    wb.write(parsedPath, (err) => {
      if (err) {
        jobs[jobId] = { status: 'error', message: err.message };
        console.error('XLSX write error:', err.message);
      } else {
        jobs[jobId] = { status: 'done', filePath: parsedPath };
        console.log(`✅ Job ${jobId} done: ${parsedPath}`);
      }
    });

  } catch (e) {
    console.error(`❌ Job ${jobId} error:`, e.message);
    jobs[jobId] = { status: 'error', message: e.message };
  }
}

// ----------------------------- REDIRECTION + METADATA (CATCH-ALL) -----------------------------
// IMPORTANT: keep this at the very bottom after all API routes
app.get('*', async (req, res) => {
  const pathPart = req.path.replace(/^\/+/, '').trim();
  const id = pathPart.split('/')[0];
  if (!id || id.length < 3) return res.status(404).send('Invalid short link');

  const ip = getClientIp(req);

  try {
    const docRef = db.collection('urls').doc(id);
    const doc = await docRef.get();

    // ✅ NEW: do NOT block immediately on first miss.
    // Record not-found; block only if threshold reached in window.
    if (!doc.exists) {
      const r = await recordNotFound(ip);

      if (r.blockedNow) {
        console.log("🚫 IP throttled & blocked:", ip, "failCount:", r.failCount);
        return res.status(403).send('Too many invalid short links. Your IP has been temporarily blocked.');
      }

      console.log("⚠️ Short not found:", id, "ip:", ip, "failCount:", r.failCount);
      return res.status(404).send('Short link not found.');
    }

    const data = doc.data() || {};
    if (!data.url || !String(data.url).startsWith('http')) {
      return res.status(400).send('Invalid destination URL.');
    }

    // ✅ Immediate redirect
    res.redirect(302, data.url);

    // ✅ Async metadata update (after redirect)
    (async () => {
      try {
        const parser = new UAParser(req.headers['user-agent']);
        const device = parser.getDevice();
        const os = parser.getOS();
        const browser = parser.getBrowser();

        const referer = req.get('referer') || '';
        const userAgent = req.headers['user-agent'] || '';

        const metadata = {
          lastClickAt: admin.firestore.FieldValue.serverTimestamp(),
          lastClickIP: ip,
          referer,
          userAgent,
          deviceType: device.type || 'desktop',
          deviceVendor: device.vendor || '',
          deviceModel: device.model || '',
          osName: os.name || '',
          osVersion: os.version || '',
          browserName: browser.name || '',
          browserVersion: browser.version || '',
          clicks: admin.firestore.FieldValue.increment(1),
        };

        if (device.type === 'mobile') {
          metadata.mobileClicks = admin.firestore.FieldValue.increment(1);
        }

        await docRef.update(metadata);

        console.log(`📊 Click ${id} — ${metadata.deviceType} | ${metadata.osName} | ${metadata.browserName} | referer="${referer}"`);
      } catch (e) {
        console.error('⚠️ Metadata update error:', e.message);
      }
    })();

  } catch (e) {
    console.error('Redirection error:', e.message);
    res.status(500).send('Internal Server Error');
  }
});

// ----------------------------- START -----------------------------
app.listen(port, () => {
  console.log(`🚀 AUD.VC shortener running on port ${port}`);
});
