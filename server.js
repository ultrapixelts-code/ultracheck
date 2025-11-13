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
    console.error("Controlla GOOGLE_APPLICATION_CREDENTIALS_JSON");
  }
} else {
  console.warn("Google Vision: GOOGLE_APPLICATION_CREDENTIALS_JSON non impostata → OCR disabilitato");
}

// === APP ===
const app = express();
const port = process.env.PORT || 8080;

// Serve TUTTI i file statici dalla root (main/)
app.use(express.static("."));
// index.html, ultracheck.html, ecc.
app.use(express.json());

// Homepage → index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

// Rotta per ultracheck.html (opzionale)
app.get("/ultracheck", (req, res) => {
  res.sendFile(path.join(process.cwd(), "ultracheck.html"));
});

// === UPLOAD ===
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, ${Date.now()}-${file.originalname}),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === UTILITY ===
function normalizeAnalysis(md) {
  const statusFor = (line) => {
    const low = line.toLowerCase();
    if (/(^|\s)(non\s*presente|mancante|assente|non\s*riportat[oa]|assenza)(\W|$)/.test(low)) return "Failed";
    if (/(non\s*verificabil|non\s*determinabil|non\s*misurabil|non\s*leggibil)/.test(low)) return "Warning";
    if (/(conform|presente|indicata|indicato|riporta|adeguat|corrett)/.test(low)) return "Success";
    return null;
  };

  return md
    .split("\n")
    .map((raw) => {
      const trimmed = raw.trimStart();
      const isField = /^[Success|Warning|Failed]/.test(trimmed) || /^[-*]\s+**/.test(trimmed) || /^[-*]\s+[A-ZÀ-Ú]/.test(trimmed);
      if (!isField) return raw;
      const status = statusFor(trimmed);
      if (!status) return raw;
      const clean = trimmed.replace(/^(Success|Warning|Failed)\s*/, "");
      const pad = raw.slice(0, raw.indexOf(trimmed));
      return ${pad}${status} ${clean};
    })
    .join("\n");
}

// === PDF-PARSE (dinamico) ===
let pdfParse = null;
(async () => {
  try {
    const lib = await import("pdf-parse");
    pdfParse = lib.default || lib;
    console.log("pdf-parse: caricato");
  } catch (err) {
    console.log("pdf-parse: non disponibile → fallback pdftotext");
  }
})();

// === ESTRAI TESTO NATIVO ===
async function parsePdf(buffer) {
  if (pdfParse) {
    try {
      const data = await pdfParse(buffer);
      return { text: data.text || "" };
    } catch (err) {
      console.warn("pdf-parse fallito:", err.message);
    }
  }

  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, pdf-${Date.now()}.pdf);
  const txtPath = pdfPath.replace(".pdf", ".txt");

  try {
    await fs.writeFile(pdfPath, buffer);
    await new Promise((resolve, reject) => {
      const proc = spawn("pdftotext", ["-raw", "-layout", pdfPath, txtPath]);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(pdftotext code ${code})));
      proc.on("error", reject);
    });
    const text = await fs.readFile(txtPath, "utf8").catch(() => "");
    return { text };
  } finally {
    await Promise.all([
      fs.unlink(pdfPath).catch(() => {}),
      fs.unlink(txtPath).catch(() => {})
    ]);
  }
}

