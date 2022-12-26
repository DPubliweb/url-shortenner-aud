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
XLSX = require('xslx')

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
  const doc = await db.collection('urls').doc(req.params.id).get();
  if (doc) {
    if (!doc.exists) {
      return res.send('No such url exists');
    } else {
      return res.redirect(doc.data().url);
    }
  }
})

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
      //Use the name of the input field (i.e. "avatar") to retrieve the uploaded file
      const xlsxFile = req.files.xlsxFile;

      //Use the mv() method to place the file in upload directory (i.e. "uploads")

      xlsxFile.mv('./uploads/' + xlsxFile.name, function (err) {
        if (err) return res.status(500).send(err);

        readXlsxFile(__dirname + `/uploads/${xlsxFile.name}`).then((rows) => {
          if (rows.length > 0) {
            const formattedRow = [];
            const cols = ['nom', 'prenom', 'mail', 'phone', 'lien', 'civilite', 'utm', 'code_postal','code']
            rows.forEach((row) => {
              const newRow = row
              const url = row[4]; // col E
              if (url) {
                const docId = nanoid(5);
                db.collection('urls').doc(docId).set({
                  url: url,
                  id: docId,
                  short: `https://aud.vc/${docId}`
                });
                newRow[4] = `https://aud.vc/${docId}`;
                const object = {};
                newRow.forEach((col, index) => {
                  object[cols[index]] = col || '';
                });
                formattedRow.push(object)
              } else {
                console.log('No url found');
              }
            })
            console.log(formattedRow);
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
                const workBook = XLSX.readFile(`/uploads/parsed_${xlsxFile.name}`)
                XLSX.writeFile(workBook, '/uploads/csv_test.csv', { bookType: "csv" });
                res.download(__dirname + '/uploads/csv_test.csv');
              }
            });
          }
        });

        // //send response
        // res.send({
        //   status: true,
        //   message: 'File is uploaded',
        //   data: {
        //     name: xlsxFile.name,
        //     mimetype: xlsxFile.mimetype,
        //     size: xlsxFile.size
        //   }
        // });
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
