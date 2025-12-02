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
import { parsePdf, pdfToFirstPageImage } from "./pdf.js";
import { ocrGoogle, ocrFallback } from "./ocr.js";
import { cleanOCR } from "./cleanOCR.js";
import { extractData } from "./extract.js";
import { applyRules } from "./rules.js";
import { analyzeText } from "./analyze.js";



console.log("DEBUG: Deploy v3");

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
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // AGGIUNTA

// Homepage → index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

// Rotta per ultracheck.html
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
      const isField =
        /^(Success|Warning|Failed)\b/.test(trimmed) ||
        /^[-*]\s+[^\s]/.test(trimmed) ||
        /^[-*]\s+[A-ZÀ-Ú]/.test(trimmed);
      if (!isField) return raw;
      const status = statusFor(trimmed);
      if (!status) return raw;
      const clean = trimmed.replace(/^(Success|Warning|Failed)\s*/, "");
      const pad = raw.slice(0, raw.indexOf(trimmed));
      return `${pad}${status} ${clean}`;
    })
    .join("\n");
}

// === /analyze ===
app.post("/analyze", upload.single("label"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "Nessun file." });

  const { azienda = "", nome = "", email = "", telefono = "", lang = "it" } = req.body;
  console.log("Lingua richiesta:", lang);

  let fileBuffer = null;
  let extractedText = "";
  let isTextExtracted = false;
  let base64Data = "";
  let contentType = "";
  let analysisData = null;

  try {
    fileBuffer = await fs.readFile(filePath);

    // === PDF ===
    if (req.file.mimetype === "application/pdf") {
      console.log("PDF rilevato");
      const { text } = await parsePdf(fileBuffer);
      const cleanText = text?.replace(/\s+/g, " ").trim() || "";

      // per ora forziamo SEMPRE OCR
      const hasUsefulText = false;

      if (hasUsefulText && cleanText.length > 30) {
        extractedText = cleanOCR(cleanText);
        isTextExtracted = true;
        console.log("Testo nativo estratto (sufficiente)");
      } else {
        console.log("Testo nativo scarso o assente → OCR forzato");
        const imgBuffer = await pdfToFirstPageImage(fileBuffer);

        if (imgBuffer) {
          // salviamo anche l’immagine per GPT
          base64Data = imgBuffer.toString("base64");
          contentType = "image/png"; // pdfToFirstPageImage di solito genera PNG

          let ocrText = await ocrGoogle(imgBuffer, visionClient);
          console.log("OCR Google Vision (prime 200 char):", ocrText?.slice?.(0, 200));

          if (!ocrText?.trim()) {
            console.log("Google Vision fallito → OCR fallback Tesseract");
            ocrText = await ocrFallback(imgBuffer);
          }

          extractedText = cleanOCR(ocrText || "");
          isTextExtracted = extractedText.length > 30;

          if (extractedText) {
            const snippet = extractedText
              .toLowerCase()
              .replace(/\s+/g, " ")
              .match(/.{0,40}75.{0,40}/g);
            console.log("DEBUG VOLUME SNIPPET:", snippet);
          }
        }
      }

      if (!isTextExtracted) {
        throw new Error("Nessun testo leggibile nel PDF");
      }

      // estrazione strutturata (volume, lotto, ecc.)
      analysisData = analyzeText(extractedText);
      console.log("DEBUG ANALYSIS VOLUME:", analysisData?.data?.volume);

    // === IMMAGINI (JPG, PNG, ...) ===
    } else {
      base64Data = fileBuffer.toString("base64");
      contentType = req.file.mimetype;
      // per ora sulle immagini lasciamo GPT fare tutto con immagine+testo grezzo,
      // se vuoi puoi aggiungere anche qui analyzeText in futuro
    }

    // === USER CONTENT PER GPT: testo + immagine (se presenti) ===
    const userContent = [];
    if (isTextExtracted && extractedText) {
      userContent.push({ type: "text", text: extractedText });
    }
    if (base64Data && contentType) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${contentType};base64,${base64Data}`,
        },
      });
    }

    // JSON extra solo se abbiamo analysisData (PDF con testo)
    const extraContent = analysisData
      ? [
          {
            type: "text",
            text:
              "Dati estratti automaticamente:\n" +
              JSON.stringify(analysisData.data, null, 2),
          },
          {
            type: "text",
            text:
              "Esito regole normative:\n" +
              JSON.stringify(analysisData.rules, null, 2),
          },
        ]
      : [];

    // === ANALISI AI ===
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Agisci come un ispettore tecnico *UltraCheck AI* specializzato nella conformità legale delle etichette vino.
Analizza SOLO le informazioni obbligatorie secondo il **Regolamento (UE) 2021/2117**.
Non inventare mai dati visivi: se qualcosa non è leggibile, scrivi "non verificabile".

Per il campo "QR code o link ingredienti/energia":

- Usa prima il valore qrDetected che ti passo.
- Se qrDetected = false, puoi considerare un QR presente SOLO se:
  • individui chiaramente i tre “finder pattern” tipici dei QR (tre quadrati neri negli angoli),
  • e puoi descrivere esattamente la posizione del QR (es: "in basso a destra").

- Se vedi un quadrato nero o un simbolo grafico che NON presenta i tre finder pattern,
  NON considerarlo un QR.
  Esempi da NON considerare QR: loghi, icone, simboli, forme geometriche, pattern decorativi.

- NON considerare QR: riquadri neri pieni, loghi, simboli stilizzati o figure con forme interne.
- Considera QR solo se la struttura è inequivocabile e conforme ai QR standard.

Per la lingua:
- considera "conforme" se l’etichetta contiene almeno la lingua ufficiale
  del paese di commercializzazione (se non è specificato, assumi Italia → italiano).
- Non dire mai che mancano "lingue UE obbligatorie": non esistono lingue UE obbligatorie.



Devi rispondere esclusivamente nella lingua: ${req.body.lang || "it"}.
Non usare mai altre lingue o traduzioni.

Rispondi nel formato markdown esatto qui sotto:

===============================
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
===============================

Tieni la valutazione coerente con la presenza o assenza reale dei campi.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analizza questa etichetta di vino e valuta solo la conformità legale." },
            ...userContent,
            ...extraContent,
          ],
        },
      ],
    });

    let analysis = response.choices[0].message.content || "Nessuna risposta dall'IA.";
    analysis = normalizeAnalysis(analysis);

    // 🌍 Traduzione se serve
    if (lang !== "it" && /Denominazione|Produttore|Volume nominale|Titolo alcolometrico/i.test(analysis)) {
      console.log("Traduzione automatica forzata →", lang);

      const translations = {
        fr: "Traduis intégralement ce texte en français sans rien ajouter ni reformuler.",
        en: "Translate this entire text into English without adding or rephrasing anything.",
      };

      const translatePrompt = translations[lang] || null;

      if (translatePrompt) {
        const trRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: "You are a precise translator preserving formatting and markdown." },
            { role: "user", content: `${translatePrompt}\n\n${analysis}` },
          ],
        });
        analysis = trRes.choices[0].message.content || analysis;
      }
    }

    // === EMAIL ===
    if (fileBuffer && process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      try {
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);

        await sgMail.send({
          to: process.env.MAIL_TO,
          from: "gabriele.russian@ultrapixel.it",
          subject: `UltraCheck: ${azienda || "Analisi etichetta"}`,
          text: `
Analisi completata per:

• Nome: ${nome || "(non fornito)"}
• Azienda: ${azienda || "(non fornita)"}
• Email: ${email || "(non fornita)"}
• Telefono: ${telefono || "(non fornito)"}

-----------------------------
RISULTATO ANALISI:
-----------------------------

${analysis}
          `,
          attachments: [
            {
              content: fileBuffer.toString("base64"),
              filename: req.file.originalname,
              type: req.file.mimetype,
              disposition: "attachment",
            },
          ],
        });

        console.log("📧 Email inviata a", process.env.MAIL_TO);
      } catch (err) {
        console.warn("❌ Email fallita:", err.message);
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
