// index.js (AUD.VC - updated like your metadata version)

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
  // mets la limite que tu veux (ancien code = énorme). Ici 512MB.
  limits: { fileSize: 512 * 1024 * 1024 },
}));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const nanoid = customAlphabet(alphabet, 5);

// ----------------------------- JOB STATUS STORE -----------------------------
const jobs = {}; // suivi en mémoire: { [jobId]: {status, filePath, message?} }

// ----------------------------- HELPERS -----------------------------
function normalizeDomains(raw) {
  if (!raw) return null;
  const arr = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s.startsWith('http://') || s.startsWith('https://')) ? s : `https://${s}`);
  return arr.length ? arr : null;
}

// Header prioritaire
function parseDomainsFromHeader(req) {
  return normalizeDomains(req.header('X-Short-Domains'));
}

// Fallback query: ?domains=aud.vc,xxx.com
function parseDomainsFromQuery(req) {
  return normalizeDomains(req.query.domains || req.query.domain || req.query.short_domains);
}

// ✅ Domaine par défaut si rien fourni
function getShortDomains(req) {
  return parseDomainsFromHeader(req) || parseDomainsFromQuery(req) || ['https://aud.vc'];
}

function getRandomDomain(domains) {
  return domains[Math.floor(Math.random() * domains.length)];
}

function getClientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString();
  // x-forwarded-for peut contenir "ip1, ip2"
  const ip = raw.split(',')[0].trim();
  // retire port éventuel (ex: ::ffff:127.0.0.1:1234)
  return ip.replace(/:\d+$/, '');
}

async function isIpBlocked(ip) {
  // 1) docId = ip (nouvelle logique)
  const direct = await db.collection('blockedIps').doc(ip).get();
  if (direct.exists && direct.data()?.blocked) return true;

  // 2) fallback compat ancien: documents dont champ ip == ip
  const snap = await db.collection('blockedIps').where('ip', '==', ip).limit(5).get();
  if (!snap.empty) {
    return snap.docs.some(d => d.data()?.blocked);
  }
  return false;
}

async function blockIp(ip, reason = 'suspicious') {
  try {
    await db.collection('blockedIps').doc(ip).set({
      ip,
      blocked: true,
      reason,
      blockedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.error('⚠️ Failed to block IP:', ip, e.message);
  }
}

// ----------------------------- IP BLOCK MIDDLEWARE -----------------------------
app.use(async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    if (await isIpBlocked(ip)) {
      return res.status(403).send('Your IP has been blocked due to suspicious activity.');
    }
    next();
  } catch (e) {
    console.error('IP check error:', e.message);
    next(); // on laisse passer si erreur lecture
  }
});

// ----------------------------- HOME -----------------------------
app.get('/', (req, res) => {
  res.send('AUD.VC shortener is running ✅');
});

// ----------------------------- UNBLOCK IP -----------------------------
app.post('/unblock-ip', async (req, res) => {
  const { ipToUnblock } = req.body || {};
  if (!ipToUnblock) return res.status(400).json({ error: 'ipToUnblock is required' });

  try {
    // suppression docId = ip
    await db.collection('blockedIps').doc(ipToUnblock).delete();

    // suppression fallback (si anciens docs existaient)
    const snap = await db.collection('blockedIps').where('ip', '==', ipToUnblock).get();
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    if (!snap.empty) await batch.commit();

    res.json({ ok: true, message: 'IP has been successfully unblocked.' });
  } catch (error) {
    console.error('Unblock error:', error.message);
    res.status(500).send('Internal Server Error');
  }
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

// (Optionnel mais utile) stats globales
app.get('/stats/global', async (req, res) => {
  try {
    const snapshot = await db.collection('urls').get();

    let totalClicks = 0;
    let totalMobileClicks = 0;
    const campaignStats = {};

    snapshot.forEach(doc => {
      const d = doc.data();
      totalClicks += d.clicks || 0;
      totalMobileClicks += d.mobileClicks || 0;

      const c = d.campaign || 'unknown';
      if (!campaignStats[c]) campaignStats[c] = { count: 0, clicks: 0, mobileClicks: 0 };
      campaignStats[c].count++;
      campaignStats[c].clicks += d.clicks || 0;
      campaignStats[c].mobileClicks += d.mobileClicks || 0;
    });

    res.json({
      totalUrls: snapshot.size,
      totalClicks,
      mobileClicks: totalMobileClicks,
      campaigns: campaignStats
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

    // ✅ Réponse immédiate
    res.status(202).json({ status: 'received', jobId });

    // 🚀 Traitement async
    const domains = getShortDomains(req); // si rien fourni => ['https://aud.vc']
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

    // Colonnes "compat" avec ton ancien code
    const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'code', 'code_postal', 'utm', 'ville'];

    // retire header
    rows.shift();

    const formattedRows = [];

    // Batch Firestore (500 ops max)
    let batch = db.batch();
    let batchCount = 0;
    let totalWritten = 0;

    for (const row of rows) {
      const url = row[4];       // destination
      const campaignId = row[8];
      const phone = row[3];
      const newRow = [...row];

      if (url && String(url).startsWith('http')) {
        const id = nanoid();
        const selectedDomain = getRandomDomain(shortUrlDomains || ['https://aud.vc']);
        const domainOnly = selectedDomain.replace(/^https?:\/\//, '');

        const docRef = db.collection('urls').doc(id);

        batch.set(docRef, {
          id,
          url,
          short: `${selectedDomain}/${id}`,
          domain: domainOnly,
          phone,
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

        // remplace la colonne lien par le short
        newRow[4] = `${selectedDomain}/${id}`;
      } else {
        // si pas d'URL destination, on laisse la cellule telle quelle
        // (ou vide) et on ne crée pas de shortlink
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

    // écrit xlsx de sortie
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
// IMPORTANT: doit rester TOUT EN BAS après toutes les routes API
app.get('*', async (req, res) => {
  const pathPart = req.path.replace(/^\/+/, '').trim();
  const id = pathPart.split('/')[0]; // on prend juste le 1er segment
  if (!id || id.length < 3) return res.status(404).send('Invalid short link');

  const ip = getClientIp(req);

  try {
    const docRef = db.collection('urls').doc(id);
    const doc = await docRef.get();

    // si le doc n'existe pas => blocage IP (comme ton ancien comportement)
    if (!doc.exists) {
      await blockIp(ip, 'short_not_found');
      console.log("🚫 Blocked IP (short not found):", ip, "for id:", id);
      return res.status(404).send('URL not found and your IP has been blocked.');
    }

    const data = doc.data();
    if (!data?.url || !String(data.url).startsWith('http')) {
      return res.status(400).send('Invalid destination URL.');
    }

    // ✅ redirect immédiat
    res.redirect(302, data.url);

    // ✅ update async métadonnées (après redirect)
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
          clicks: admin.firestore.FieldValue.increment(1)
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
