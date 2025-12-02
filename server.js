// server.js — VERSIONE DEFINITIVA 2025 — UltraCheck PRO
import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { pdfToFirstPageImage } from "./pdf.js";
import { ocrGoogle, ocrFallback } from "./ocr.js";
import { cleanOCR } from "./cleanOCR.js";
import { extractData } from "./extract.js";
import { applyRules } from "./rules.js";

if (process.env.NODE_ENV !== "production") dotenv.config();

console.log("UltraCheck v2025 — Avvio...");

// === GOOGLE VISION ===
let visionClient = null;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    visionClient = new ImageAnnotatorClient({ credentials: creds });
    console.log("Google Vision: configurato");
  } catch (err) {
    console.error("Google Vision: errore JSON →", err.message);
  }
}

const app = express();
const port = process.env.PORT || 8080;

app.use(express.static(".")); // o crea una cartella /public
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.sendFile(path.join(process.cwd(), "index.html")));
app.get("/ultracheck", (req, res) => res.sendFile(path.join(process.cwd(), "ultracheck.html")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === ROUTE PRINCIPALE /analyze — VERSIONE PERFETTA ===
app.post("/analyze", upload.single("label"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "Nessun file." });

  const { azienda = "", nome = "", email = "", telefono = "", lang = "it" } = req.body;

  try {
    const fileBuffer = await fs.readFile(filePath);

    // 1. OCR unificato (PDF → immagine o immagine diretta)
    const imgBuffer = req.file.mimetype === "application/pdf"
      ? await pdfToFirstPageImage(fileBuffer)
      : fileBuffer;

    if (!imgBuffer) throw new Error("Impossibile convertire il file");

    let ocrText = await ocrGoogle(imgBuffer, visionClient);
    if (!ocrText?.trim()) {
      console.log("Vision fallito → Tesseract");
      ocrText = await ocrFallback(imgBuffer);
    }

    const extractedText = cleanOCR(ocrText || "");
    if (extractedText.length < 30) throw new Error("Nessun testo leggibile");

    // 2. Estrazione dati + regole (il tuo lavoro perfetto!)
    const data = extractData(extractedText);
    const ruleResults = applyRules(data);

    // 3. GPT con prompt FERREO → usa SOLO i dati estratti
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `Sei UltraCheck AI — ispettore automatico etichette vino (Reg. UE 2021/2117).
Usa ESCLUSIVAMENTE questi dati. Non guardare altro.

DATI CERTI:
- Denominazione: ${data.denomination ? data.denomination.type + " " + data.denomination.name : "non rilevata"}
- Produttore: ${data.producer || "non rilevato"}
- Volume: ${data.volume ? data.volume + " L" : "non rilevato"}
- Alcol: ${data.alcohol ? data.alcohol + "% vol" : "non rilevato"}
- Allergeni: ${data.allergens.length ? data.allergens.join(", ") : "non dichiarati"}
- Lotto: ${data.lot || "non rilevato"}
- QR: ${data.qrDetected ? "rilevato" : "non presente"}

Rispondi ESATTAMENTE così (lingua: ${lang}):

===============================
### Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (${data.denomination ? "conforme" : "mancante"}) + ${data.denomination ? data.denomination.type + " " + data.denomination.name : "non rilevata"}
Nome e indirizzo del produttore o imbottigliatore: (${data.producer ? "conforme" : "mancante"}) + ${data.producer || "non rilevato"}
Volume nominale: (${data.volume ? "conforme" : "mancante"}) + ${data.volume ? data.volume + " L" : "non rilevato"}
Titolo alcolometrico: (${data.alcohol ? "conforme" : "mancante"}) + ${data.alcohol ? data.alcohol + "% vol" : "non rilevato"}
Indicazione allergeni: (${data.allergens.length ? "conforme" : "mancante"}) + ${data.allergens.length ? data.allergens.join(", ") : "non dichiarati"}
Lotto: (${data.lot ? "conforme" : "mancante"}) + ${data.lot || "non rilevato"}
QR code o link ingredienti/energia: (${data.qrDetected ? "conforme" : "mancante"}) + ${data.qrDetected ? "rilevato" : "non presente"}
Lingua corretta per il mercato UE: (parziale) + multilingue rilevata
Altezza minima dei caratteri: (non verificabile) + non misurabile automaticamente
Contrasto testo/sfondo adeguato: (non verificabile) + non misurabile automaticamente

**Valutazione finale:** ${ruleResults.some(r => r.level === "error") ? "Non conforme" : ruleResults.some(r => r.level === "warning") ? "Parzialmente conforme" : "Conforme"}
===============================
Tieni la valutazione coerente con la presenza o assenza reale dei campi.`
        },
        { role: "user", content: "Genera il report." }
      ]
    });

    let analysis = response.choices[0].message.content.trim();

    // Traduzione se necessario
    if (lang !== "it") {
      const tr = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: `Traduci in ${lang === "fr" ? "francese" : "inglese"} mantenendo esattamente il markdown.` },
          { role: "user", content: analysis }
        ]
      });
      analysis = tr.choices[0].message.content.trim();
    }

    // Email (opzionale)
    if (fileBuffer && process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: process.env.MAIL_TO,
        from: "gabriele.russian@ultrapixel.it",
        subject: `UltraCheck: ${azienda || "Analisi"}`,
        text: `Analisi completata\n\n${analysis}`,
        attachments: [{
          content: fileBuffer.toString("base64"),
          filename: req.file.originalname,
          type: req.file.mimetype,
          disposition: "attachment"
        }]
      });
    }

    res.json({ result: analysis });

  } catch (error) {
    console.error("Errore:", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});

// === TEST VISION ===
app.get("/test-vision", async (req, res) => {
  if (!visionClient) return res.status(500).send("Google Vision non configurato");
  try {
    const [result] = await visionClient.textDetection({
      image: { content: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64") }
    });
    res.send(`Google Vision OK — Testo rilevato: "${result.fullTextAnnotation?.text || "(vuoto)"}"`);
  } catch (err) {
    res.status(500).send(`Errore Vision: ${err.message}`);
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck 2025 LIVE su porta ${port}`);
  console.log(`https://ultracheck.onrender.com`);
});
