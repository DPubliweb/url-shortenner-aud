// index.js

const admin = require('firebase-admin');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const fileUpload = require('express-fileupload');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const readXlsxFile = require('read-excel-file/node');
const xl = require('excel4node');
const { customAlphabet } = require('nanoid');
const express = require('express');
const UAParser = require('ua-parser-js');

const app = express();

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

const shortUrlDomains = ['https://aud.vc'];

if (!serviceAccount.private_key) {
  console.error('FIREBASE_PRIVATE_KEY is not defined. Check your .env file.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const length = 5;
const nanoid = customAlphabet(alphabet, length);
const port = process.env.PORT || 8002;

// -------------------- MIDDLEWARES (inchangés) --------------------
app.use(cookieParser());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(fileUpload({
  createParentPath: true,
  limits: { fileSize: 256 * 1024 * 1024 * 1024 },
}));

// -------------------- NOUVELLE LOGIQUE IP THROTTLE --------------------
// 3 IDs inexistants en 5 minutes => blocage définitif
const IP_FAIL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const IP_FAIL_THRESHOLD = 3;             // 3 essais => block définitif

function nowMs() { return Date.now(); }

function getClientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').toString();
  return raw.split(',')[0].trim().replace(/:\d+$/, '');
}

// Pour éviter les faux positifs (favicon.ico, robots.txt, "campaign", etc.)
// On ne compte que si l'id ressemble à un vrai short id (5 alphanum)
function shouldCountNotFound(id) {
  return /^[0-9A-Za-z]{5}$/.test(id);
}

// Compatible legacy: certains docs blockedIps peuvent être trouvés via where('ip'=='...')
async function isIpBlocked(ip) {
  // 1) docId = ip (recommandé)
  const direct = await db.collection('blockedIps').doc(ip).get();
  if (direct.exists && direct.data()?.blocked) return true;

  // 2) fallback legacy
  const snap = await db.collection('blockedIps').where('ip', '==', ip).limit(5).get();
  if (!snap.empty) {
    return snap.docs.some(d => d.data()?.blocked);
  }
  return false;
}

async function recordNotFoundAndMaybeBlock(ip) {
  const ref = db.collection('blockedIps').doc(ip);

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = nowMs();

    const data = snap.exists ? (snap.data() || {}) : {};

    // déjà bloqué => on garde
    if (data.blocked) {
      return { blockedNow: true, failCount: data.failCount || 0 };
    }

    const firstFailAtMs = data.firstFailAt?.toMillis?.() ?? 0;
    let failCount = data.failCount || 0;

    // fenêtre expirée => reset
    let firstFailAt = data.firstFailAt;
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
      reason: 'not_found_threshold',
      blockedAt: admin.firestore.FieldValue.delete(),
    };

    if (failCount >= IP_FAIL_THRESHOLD) {
      updates.blocked = true; // ✅ blocage définitif
      updates.blockedAt = admin.firestore.Timestamp.fromMillis(n);
    }

    tx.set(ref, updates, { merge: true });
    return { blockedNow: updates.blocked, failCount };
  });
}

// Middleware global de blocage (inchangé côté comportement, mais logique améliorée)
const checkBlockedIP = async (req, res, next) => {
  try {
    const ip = getClientIp(req);
    if (await isIpBlocked(ip)) {
      return res.status(403).send('Your IP has been blocked due to suspicious activity.');
    }
    next();
  } catch (e) {
    console.error('checkBlockedIP error:', e.message);
    next();
  }
};

app.use(checkBlockedIP);

// -------------------- ROUTES (ordre corrigé) --------------------

// Home
app.get('/', (req, res) => {
  res.sendFile('./index.html', { root: __dirname });
});

// Stats campagne
app.get('/campaign/:campaignId/stats', async (req, res) => {
  const { campaignId } = req.params;

  try {
    const urlsSnapshot = await db.collection('urls').where('campaign', '==', campaignId).get();

    let totalClicks = 0;
    let totalMobileClicks = 0;

    urlsSnapshot.forEach(doc => {
      const data = doc.data();
      totalClicks += data.clicks || 0;
      totalMobileClicks += data.mobileClicks || 0;
    });

    return res.status(200).json({
      campaign: campaignId,
      totalUrls: urlsSnapshot.size,
      totalClicks,
      mobileClicks: totalMobileClicks
    });

  } catch (err) {
    console.error('Error fetching campaign stats:', err);
    return res.status(500).send('Internal Server Error');
  }
});

