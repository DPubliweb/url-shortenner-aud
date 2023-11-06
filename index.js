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
const readXlsxFile = require('read-excel-file/node')
const xl = require('excel4node');
const { nanoid } = require('nanoid')
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
  try {
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).send('No such url exists');
    } else {
      const urlData = doc.data();
      // Rediriger vers l'URL réelle
      res.redirect(urlData.url);
      // Incrémenter le compteur de clics
      await docRef.update({ clicks: admin.firestore.FieldValue.increment(1) });
      // Vous pouvez également ajouter ici une logique pour attribuer le clic à une campagne spécifique si nécessaire
    }
  } catch (error) {
    return res.status(500).send('Internal Server Error');
  }
});

app.get('/campaign/*', async (req, res) => {
  // La partie de l'URL après '/campaign/' sera capturée dans un tableau appelé 0 dans req.params
  const campaignPath = req.params[0]; // contient tout après '/campaign/'

  try {
    // Vous pourriez avoir besoin de décomposer la campagnePath pour obtenir l'ID de la campagne réel
    // Si campaignPath est supposé être l'ID de la campagne, vous pouvez l'utiliser directement
    const campaignId = campaignPath; // ou décomposer plus loin si nécessaire
    
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
      // Retrieve the uploaded file
      const xlsxFile = req.files.xlsxFile;

      // Place the file in the upload directory
      xlsxFile.mv('./uploads/' + xlsxFile.name, async function (err) {
        if (err) return res.status(500).send(err);

        // Read the Excel file
        const rows = await readXlsxFile(__dirname + `/uploads/${xlsxFile.name}`);
        if (rows.length > 0) {
          // Adjust your columns array to include 'campaign'
          const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'code', 'code_postal', 'utm', 'campagne'];

          // Assuming the first row of the sheet is the header
          const header = rows.shift();

          const formattedRows = rows.map((row, rowIndex) => {
            const url = row[4]; // Assuming the URL is in column E
            const campaignId = row[8]; // Assuming the campaign ID is in column I
            const newRow = [...row];

            if (url) {
              const docId = nanoid(5);
              db.collection('urls').doc(docId).set({
                url: url,
                id: docId,
                short: `https://aud.vc/${docId}`,
                campaign: campaignId,
                clicks: 0, // Initialize click count
                createdAt: admin.firestore.FieldValue.serverTimestamp() // Add the timestamp here
              });

              newRow[4] = `https://aud.vc/${docId}`; // Replace the URL with the short link
            }

            return cols.reduce((object, col, index) => {
              object[col] = newRow[index] || '';
              return object;
            }, {});
          });

          console.log(formattedRows);

          // Write headers to the first row
          cols.forEach((heading, i) => ws.cell(1, i + 1).string(heading));

          // Write the rest of the data
          formattedRows.forEach((record, rowIndex) => {
            Object.values(record).forEach((value, colIndex) => {
              ws.cell(rowIndex + 2, colIndex + 1).string(value);
            });
          });

          // Save the new workbook
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

// Instantiate a new express based http server
const server = http.createServer(app);
server.listen(port, () => {
  console.log('Server is up and running on port: ' + port);
});

module.exports = app;
