const admin = require('firebase-admin');
const serviceAccount = require('./secure/urlshortenner.json');
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

// Setup Firebase
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-!@$&*';
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
    res.redirect(urlData.url);
    await docRef.update({ clicks: admin.firestore.FieldValue.increment(1) });
  } catch (error) {
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
  limits: {
    fileSize: 256 * 1024 * 1024 * 1024
  },
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile('./index.html', { root: __dirname });
});

app.get('/campaign/*', async (req, res) => {
  const campaignPath = req.params[0];
  try {
    const campaignId = campaignPath;
    const urlsSnapshot = await db.collection('urls').where('campaign', '==', campaignId).get();
    let totalClicks = 0;
    urlsSnapshot.forEach(doc => {
      const urlData = doc.data();
      totalClicks += urlData.clicks || 0;
    });

    res.status(200).json({
      campaign: campaignId,
      clicks: totalClicks
    });
  } catch (error) {
    res.status(500).send('Internal Server Error');
  }
});

app.post('/upload-file', async (req, res) => {
  const wb = new xl.Workbook();
  const ws = wb.addWorksheet('FileSheet');
  try {
    if (!req.files) {
      res.send({
        status: false,
        message: 'No file uploaded'
      });
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
              db.collection('urls').doc(docId).set({
                url: url,
                id: docId,
                short: `https://aud.vc/${docId}`,
                phone: phonecol,
                campaign: campaignId,
                clicks: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
              });

              newRow[4] = `https://aud.vc/${docId}`;
            }

            return cols.reduce((object, col, index) => {
              object[col] = newRow[index] || '';
              return object;
            }, {});
          });

          console.log(formattedRows);
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

app.delete('/delete-old-links', async (req, res) => {
  const cutoffDate = new Date('2024-05-06T00:00:00Z'); // Date cutoff

  try {
    const urlsSnapshot = await db.collection('urls').where('createdAt', '<', cutoffDate).get();
    if (urlsSnapshot.empty) {
      return res.status(200).send('No old links found.');
    }

    const batch = db.batch();
    urlsSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    res.status(200).send('Old links successfully deleted.');
  } catch (error) {
    console.error('Error deleting old links:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Instantiate a new express based http server
const server = http.createServer(app);
server.listen(port, () => {
  console.log('Server is up and running on port: ' + port);
});

module.exports = app;
