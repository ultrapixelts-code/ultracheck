import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import { fromBuffer } from "pdf2pic";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import { ImageAnnotatorClient } from "@google-cloud/vision";

// Inizializza client (usa env per auth)
dotenv.config();
const visionClient = new ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
});

const app = express();
const port = process.env.PORT || 8080;

app.use(express.static("."));
app.use(express.json());

// Serve pagina principale
app.get("/", (req, res) => {
  res.sendFile("ultracheck.html", { root: "." });
});

// Upload config (10MB max, /tmp per Render)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === UTILITY ===

// Normalizza markdown (Success/Warning/Failed)
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
      const isField = /^[Success|Warning|Failed]/.test(trimmed) || /^[-*]\s+\*\*/.test(trimmed) || /^[-*]\s+[A-ZÀ-Ú]/.test(trimmed);
      if (!isField) return raw;
      const status = statusFor(trimmed);
      if (!status) return raw;
      const clean = trimmed.replace(/^(Success|Warning|Failed)\s*/, "");
      const pad = raw.slice(0, raw.indexOf(trimmed));
      return `${pad}${status} ${clean}`;
    })
    .join("\n");
}

// Caricamento dinamico pdf-parse (IIFE per await top-level)
let pdfParse = null;
(async () => {
  try {
    const lib = await import("pdf-parse");
    pdfParse = lib.default || lib;
    console.log("✅ pdf-parse caricato");
  } catch (err) {
    console.log("⚠️ pdf-parse non disponibile → uso pdftotext CLI");
  }
})();

// Estrai testo PDF (pdf-parse → pdftotext)
async function parsePdf(buffer) {
  if (pdfParse) {
    try {
      const data = await pdfParse(buffer);
      return { text: data.text || "" };
    } catch (err) {
      console.warn("pdf-parse fallito:", err.message);
    }
  }

  // Fallback CLI
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
    [pdfPath, txtPath].forEach(async (p) => fs.unlink(p).catch(() => {}));
  }
}

// PDF → Immagine base64 (con sharp per OCR)
async function pdfToImageBase64(buffer) {
  try {
    const convert = fromBuffer(buffer, { density: 300, format: "png" });
    const page = await convert(1);
    if (!page?.base64) return null;
    const imgBuffer = Buffer.from(page.base64, "base64");
    const enhanced = await sharp(imgBuffer)
      .resize({ width: 2500 })
      .grayscale()
      .normalize()
      .threshold(180)
      .sharpen()
      .toBuffer();
    return enhanced.toString("base64");
  } catch (err) {
    console.warn("pdfToImageBase64 fallita:", err.message);
    return null;
  }
}

// OCR Google Vision
async function ocrGoogle(buffer) {
  try {
    const [result] = await visionClient.textDetection({ image: { content: buffer } });
    const text = result.fullTextAnnotation?.text || "";
    if (text.trim()) console.log("✅ Google Vision OCR:", text.substring(0, 200));
    return text;
  } catch (err) {
    console.warn("❌ Google Vision errore:", err.message);
    return "";
  }
}

