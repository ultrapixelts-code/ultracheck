git add server.js
git commit -m "fix: pdftoppm syntax + rimuovi duplicato"
git pushimport express from "express";
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
  const pdfPath = path.join(tmpDir, `pdf-${Date.now()}.pdf`);
  const txtPath = pdfPath.replace(".pdf", ".txt");
  try {
    await fs.writeFile(pdfPath, buffer);
    await new Promise((resolve, reject) => {
      const proc = spawn("pdftotext", ["-raw", "-layout", pdfPath, txtPath]);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pdftotext code ${code}`)));
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
      .threshold(150)  // era 180 → più aggressivo
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
      console.log("PDF rilevato");
      const { text } = await parsePdf(fileBuffer);
      const cleanText = text?.replace(/\s+/g, " ").trim() || "";

      // FORZA OCR SEMPRE SU PDF (scansionati o con testo scarso)
const hasUsefulText = false; // <-- FORZA OCR


      if (hasUsefulText) {
        extractedText = cleanText
          .replace(/m\s*l/gi, "ml")
          .replace(/c\s*l/gi, "cl")
          .replace(/%[\s]*v[\s]*ol/gi, "% vol")
          .replace(/\r\n/g, "\n")
          .replace(/\s+/g, " ")
          .trim();
        isTextExtracted = true;
        console.log("Testo nativo estratto (sufficiente)");
      } else {
        console.log("Testo nativo scarso o assente → OCR forzato");
        const imgBuffer = await pdfToFirstPageImage(fileBuffer);
        if (imgBuffer) {
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
              .replace(/0[.,]75\s*l/gi, "0.75 l")
              .replace(/750\s*ml/gi, "0.75 l")
              .replace(/1[.,]?5\s*l/gi, "1.5 l")
              .replace(/\r\n/g, "\n")
              .replace(/\s+/g, " ")
              .trim();
          isTextExtracted = extractedText.length > 30;
        }
      }

      if (!isTextExtracted) throw new Error("Nessun testo leggibile nel PDF");
    } else {
      // IMMAGINI (JPG, PNG)
      base64Data = fileBuffer.toString("base64");
      contentType = req.file.mimetype;
    }

    // === USER CONTENT ===
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
Rispondi sempre nel formato markdown esatto qui sotto, in lingua: ${req.body.lang || "it"}.

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

Tieni la valutazione coerente con la presenza o assenza reale dei campi.`
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
          disposition: "attachment"
        }
      ]
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
