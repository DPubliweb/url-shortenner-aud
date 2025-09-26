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
const app = express();
const UAParser = require('ua-parser-js');

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

const shortUrlDomains = [
  'https://aud.vc'
];

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

// S'assure que le dossier uploads existe
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

// Middleware blocage IP
const checkBlockedIP = async (req, res, next) => {
  try {
    let ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
    const blockedIPsSnapshot = await db.collection('blockedIps').where('ip', '==', ip).get();
    if (!blockedIPsSnapshot.empty) {
      const blocked = blockedIPsSnapshot.docs.some(doc => doc.data().blocked);
      if (blocked) {
        return res.status(403).send('Your IP has been blocked due to suspicious activity.');
      }
    }
  } catch (e) {
    console.error('checkBlockedIP error:', e?.message || e);
  }
  next();
};

app.use(checkBlockedIP);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ createParentPath: true, limits: { fileSize: 256 * 1024 * 1024 * 1024 } }));

app.get('/', (req, res) => {
  res.sendFile('./index.html', { root: __dirname });
});

// Redirection + incrément des compteurs (URL + campagne)
app.get('/:id', async (req, res) => {
  let ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
  const { id } = req.params;

  try {
    const blockedIPsSnapshot = await db.collection('blockedIps').where('ip', '==', ip).get();
    if (!blockedIPsSnapshot.empty && blockedIPsSnapshot.docs.some(doc => doc.data().blocked)) {
      console.log("Blocked IP access attempt:", ip);
      return res.status(403).send('Your IP has been blocked due to suspicious activity.');
    }

    const docRef = db.collection('urls').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      await db.collection('blockedIps').doc(ip).set({ blocked: true, ip: ip });
      console.log("An IP has been blocked:", ip);
      return res.status(404).send('URL not found and your IP has been blocked.');
    }

    const urlData = doc.data() || {};
    const parser = new UAParser(req.headers['user-agent']);
    const deviceType = parser.getDevice().type || 'desktop';

    // Incréments au niveau du document URL
    const urlUpdates = { clicks: admin.firestore.FieldValue.increment(1) };
    if (deviceType === 'mobile') {
      urlUpdates.mobileClicks = admin.firestore.FieldValue.increment(1);
    }

    // Incréments matérialisés au niveau de la campagne
    const campaignId = String(urlData.campaign || 'unknown');
    const statsRef = db.collection('campaignStats').doc(campaignId);
    const inc = admin.firestore.FieldValue.increment(1);
    const statsUpdate = { totalClicks: inc };
    if (deviceType === 'mobile') {
      statsUpdate.mobileClicks = inc;
    }

    // Redirige immédiatement, puis effectue les écritures en parallèle
    res.redirect(urlData.url);
    await Promise.all([
      docRef.update(urlUpdates),
      statsRef.set(statsUpdate, { merge: true })
    ]);

  } catch (error) {
    console.error('Redirection error:', error);
    return res.status(500).send('Internal Server Error');
  }
});

// (Optionnel) Sécuriser au moins un peu le déblocage avec un header simple
app.post('/unblock-ip', async (req, res) => {
  const { ipToUnblock } = req.body;
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).send('Unauthorized');
  }
  try {
    await db.collection('blockedIps').doc(ipToUnblock).delete();
    res.send('IP has been successfully unblocked.');
  } catch (error) {
    console.error('unblock-ip error:', error?.message || error);
    res.status(500).send('Internal Server Error');
  }
});

// Stats matérialisées -> lecture d’un seul doc
app.get('/campaign/:campaignId/stats', async (req, res) => {
  const { campaignId } = req.params;
  try {
    const ref = db.collection('campaignStats').doc(String(campaignId));
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : {};
    return res.status(200).json({
      campaign: campaignId,
      totalUrls: Number(data.totalUrls) || 0,
      totalClicks: Number(data.totalClicks) || 0,
      mobileClicks: Number(data.mobileClicks) || 0
    });
  } catch (err) {
    console.error('Stats read error:', err?.message || err);
    return res.status(500).send('Internal Server Error');
  }
});

// Upload fichier -> création des URLs + incrément totalUrls par campagne
app.post('/upload-file', async (req, res) => {
  const wb = new xl.Workbook();
  const ws = wb.addWorksheet('FileSheet');

  const getRandomDomain = () => {
    const randomIndex = Math.floor(Math.random() * shortUrlDomains.length);
    return shortUrlDomains[randomIndex];
  };

  try {
    if (!req.files || !req.files.xlsxFile) {
      return res.status(400).send({ status: false, message: 'No file uploaded' });
    }

    const xlsxFile = req.files.xlsxFile;
    const uploadPath = path.join(__dirname, 'uploads', xlsxFile.name);
    await xlsxFile.mv(uploadPath);

    const rows = await readXlsxFile(uploadPath);
    if (!rows || rows.length === 0) {
      return res.status(400).send({ status: false, message: 'Empty file' });
    }

    const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'code', 'code_postal', 'utm', 'ville'];
    rows.shift(); // en-tête source

    const batchWrites = [];
    const formattedRows = [];

    for (const row of rows) {
      const newRow = Array.isArray(row) ? [...row] : [];
      const url = newRow[4];
      const campaignId = String(newRow[8] || 'unknown');
      const phonecol = newRow[3];

      if (url) {
        const docId = nanoid();
        const selectedDomain = getRandomDomain();

        // Écritures Firestore
        const urlRef = db.collection('urls').doc(docId);
        batchWrites.push(
          urlRef.set({
            url,
            id: docId,
            short: `${selectedDomain}/${docId}`,
            phone: phonecol || '',
            campaign: campaignId,
            clicks: 0,
            mobileClicks: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          })
        );

        // Incrémente totalUrls par campagne (matérialisé)
        const statsRef = db.collection('campaignStats').doc(campaignId);
        batchWrites.push(
          statsRef.set({ totalUrls: admin.firestore.FieldValue.increment(1) }, { merge: true })
        );

        // Remplace l'URL dans la ligne exportée
        newRow[4] = `${selectedDomain}/${docId}`;
      }

      const record = cols.reduce((obj, col, idx) => {
        obj[col] = (newRow[idx] ?? '').toString();
        return obj;
      }, {});
      formattedRows.push(record);
    }

    // Execute toutes les écritures (parallèle)
    await Promise.all(batchWrites);

    // Génère le XLSX de sortie
    cols.forEach((heading, i) => ws.cell(1, i + 1).string(heading));
    formattedRows.forEach((record, rowIndex) => {
      Object.values(record).forEach((value, colIndex) => {
        ws.cell(rowIndex + 2, colIndex + 1).string(String(value));
      });
    });

    const parsedFilePath = path.join(__dirname, 'uploads', `parsed_${xlsxFile.name}`);
    wb.write(parsedFilePath, function (err) {
      if (err) {
        console.error('Excel write error:', err);
        return res.status(500).send(err);
      }
      res.download(parsedFilePath, `parsed_${xlsxFile.name}`);
    });

  } catch (err) {
    console.error('upload-file error:', err?.message || err);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(port, () => {
  console.log(`URL Shortener backend is running on port ${port}`);
});