// === ENDPOINT /analyze ===
app.post("/analyze", upload.single("label"), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ error: "Nessun file." });

  const { azienda = "", nome = "", email = "", telefono = "", lang = "it" } = req.body;
  const language = lang.toLowerCase();
  let extractedText = "";
  let isTextExtracted = false;
  let base64Data = "";
  let contentType = "";

  try {
    const fileBuffer = await fs.readFile(filePath);

    // PDF handling
    if (req.file.mimetype === "application/pdf") {
      console.log("📄 PDF → estrai testo nativo...");
      const { text } = await parsePdf(fileBuffer);
      if (text.trim().length > 30) {
        extractedText = text;
        isTextExtracted = true;
        console.log("✅ Testo nativo estratto");
      }

      // Fallback OCR se testo scarso
      if (!isTextExtracted) {
        const imageBase64 = await pdfToImageBase64(fileBuffer);
        if (!imageBase64) throw new Error("PDF non convertibile");
        const imgBuffer = Buffer.from(imageBase64, "base64");

        // 🔹 Google Vision PRIORITARIO
        let ocrText = await ocrGoogle(imgBuffer);
        if (ocrText.trim().length > 30) {
          extractedText = ocrText;
          isTextExtracted = true;
        } else {
          // 🔸 Tesseract backup
          console.log("⚠️ Google insufficiente → Tesseract...");
          const { data: { text } } = await Tesseract.recognize(imgBuffer, "eng+ita+fra+deu", {
            tessedit_pageseg_mode: "3",
            tessedit_ocr_engine_mode: "1",
          });
          if (text.trim().length > 30) {
            extractedText = text;
            isTextExtracted = true;
          } else {
            base64Data = imageBase64;
            contentType = "image/png";
          }
        }
      }

      // Normalizza testo
      if (isTextExtracted) {
        extractedText = extractedText
          .replace(/m\s*l/gi, "ml")
          .replace(/c\s*l/gi, "cl")
          .replace(/%[\s]*v[\s]*ol/gi, "% vol");
      }
    } else {
      // Immagine diretta
      base64Data = fileBuffer.toString("base64");
      contentType = req.file.mimetype;
    }

    // Prepara per AI
    if (isTextExtracted) {
      base64Data = Buffer.from(extractedText).toString("base64");
      contentType = "text/plain";
    }

    // OpenAI analysis
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Sei UltraCheck AI, esperto di etichette vino UE 2021/2117.
Analizza solo elementi obbligatori. Non inventare. Se illeggibile: "non verificabile".
Formato markdown esatto, lingua: ${language}.
Se un solo ❌: "Non conforme".

### 🔎 Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (✅/⚠️/❌) + testo
Nome e indirizzo produttore/imbottigliatore: (✅/⚠️/❌) + testo
Volume nominale: (✅/⚠️/❌) + testo
Titolo alcolometrico: (✅/⚠️/❌) + testo
Allergeni: (✅/⚠️/❌) + testo
Lotto: (✅/⚠️/❌) + testo
QR/link ingredienti: (✅/⚠️/❌) + testo
Lingua UE: (✅/⚠️/❌) + testo
Altezza caratteri: (✅/⚠️/❌) + testo
Contrasto: (✅/⚠️/❌) + testo
**Valutazione finale:** Conforme / Parzialmente / Non conforme`,
        },
        {
          role: "system",
          content: `Se ${language}="fr", traduci tutto in francese (es. "Conformité réglementaire"). Se "en", in inglese ("Regulatory compliance"). Non mescolare.`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: `Analizza etichetta vino in ${language}.` },
            isTextExtracted
              ? { type: "text", text: extractedText }
              : { type: "image_url", image_url: { url: `data:${contentType};base64,${base64Data}` } },
          ],
        },
      ],
    });

    let analysis = response.choices[0].message.content || "No AI response.";
    analysis = normalizeAnalysis(analysis);

    // Email (opzionale)
    if (process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      const msg = {
        to: process.env.MAIL_TO,
        from: "noreply@ultracheck.ai",
        subject: `UltraCheck: ${azienda || "Analisi"}`,
        text: `Azienda: ${azienda}\nNome: ${nome}\nEmail: ${email}\nTelefono: ${telefono}\n\n${analysis}`,
        attachments: [{ content: fileBuffer.toString("base64"), filename: req.file.originalname, type: req.file.mimetype }],
      };
      await sgMail.send(msg);
      console.log("📧 Email inviata");
    }

    res.json({ result: analysis });
  } catch (error) {
    console.error("❌ Errore:", error.message);
    res.status(500).json({ error: "Elaborazione fallita: " + error.message });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});

// Avvio
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 UltraCheck su http://0.0.0.0:${port}`);
});
