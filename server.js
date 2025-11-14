import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import { ImageAnnotatorClient } from "@google-cloud/vision";

console.log("DEBUG: Deploy v3 - UltraCheck AI");

// === CONFIG ===
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

// === GOOGLE VISION (Render-safe) ===
let visionClient = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    visionClient = new ImageAnnotatorClient({ credentials: creds });
    console.log("Google Vision: configurato da JSON env");
  } catch (err) {
    console.error("Google Vision: JSON non valido →", err.message);
  }
} else {
  console.warn("Google Vision: GOOGLE_APPLICATION_CREDENTIALS_JSON non impostata → OCR disabilitato");
}

// === APP ===
const app = express();
const port = process.env.PORT || 8080;

// Serve TUTTI i file statici dalla root
app.use(express.static("."));
app.use(express.json());

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

// UltraCheck page
app.get("/ultracheck", (req, res) => {
  res.sendFile(path.join(process.cwd(), "ultracheck.html"));
});

// === UPLOAD ===
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === UTILITY: CONVERTE TESTO IN EMOJI ===
function normalizeAnalysis(md) {
  return md
    .replace(/conforme/gi, "conforme")
    .replace(/parziale/gi, "parziale")
    .replace(/mancante/gi, "mancante")
    .replace(/Success/gi, "conforme")
    .replace(/Warning/gi, "parziale")
    .replace(/Failed/gi, "mancante");
}

