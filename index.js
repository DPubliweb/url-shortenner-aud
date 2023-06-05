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
const { nanoid } = require('nanoid');
const _ = require('lodash');

// Express service
const express = require('express');
const app = express();

// General Parameters for express
const port = process.env.PORT || 8002;

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// enable files upload
app.use(fileUpload({
  createParentPath: true,
  parseNested: true,
  limits: {
    fileSize: 256 * 1024 * 1024 * 1024 //2MB max file(s) size
  },
}));

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.sendFile('./index.html', {root: __dirname });
});

app.get('/:id', async (req, res) => {
  const docRef = db.collection('urls').doc(req.params.id);
  const doc = await docRef.get();
  if (doc.exists) {
    docRef.update({ clicked: true });
    return res.redirect(doc.data().url);
  } else {
    return res.send('No such url exists');
  }
});

app.get('/campaign/:campaignName/clicks', async (req, res) => {
  const campaignName = req.params.campaignName;

  // Fetch the click count
  const clickedSnapshot = await db.collection('urls')
    .where('campaign', '==', campaignName)
    .where('clicked', '==', true)
    .get();
  const clickCount = clickedSnapshot.docs.length;

  // Fetch the link count
  const campaignDoc = await db.collection('campaigns').doc(campaignName).get();
  const linkCount = campaignDoc.data().linkCount;

  // Calculate the click rate
  const clickRate = clickCount / linkCount;

  res.send(`Total clicks for campaign ${campaignName}: ${clickCount}\nTotal links for campaign ${campaignName}: ${linkCount}\nClick rate for campaign ${campaignName}: ${clickRate}`);
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
      xlsxFile.mv('./uploads/' + xlsxFile.name, function (err) {
        if (err) return res.status(500).send(err);

        readXlsxFile(__dirname + `/uploads/${xlsxFile.name}`).then(async (rows) => {
          if (rows.length > 0) {
            const formattedRow = [];
            const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'utm', 'code_postal','code']
            const totalLines = rows.length - 1;
            const promises = rows.map(async (row) => {  // Changed from forEach to map
              const newRow = row;
              const url = row[4]; // col E
              if (url) {
                const docId = nanoid(5);
                await db.collection('urls').doc(docId).set({  // Added await here
                  url: url,
                  id: docId,
                  short: `https://aud.vc/${docId}`,
                  clicked: false,
                  campaign: req.body.campaign
                });
                newRow[4] = `https://aud.vc/${docId}`;

                // Update the link count for the campaign
                const campaignRef = db.collection('campaigns').doc(req.body.campaign);
                const campaignDoc = await campaignRef.get();
                if (campaignDoc.exists) {
                  campaignRef.update({ linkCount: totalLines });
                } else {
                  campaignRef.set({ linkCount: totalLines });
                }

                const object = {};
                newRow.forEach((col, index) => {
                  object[cols[index]] = col || '';
                });
                formattedRow.push(object)
              } else {
                console.log('No url found');
              }
            });

            await Promise.all(promises);  // Added this line

            let headingColumnIndex = 1;
            cols.forEach(heading => {
              ws.cell(1, headingColumnIndex++)
                .string(heading)
            });
            let rowIndex = 2;
            formattedRow.forEach(record => {
              let columnIndex = 1;
              Object.keys(record).forEach(columnName => {
                ws.cell(rowIndex, columnIndex++)
                  .string(record[columnName])
              });
              rowIndex++;
            });
            wb.write(__dirname + `/uploads/parsed_${xlsxFile.name}`, function (err, stats) {
              if (err) {
                console.error(err);
              } else {
                res.download(__dirname + `/uploads/parsed_${xlsxFile.name}`, `parsed_${xlsxFile.name}`);
              }
            });
          }
        });
      });
    }
  } catch (err) {
    res.status(500).send(err);
  }
});

// Instantiate a new express based http server
const server = http.createServer(app);
server.listen(port, () => {
  console.log('Server is up and running on port: ' + port);
});

module.exports = app;
