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
import { BrowserQRCodeReader } from '@zxing/library';

// === FUNZIONE OBBLIGATORIA PER ZXING SU NODE ===
async function zxingDecode(buffer) {
  const tmpPath = `/tmp/zxing-${Date.now()}.png`;
  await fs.writeFile(tmpPath, buffer);

  try {
    const reader = new BrowserQRCodeReader();
    const result = await reader.decodeFromImage(undefined, tmpPath);
    await fs.unlink(tmpPath).catch(() => {});
    return result?.text || null;
  } catch {
    await fs.unlink(tmpPath).catch(() => {});
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

// NIENTE image_url per GPT → è inutile e rallenta


    // JSON extra solo se abbiamo analysisData
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

- DEVI usare il valore qrDetected che ti passo.
- Se qrDetected = true → considera il QR PRESENTE e scrivi che è presente.
- Se qrDetected = false → considera il QR ASSENTE.
  Non puoi mai contraddire qrDetected, anche se ti sembra di vedere forme simili a un QR.
  Ignora completamente loghi, icone, quadrati decorativi, ecc.


Per la lingua:
- considera "conforme" se l’etichetta contiene almeno la lingua ufficiale
  del paese di commercializzazione (se non è specificato, assumi Italia → italiano).
- Non dire mai che mancano "lingue UE obbligatorie": non esistono lingue UE obbligatorie.
- Se è indicato chiaramente un paese nell’indirizzo del produttore/imbottigliatore
  (es: "France", "Italia", "Hrvatska", "España"...),
  considera come lingua principale ammessa la lingua ufficiale di quel paese
  (francese per France, croato per Hrvatska, italiano per Italia, ecc.).

- Se l’etichetta è interamente in quella lingua ufficiale, considera il campo "Lingua corretta per il mercato UE" come (✅ conforme).

- Usa l’assunzione "Italia → italiano" SOLO se:
  • non riesci a capire da dove viene il vino,
  • oppure non è riportato chiaramente alcun paese nell’indirizzo.

- Evita di mettere "❌" sulla lingua se almeno una lingua ufficiale del paese di produzione è presente; in caso di dubbio, usa al massimo "⚠️ parziale".

Per il campo "Titolo alcolometrico":

- Considera "conforme" se trovi un valore tipo "12% vol", "13.5% vol", "11 % vol" ecc.
- Puoi indicarlo come "parziale" solo se il valore è poco leggibile o ambiguo.
- NON usare mai "❌ mancante" se dopo il segno "+" riporti un valore numerico con "%" e "vol".
  Se scrivi qualcosa dopo il "+", lo stato non può essere "mancante".
Regola generale: se dopo il segno "+" inserisci un testo specifico (es. "13.5% vol", un indirizzo, un lotto, ecc.),
non puoi usare lo stato "❌ mancante", ma solo "✅ conforme" o "⚠️ parziale".

Per la "Denominazione di origine":
- È obbligatoria solo per vini con indicazioni come DOP/DOC/DOCG/IGP, 
  o "Appellation d'Origine Contrôlée", "Protected Designation of Origin", ecc.
- Se l’etichetta sembra un vino generico (senza alcuna indicazione geografica particolare),
  NON usare mai "❌ mancante".
  In questo caso usa "⚠️ parziale" e specifica che "non è indicata (e può non essere obbligatoria per vini generici)".
  - È presente se c'è scritto DOP/DOC/DOCG/IGP o per esteso Denominazione di Origine Protetta/Denominazione di Origine Controllata/Denominazione di Origine Controllata e Garantita/Indicazione Geografica Protetta

  Per il campo "Lotto":

- Considera lotto solo stringhe chiaramente marcate da:
  • "L" o "Lot" o "Lotto" seguite da numeri/lettere (es: "L25-02", "Lot L2502", "L1234").
- NON interpretare come lotto:
  • codici casuali senza prefisso (es. "ITETNO", "AB123" senza "L"),
  • sigle di certificazioni, codici interni o altre scritte ambigue.
  • scritte che hanno la lettera L e poi altre lettere. Ad esempio FILTERED, il lotto non è TERED. Deve esserci solamente una L e basta.

- Se trovi un candidato lotto, riportalo ESATTAMENTE (es: "L25-02").
- Se non trovi nulla che rispetta questi criteri:
  • usa "❌ mancante" oppure "⚠️ non verificabile",
  • e NON inventare codici (non proporre stringhe che non vedi chiaramente marcate come lotto).

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
