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

const checkBlockedIP = async (req, res, next) => {
  let ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress).split(',')[0].trim();
  const blockedIPsSnapshot = await db.collection('blockedIps').where('ip', '==', ip).get();
  if (!blockedIPsSnapshot.empty) {
    const blocked = blockedIPsSnapshot.docs.some(doc => doc.data().blocked);
    if (blocked) {
      return res.status(403).send('Your IP has been blocked due to suspicious activity.');
    }
  }
  next();
};

app.use(checkBlockedIP);

app.get('/:id', async (req, res) => {
  let ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress).split(',')[0].trim();
  const { id } = req.params;

  const blockedIPsSnapshot = await db.collection('blockedIps').where('ip', '==', ip).get();
  if (!blockedIPsSnapshot.empty && blockedIPsSnapshot.docs.some(doc => doc.data().blocked)) {
    console.log("Blocked IP access attempt:", ip);
    return res.status(403).send('Your IP has been blocked due to suspicious activity.');
  }

  const docRef = db.collection('urls').doc(id);

  try {
    const doc = await docRef.get();
    if (!doc.exists) {
      await db.collection('blockedIps').doc(ip).set({ blocked: true, ip: ip });
      console.log("An IP has been blocked:", ip);
      return res.status(404).send('URL not found and your IP has been blocked.');
    }

    const urlData = doc.data();

    const parser = new UAParser(req.headers['user-agent']);
    const deviceType = parser.getDevice().type || 'desktop';

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

app.post('/unblock-ip', async (req, res) => {
  const { ipToUnblock } = req.body;
  try {
    await db.collection('blockedIps').doc(ipToUnblock).delete();
    res.send('IP has been successfully unblocked.');
  } catch (error) {
    res.status(500).send('Internal Server Error');
  }
});

app.use(fileUpload({
  createParentPath: true,
  limits: { fileSize: 256 * 1024 * 1024 * 1024 },
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile('./index.html', { root: __dirname });
});

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

app.post('/upload-file', async (req, res) => {
  const wb = new xl.Workbook();
  const ws = wb.addWorksheet('FileSheet');
  const getRandomDomain = () => {
    const randomIndex = Math.floor(Math.random() * shortUrlDomains.length);
    return shortUrlDomains[randomIndex];
  };

  try {
    if (!req.files) {
      res.send({ status: false, message: 'No file uploaded' });
    } else {
      const xlsxFile = req.files.xlsxFile;
      xlsxFile.mv('./uploads/' + xlsxFile.name, async function (err) {
        if (err) return res.status(500).send(err);
        const rows = await readXlsxFile(__dirname + `/uploads/${xlsxFile.name}`);
        if (rows.length > 0) {
          const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'code', 'code_postal', 'utm', 'ville'];
          const header = rows.shift();
          const formattedRows = rows.map((row, rowIndex) => {
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

app.listen(port, () => {
  console.log(`URL Shortener backend is running on port ${port}`);
});