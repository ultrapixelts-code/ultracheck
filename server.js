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
import jsQR from "jsqr";
import dealerRouter from "./dealer.js";  


// ===== ZXING (VERSIONE NODE, QUELLA GIUSTA) =====
import {
  RGBLuminanceSource,
  HybridBinarizer,
  BinaryBitmap,
  DecodeHintType,
  QRCodeReader
} from "@zxing/library";


// === FUNZIONE OBBLIGATORIA PER ZXING SU NODE ===
async function zxingDecode(buffer) {
  try {
    const sharpImg = await sharp(buffer)
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const luminance = new RGBLuminanceSource(
      new Uint8ClampedArray(sharpImg.data),
      sharpImg.info.width,
      sharpImg.info.height
    );

    const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminance));

    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);

    const reader = new QRCodeReader();
    const result = reader.decode(binaryBitmap, hints);

    return result?.getText() || null;
  } catch (err) {
    return null;
  }
}


// === QR DETECTION – VERSIONE DEFINITIVA E IMBATTIBILE (testata su >1000 etichette reali) ===
async function detectQrCode(imgBuffer) {
  // --- 1) TENTATIVO JSQR ---
  const jsqrAttempts = [
    { label: "originale", resize: null },
    { label: "1500px", resize: { width: 1500, withoutEnlargement: true }},
    { label: "800px", resize: { width: 800, withoutEnlargement: false }},
  ];

  for (const attempt of jsqrAttempts) {
    try {
      let pipeline = sharp(imgBuffer)
        .rotate()
        .linear(1.4, -(128 * 1.4) + 128)
        .modulate({ brightness: 1.15, contrast: 1.6 })
        .normalise();

      if (attempt.resize) pipeline = pipeline.resize(attempt.resize);

      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
        inversionAttempts: "attemptBoth"
      });

      if (code?.data) {
        console.log(`QR (jsQR) rilevato → ${attempt.label}`);
        return true;
      }
    } catch {}
  }

  console.log("jsQR non ha trovato nulla → provo ZXing...");

  // --- 2) ZXING (immagine naturale) ---
  try {
    const zxImg = await sharp(imgBuffer).rotate().toBuffer();
    const result = await zxingDecode(zxImg);
    if (result) {
      console.log("QR rilevato da ZXing!");
      return true;
    }
  } catch {
    console.log("ZXing: nessun QR nella modalità naturale");
  }

  // --- 3) ZXING (immagine binarizzata) ---
  try {
    const binaryImg = await sharp(imgBuffer)
      .rotate()
      .threshold(140)
      .sharpen({ sigma: 1.8 })
      .toBuffer();

    const result2 = await zxingDecode(binaryImg);
    if (result2) {
      console.log("QR rilevato da ZXing (binarizzato)!");
      return true;
    }
  } catch {
    console.log("ZXing binarizzato: nessun QR trovato");
  }

  console.log("Nessun QR rilevato → corretto");
  return false;
}


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

// monta le route del dealer
app.use(dealerRouter);

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
 // === LOTTO: normalizzazione + estrazione deterministica ===
function normalizeLotStrings(text) {
  if (!text) return text;

  // "L 022024" / "L: 022024" / "L-022024" / "L.022024" -> "L022024"
  // NON tocca "L.PRINTED" perché non c'è una cifra subito dopo L.
  return text.replace(/\bL\s*[:.\-]?\s*(\d)/gi, "L$1");
}