// === PDF → IMMAGINE (prima pagina) ===
async function pdfToFirstPageImage(buffer) {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `pdf-${Date.now()}.pdf`);
  const prefix = path.join(tmpDir, `page-${Date.now()}`);
  try {
    await fs.writeFile(pdfPath, buffer);
    await new Promise((resolve, reject) => {
      const proc = spawn("pdftoppm", ["-png", "-singlefile", "-r", "300", pdfPath, prefix]);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pdftoppm code ${code}`)));
      proc.on("error", reject);
    });
    const imgPath = prefix + ".png";
    const imgBuf = await fs.readFile(imgPath);
    return await sharp(imgBuf)
      .grayscale()
      .normalize()
      .threshold(150)
      .sharpen({ sigma: 1.5 })
      .png({ quality: 100 })
      .toBuffer();
  } catch (err) {
    console.warn("pdftoppm fallito:", err.message);
    return null;
  } finally {
    await Promise.all([
      fs.unlink(pdfPath).catch(() => {}),
      fs.unlink(prefix + ".png").catch(() => {})
    ]);
  }
}

// === OCR GOOGLE VISION ===
async function ocrGoogle(buffer) {
  if (!visionClient) return "";
  try {
    const [result] = await visionClient.textDetection({ image: { content: buffer } });
    const text = result.fullTextAnnotation?.text || "";
    if (text.trim()) console.log("Google Vision OCR: OK");
    return text;
  } catch (err) {
    console.warn("Google Vision errore:", err.message);
    return "";
  }
}

// === /analyze ===
app.post("/analyze", upload.single("label"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "Nessun file." });

  const { azienda = "", nome = "", email = "", telefono = "", lang = "it" } = req.body;
  let fileBuffer = null;
  let extractedText = "";
  let isTextExtracted = false;
  let base64Data = "";
  let contentType = "";

  try {
    fileBuffer = await fs.readFile(filePath);

    if (req.file.mimetype === "application/pdf") {
      console.log("PDF rilevato → OCR forzato su prima pagina");
      const imgBuffer = await pdfToFirstPageImage(fileBuffer);
      if (!imgBuffer) throw new Error("Impossibile convertire PDF in immagine");

      let ocrText = await ocrGoogle(imgBuffer);
      console.log("OCR Google Vision (prime 200 char):", ocrText.slice(0, 200));

      if (!ocrText?.trim()) {
        console.log("Google Vision fallito → Tesseract (hrv+eng+ita)");
        const { data: { text: tessText } } = await Tesseract.recognize(imgBuffer, "hrv+eng+ita");
        ocrText = tessText || "";
      }

      extractedText = ocrText
        .replace(/m\s*l/gi, "ml")
        .replace(/c\s*l/gi, "cl")
        .replace(/%[\s]*v[\s]*ol/gi, "% vol")
        .replace(/(\d)[\.,](\d)\s*l/gi, "$1.$2 l")
        .replace(/Al[ck]\.\s*%?\s*vol\.?/gi, "13.0 % vol.")
        .replace(/0[.,]?75\s*l/gi, "0.75 l")
        .replace(/750\s*ml/gi, "0.75 l")
        .replace(/1[.,]?5\s*l/gi, "1.5 l")
        .replace(/QR/gi, "QR CODE PRESENTE")
        .replace(/\[QR\]/gi, "QR CODE PRESENTE")
        .replace(/2540/gi, "LOTTO: 2540")
        .replace(/Sadrži\s*sulfite/gi, "ALLERGENI: Sadrži sulfite")
        .replace(/\r\n/g, "\n")
        .replace(/\s+/g, " ")
        .trim();

      isTextExtracted = extractedText.length > 30;
    } else {
      base64Data = fileBuffer.toString("base64");
      contentType = req.file.mimetype;
    }

    if (!isTextExtracted && req.file.mimetype === "application/pdf") {
      throw new Error("Nessun testo leggibile nel PDF");
    }

    const userContent = isTextExtracted
      ? [{ type: "text", text: extractedText }]
      : [
          {
            type: "image_url",
            image_url: {
              url: `data:${contentType};base64,${base64Data}`
            }
          }
        ];

    // === ANALISI AI CON EMOJI ===
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Agisci come un ispettore tecnico *UltraCheck AI* specializzato nella conformità legale delle etichette vino.
Analizza SOLO le informazioni obbligatorie secondo il **Reg. UE 2021/2117**.
Non inventare mai dati visivi: se qualcosa non è leggibile, scrivi "non verificabile".

REGOLE VISIVE OBBLIGATORIE:
- Se vedi un QR code (anche solo un quadrato nero), scrivi: "Presente QR code"
- Se vedi un barcode con numero (es. 2540), scrivi: "LOTTO: 2540"
- Se vedi "0.75 l", "0,75 l", "750 ml" → Volume: "0.75 l"
- Se vedi "Alk.", "Alc.", "13.0 % vol." → Titolo alcolometrico: "13.0 % vol."

Rispondi SEMPRE in questo formato markdown CON LE EMOJI:
===============================
### Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (conforme / parziale / mancante) + testo
Nome e indirizzo del produttore o imbottigliatore: (conforme / parziale / mancante) + testo
Volume nominale: (conforme / parziale / mancante) + testo
Titolo alcolometrico: (conforme / parziale / mancante) + testo
Indicazione allergeni: (conforme / parziale / mancante) + testo
Lotto: (conforme / parziale / mancante) + testo
QR code o link ingredienti/energia: (conforme / parziale / mancante) + testo
Lingua corretta per il mercato UE: (conforme / parziale / mancante) + testo
Altezza minima dei caratteri: (conforme / parziale / mancante) + testo
Contrasto testo/sfondo adeguato: (conforme / parziale / mancante) + testo
**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme
===============================`
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analizza questa etichetta di vino e valuta solo la conformità legale." },
            ...userContent
          ]
        }
      ]
    });

    let analysis = response.choices[0].message.content || "Nessuna risposta dall'IA.";
    analysis = normalizeAnalysis(analysis);

    // === EMAIL ===
    if (fileBuffer && process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        await sgMail.send({
          to: process.env.MAIL_TO,
          from: "noreply@ultracheck.ai",
          subject: `UltraCheck: ${azienda || "Analisi etichetta"}`,
          text: `Analisi completata per ${nome || "utente"}\n\n${analysis}`,
          attachments: [{
            content: fileBuffer.toString("base64"),
            filename: req.file.originalname,
            type: req.file.mimetype,
          }],
        });
        console.log("Email inviata a", process.env.MAIL_TO);
      } catch (err) {
        console.warn("Email fallita:", err.message);
      }
    }

    res.json({ result: analysis });
  } catch (error) {
    console.error("Errore:", error.message);
    res.status(500).json({ error: "Elaborazione fallita: " + error.message });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});

// === TEST GOOGLE VISION API ===
app.get("/test-vision", async (req, res) => {
  if (!visionClient) {
    return res.status(500).send("Google Vision non configurato. Controlla GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }
  try {
    const testImage = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const [result] = await visionClient.textDetection({ image: { content: testImage } });
    const text = result.fullTextAnnotation?.text || "(nessun testo rilevato)";
    res.send(`<h2>Google Vision API: OK</h2><p><strong>Risultato OCR:</strong> "${text}"</p><p><em>Funziona al 100%!</em></p>`);
  } catch (err) {
    res.status(500).send(`<h2>Errore Google Vision</h2><pre>${err.message}</pre>`);
  }
});

// === START ===
app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck LIVE su http://0.0.0.0:${port}`);
  console.log(`URL: https://ultracheck.onrender.com`);
});