// Upload fichier (inchangé)
app.post('/upload-file', async (req, res) => {
  const wb = new xl.Workbook();
  const ws = wb.addWorksheet('FileSheet');

  const getRandomDomain = () => {
    const randomIndex = Math.floor(Math.random() * shortUrlDomains.length);
    return shortUrlDomains[randomIndex];
  };

  try {
    if (!req.files) {
      return res.send({ status: false, message: 'No file uploaded' });
    } else {
      const xlsxFile = req.files.xlsxFile;
      xlsxFile.mv('./uploads/' + xlsxFile.name, async function (err) {
        if (err) return res.status(500).send(err);
        const rows = await readXlsxFile(__dirname + `/uploads/${xlsxFile.name}`);
        if (rows.length > 0) {
          const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'code', 'code_postal', 'utm', 'ville'];
          rows.shift(); // header

          const formattedRows = rows.map((row) => {
            const url = row[4];
            const campaignId = row[8];
            const phonecol = row[3];
            const newRow = [...row];

            if (url) {
              const docId = nanoid();
              const selectedDomain = getRandomDomain();
              db.collection('urls').doc(docId).set({
                url: url,
                id: docId,
                short: `${selectedDomain}/${docId}`,
                phone: phonecol,
                campaign: campaignId,
                clicks: 0,
                mobileClicks: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
              });
              newRow[4] = `${selectedDomain}/${docId}`;
            }

            return cols.reduce((object, col, index) => {
              object[col] = newRow[index] || '';
              return object;
            }, {});
          });

          cols.forEach((heading, i) => ws.cell(1, i + 1).string(heading));
          formattedRows.forEach((record, rowIndex) => {
            Object.values(record).forEach((value, colIndex) => {
              ws.cell(rowIndex + 2, colIndex + 1).string(value);
            });
          });

          const parsedFilePath = __dirname + `/uploads/parsed_${xlsxFile.name}`;
          wb.write(parsedFilePath, function (err) {
            if (err) {
              console.error(err);
              return res.status(500).send(err);
            }
            res.download(parsedFilePath, `parsed_${xlsxFile.name}`);
          });
        }
      });
    }
  } catch (err) {
    res.status(500).send(err);
  }
});

// Route existante /unblock-ip (je la laisse inchangée puisque tu n’as pas demandé de la retirer ici)
app.post('/unblock-ip', async (req, res) => {
  const { ipToUnblock } = req.body;
  try {
    await db.collection('blockedIps').doc(ipToUnblock).delete();
    res.send('IP has been successfully unblocked.');
  } catch (error) {
    res.status(500).send('Internal Server Error');
  }
});

// -------------------- REDIRECTION (avec nouvelle règle not-found) --------------------
app.get('/:id', async (req, res) => {
  const ip = getClientIp(req);
  const { id } = req.params;

  // (ta vérif "blocked" était doublonnée, mais checkBlockedIP middleware le fait déjà)
  const docRef = db.collection('urls').doc(id);

  try {
    const doc = await docRef.get();

    // ✅ CHANGEMENT: si l'ID n'existe pas => on compte et bloque seulement après seuil
    if (!doc.exists) {
      if (shouldCountNotFound(id)) {
        const r = await recordNotFoundAndMaybeBlock(ip);

        if (r.blockedNow) {
          console.log("🚫 IP blocked permanently:", ip, "failCount:", r.failCount);
          return res.status(403).send('Too many invalid short links. Your IP has been blocked.');
        }

        console.log("⚠️ Short not found:", id, "ip:", ip, "failCount:", r.failCount);
      } else {
        console.log("⚠️ Not found (ignored for throttle):", id, "ip:", ip);
      }

      return res.status(404).send('URL not found.');
    }

    const urlData = doc.data();

    const parser = new UAParser(req.headers['user-agent']);
    const deviceType = parser.getDevice().type || 'desktop';

    // ✅ Ici on garde TA logique: tu différencies déjà mobile/desktop
    const updates = {
      clicks: admin.firestore.FieldValue.increment(1),
    };
    if (deviceType === 'mobile') {
      updates.mobileClicks = admin.firestore.FieldValue.increment(1);
    }

    res.redirect(urlData.url);
    await docRef.update(updates);

  } catch (error) {
    console.error('Redirection error:', error);
    return res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`URL Shortener backend is running on port ${port}`);
});