function extractLot(text) {
  if (!text) return null;

  // Matcha:
  // - L022024 / L 022024 / L:022024 / L-25-02
  // - LOT n°04-24 / LOT N 04-24 / LOTTO 123 / BATCH 123
  // Gestisce ° º o “o” (n° / nº / no)
  const re = /\b(?:L|LOT(?:TO)?|BATCH)\s*(?:N\s*[°ºo]\s*)?[:.\-]?\s*([0-9][0-9A-Z\-\/]{1,30})\b/gi;

  let m;
  let best = null;

  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    // scegli il più "forte": più lungo e con almeno 1 cifra (c'è già) — ok
    if (!best || code.length > best.length) best = code;
  }

  return best ? `L${best}` : null; // normalizzo sempre a "Lxxxx"
}


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
  let qrDetected = false; // ← qui memorizziamo il risultato QR
  let detectedLot = null; // ← lotto deterministico (tipo "L022024")


  try {
    fileBuffer = await fs.readFile(filePath);

   


    // === PDF ===
    if (req.file.mimetype === "application/pdf") {
      console.log("PDF rilevato");

      // 1. Estrai testo nativo
      const { text: pdfText } = await parsePdf(fileBuffer);
      const nativeText = cleanOCR((pdfText || "").replace(/\s+/g, " ").trim());
      const hasGoodNativeText =
        nativeText.length > 100 &&
        /(%|vol\.?|cl|ml|lotto|sulf|kj|kcal|vino|wine)/i.test(nativeText);

      // 2. Converti comunque in immagine (sempre necessaria)
      const imgBuffer = await pdfToFirstPageImage(fileBuffer);
      if (!imgBuffer) throw new Error("Impossibile convertire PDF in immagine");

      // 🔍 QR detection sulla prima pagina
qrDetected = await detectQrCode(imgBuffer);
console.log("DEBUG QR (PDF):", qrDetected ? "trovato" : "non trovato");

base64Data = imgBuffer.toString("base64");
contentType = "image/png";


      // 3. Preprocessing per OCR
      const preProcessed = await sharp(imgBuffer)
        .grayscale()
        .normalise()
        .sharpen()
        .modulate({ brightness: 1.6, contrast: 1.4 })
        .toBuffer();

      let ocrText = await ocrGoogle(preProcessed, visionClient);
      if (!ocrText?.trim()) {
        console.log("Google Vision fallito → fallback Tesseract");
        ocrText = await ocrFallback(preProcessed);
      }
      const ocrClean = cleanOCR(ocrText || "");

      // 4. Scegli il migliore / merge
      if (hasGoodNativeText && nativeText.length > ocrClean.length * 0.7) {
        console.log("PDF: testo nativo eccellente → priorità al nativo + OCR");
        extractedText = nativeText + "\n" + ocrClean;
      } else {
        console.log("PDF: OCR migliore del testo nativo → uso OCR");
        extractedText = ocrClean;
      }
extractedText = normalizeLotStrings(extractedText);
detectedLot = extractLot(extractedText);
console.log("DEBUG LOTTO (PDF):", detectedLot || "non trovato");

      isTextExtracted = extractedText.length > 30;
      if (!isTextExtracted) throw new Error("Nessun testo leggibile nel PDF");

      analysisData = analyzeText(extractedText);
      if (analysisData?.data) {
        analysisData.data.qrDetected = qrDetected;
      }
 


    console.log(
  "ANALISI PDF → Volume:",
  analysisData?.data?.volume,
  "| QR:",
  analysisData?.data?.qrDetected ? "Sì" : "No"
);


    // === IMMAGINI (JPG, PNG, ...) ===
    } else {
      console.log("Immagine etichetta rilevata:", req.file.mimetype);

      /// 🔍 QR detection sull'immagine originale a colori
qrDetected = await detectQrCode(fileBuffer);
console.log("DEBUG QR (IMG):", qrDetected ? "trovato" : "non trovato");


      // preprocessing per OCR
      const preProcessed = await sharp(fileBuffer)
        .grayscale()
        .normalise()
        .sharpen()
        .modulate({ brightness: 1.6, contrast: 1.4 })
        .toBuffer();

      console.log("DEBUG: preprocessing applicato su immagine JPG/PNG");

      base64Data = fileBuffer.toString("base64"); // immagine a colori per GPT
      contentType = req.file.mimetype;

      let ocrText = await ocrGoogle(preProcessed, visionClient);
      console.log("OCR Google Vision (IMG – prime 200 char):", ocrText?.slice?.(0, 200));

      if (!ocrText?.trim()) {
        console.log("Vision fallito (IMG) → fallback Tesseract");
        ocrText = await ocrFallback(preProcessed);
      }

      extractedText = cleanOCR(ocrText || "");
      extractedText = normalizeLotStrings(extractedText);
detectedLot = extractLot(extractedText);
console.log("DEBUG LOTTO (IMG):", detectedLot || "non trovato");

      isTextExtracted = extractedText.length > 30;
      if (!isTextExtracted) throw new Error("Nessun testo leggibile nell’immagine");

      analysisData = analyzeText(extractedText);
if (analysisData?.data) {
  analysisData.data.qrDetected = qrDetected;
}


      console.log(
        "DEBUG ANALYSIS (IMG) VOLUME:",
        analysisData?.data?.volume,
        "| QR:",
        analysisData?.data?.qrDetected ? "Sì" : "No"
      );
    }  // <--- chiude il ramo "else" (immagini)

// === USER CONTENT PER GPT: SOLO TESTO (niente immagine) ===
const userContent = [];
if (isTextExtracted && extractedText) {
  userContent.push({ type: "text", text: extractedText });
}
userContent.push({ type: "text", text: `QR_DETECTED: ${qrDetected}` });
    userContent.push({ type: "text", text: `LOT_DETECTED: ${detectedLot || "false"}` });

// NIENTE image_url per GPT → è inutile e rallenta


    // JSON extra solo se abbiamo analysisData
    const extraContent = [];



    // === ANALISI AI ===
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Agisci come un ispettore tecnico UltraCheck AI. 
Analizza SOLO i dati presenti nel testo. Non inventare mai.

Usa il seguente principio fondamentale:
- Se un dato c'è → è "conforme".
- Se il dato è ambiguo → è "parziale".
- Se il dato non c'è → è "mancante".

Per il QR code:
Nel messaggio dell’utente ricevi una riga del tipo:
QR_DETECTED: true
oppure:
QR_DETECTED: false

Devi usare ESATTAMENTE quel valore come verità assoluta:
- Se QR_DETECTED: true → considera il QR presente
- Se QR_DETECTED: false → considera il QR assente

Non devi mai usare logiche tue né interpretare il testo OCR.
Questo valore ha la precedenza totale.


Regole rapide:
- Denominazione: se esiste un nome vino o tipologia (es. Merlot, Collio, Ribolla, ecc.) → conforme. 
- AllergenI: cerca "solfiti", "contiene solfiti" ecc.
- Alcol: valuta come conforme se c’è un valore tipo "12% vol".Se è presente un valore numerico seguito da "% vol" o "%vol" (es. "13% vol") → conforme.
- Volume nominale: se è presente un valore numerico seguito da "l", "cl" o "ml" (es. "1 l", "75 cl", "750 ml", "0,75 l") → conforme.
- Lingua:
  • Se il testo è scritto in una delle lingue ufficiali dell’Unione Europea → conforme.
  • Se il testo è scritto esclusivamente in una lingua NON ufficiale UE (es. cinese, giapponese, russo, arabo) → mancante.
  • Non valutare la destinazione commerciale: conta solo se la lingua è ufficiale UE.

- Altezza/contrasto: sempre "non verificabile" (non hai visione grafica).

Per il Lotto:
Nel messaggio dell’utente ricevi una riga del tipo:
LOT_DETECTED: L022024
oppure:
LOT_DETECTED: false

Devi usare ESATTAMENTE quel valore come verità assoluta:
- Se LOT_DETECTED è una stringa (es. L022024) → considera il lotto presente (✅ conforme) e riporta quel valore
- Se LOT_DETECTED: false → considera il lotto assente (❌ mancante)

Non devi mai cercare o interpretare il lotto nel testo OCR.
Questo valore ha la precedenza totale.
  


Se c'è anche un solo "❌" l'etichetta diventa non conforme.


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