// === PDF → IMMAGINE (prima pagina) ===
async function pdfToFirstPageImage(buffer) {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, pdf-${Date.now()}.pdf);
  const prefix = path.join(tmpDir, page-${Date.now()});

  try {
    await fs.writeFile(pdfPath, buffer);
    await new Promise((resolve, reject) => {
      const proc = spawn("pdftoppm", ["-png", "-singlefile", "-r", "300", pdfPath, prefix]);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(pdftoppm code ${code})));
      proc.on("error", reject);
    });
    const imgPath = prefix + ".png";
    const imgBuf = await fs.readFile(imgPath);
    return await sharp(imgBuf)
      .grayscale()
      .normalize()
      .threshold(180)
      .sharpen()
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
  const language = lang.toLowerCase();

  let fileBuffer = null;
  let extractedText = "";
  let isTextExtracted = false;
  let base64Data = "";
  let contentType = "";

  try {
    fileBuffer = await fs.readFile(filePath);

    if (req.file.mimetype === "application/pdf") {
      console.log("PDF rilevato");
      const { text } = await parsePdf(fileBuffer);
      if (text?.trim().length > 50) {
        extractedText = text;
        isTextExtracted = true;
        console.log("Testo nativo estratto");
      } else {
        console.log("Nessun testo nativo → OCR");
        const imgBuffer = await pdfToFirstPageImage(fileBuffer);
        if (imgBuffer) {
          let ocrText = await ocrGoogle(imgBuffer);
          if (!ocrText?.trim()) {
            console.log("Google Vision fallito → Tesseract");
            const { data: { text: tessText } } = await Tesseract.recognize(imgBuffer, "ita+eng");
            ocrText = tessText || "";
          }
          extractedText = ocrText;
          isTextExtracted = extractedText.trim().length > 30;
        }
      }

      if (!isTextExtracted) throw new Error("Nessun testo leggibile nel PDF");

      extractedText = extractedText
        .replace(/m\s*l/gi, "ml")
        .replace(/c\s*l/gi, "cl")
        .replace(/%[\s]*v[\s]*ol/gi, "% vol")
        .replace(/\r\n/g, "\n")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      base64Data = fileBuffer.toString("base64");
      contentType = req.file.mimetype;
    }

    const userContent = isTextExtracted
      ? [{ type: "text", text: extractedText }]
      : [{ type: "image_url", image_url: { url: data:${contentType};base64,${base64Data} } }];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Agisci come un ispettore tecnico *UltraCheck AI* specializzato nella conformità legale delle etichette vino. Analizza SOLO le informazioni obbligatorie secondo il **Regolamento (UE) 2021/2117**. Non inventare mai dati visivi: se qualcosa non è leggibile, scrivi "non verificabile". Rispondi sempre nel formato markdown esatto qui sotto, in lingua: ${language}.
### 🔎 Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (✅ conforme / ⚠️ parziale / ❌ mancante) + testo
Nome e indirizzo del produttore o imbottigliatore: (✅/⚠️/❌) + testo
Volume nominale: (✅/⚠️/❌) + testo
Titolo alcolometrico: (✅/⚠️/❌) + testo
Indicazione allergeni: (✅/⚠️/❌) + testo
Lotto: (✅/⚠️/❌) + testo
QR code o link ingredienti/energia: (✅/⚠️/❌) + testo
Lingua corretta per il mercato UE: (✅/⚠️/❌) + testo
Altezza minima dei caratteri: (✅/⚠️/❌) + testo
Contrasto testo/sfondo adeguato: (✅/⚠️/❌) + testo
**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme
===============================\u00a0\u00a0\u00a0\u00a0},
        {
          role: "system",
          content: `IMPORTANT: Se la lingua selezionata è francese (${language} = "fr"), traduci completamente tutti i titoli e le intestazioni in francese, mantenendo il formato identico. Se è inglese (${language} = "en"), traduci in inglese. Esempi di traduzione:
🇫🇷 **Francese**

* "Conformità normativa" → "Conformité réglementaire"
* "Denominazione di origine" → "Dénomination d’origine"
* "Nome e indirizzo del produttore o imbottigliatore" → "Nom et adresse du producteur ou de l’embouteilleur"
* "Volume nominale" → "Volume nominal"
* "Titolo alcolometrico" → "Titre alcoométrique"
* "Indicazione allergeni" → "Indication des allergènes"
* "Lotto" → "Lot"
* "QR code o link ingredienti/energia" → "QR code ou lien ingrédients/énergie"
* "Lingua corretta per il mercato UE" → "Langue correcte pour le marché UE"
* "Altezza minima dei caratteri" → "Hauteur minimale des caractères"
* "Contrasto testo/sfondo adeguato" → "Contraste texte/fond adéquat"
* "Valutazione finale" → "Évaluation finale"
* "Conforme" → "Conforme"
* "Parzialmente conforme" → "Partiellement conforme"
* "Non conforme" → "Non conforme"

🇬🇧 **Inglese**

* "Conformità normativa" → "Regulatory compliance"
* "Denominazione di origine" → "Designation of origin"
* "Nome e indirizzo del produttore o imbottigliatore" → "Producer or bottler name and address"
* "Volume nominale" → "Nominal volume"
* "Titolo alcolometrico" → "Alcohol by volume"
* "Indicazione allergeni" → "Allergen indication"
* "Lotto" → "Batch code"
* "QR code o link ingredienti/energia" → "QR code or link to ingredients/energy"
* "Lingua corretta per il mercato UE" → "Correct language for EU market"
* "Altezza minima dei caratteri" → "Minimum character height"
* "Contrasto testo/sfondo adeguato" → "Adequate text/background contrast"
* "Valutazione finale" → "Final assessment"
* "Conforme" → "Compliant"
* "Parzialmente conforme" → "Partially compliant"
* "Non conforme" → "Non-compliant"

Non usare parole italiane in nessun caso. Tutto il testo deve essere nella lingua selezionata, inclusi i titoli, i campi e le opzioni di valutazione.\u00a0\u00a0\u00a0\u00a0`
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Analizza questa etichetta di vino in ${language}. Fornisci il report nel formato richiesto.` },
            ...userContent
          ],
        },
      ],
    });

    let analysis = response.choices[0].message.content || "Nessuna risposta dall'IA.";
    analysis = normalizeAnalysis(analysis);

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
    const testImage = Buffer.from(
      "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      "base64"
    );
    const [result] = await visionClient.textDetection({
      image: { content: testImage },
    });
    const text = result.fullTextAnnotation?.text || "(nessun testo rilevato)";
    res.send(`<h2>Google Vision API: OK</h2><p><strong>Risultato OCR:</strong> "${text}"</p><p><em>Se vedi questo, Vision funziona al 100%!</em></p><hr><p>Puoi rimuovere questo endpoint in produzione.</p>`);
  } catch (err) {
    console.error("Test Vision fallito:", err.message);
    res.status(500).send(`<h2>Errore Google Vision</h2><pre>${err.message}</pre><p>Controlla:</p><ul><li>API Vision abilitata?</li><li>Service Account con ruolo <code>Cloud Vision API User</code>?</li><li>Chiave JSON completa in <code>GOOGLE_APPLICATION_CREDENTIALS_JSON</code>?</li></ul>`);
  }
});

// === START ===
app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck LIVE su http://0.0.0.0:${port}`);
  console.log(`URL: https://ultracheck.onrender.com`);
});
