import express from "express";
import multer from "multer";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import OpenAI from "openai";
import dotenv from "dotenv";
if (!process.env.RENDER) {
  // solo in locale
  dotenv.config();
}
import sgMail from "@sendgrid/mail";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import { ImageAnnotatorClient } from "@google-cloud/vision";

// Inizializza
dotenv.config();
// Google Vision con JSON inline (Render-friendly)
const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

const visionClient = new ImageAnnotatorClient({
  credentials: creds
});


const app = express();
const port = process.env.PORT || 8080;

app.use(express.static("."));
app.use(express.json());

app.get("/", (req, res) => {
  res.sendFile("ultracheck.html", { root: "." });
});

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

// pdf-parse dinamico
let pdfParse = null;
(async () => {
  try {
    const lib = await import("pdf-parse");
    pdfParse = lib.default || lib;
    console.log("pdf-parse caricato");
  } catch (err) {
    console.log("pdf-parse non disponibile → uso pdftotext");
  }
})();

// Estrai testo nativo
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
    [pdfPath, txtPath].forEach(async (p) => fs.unlink(p).catch(() => {}));
  }
}

// PDF → Immagine (pdftoppm)
async function pdfToImageBase64(buffer) {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `pdf-${Date.now()}.pdf`);
  const pngPath = path.join(tmpDir, `page-${Date.now()}.png`);

  try {
    await fs.writeFile(pdfPath, buffer);

    await new Promise((resolve, reject) => {
      const proc = spawn("pdftoppm", [
        "-png", "-f", "1", "-l", "1", "-r", "300",
        pdfPath, path.join(tmpDir, "page")
      ]);
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pdftoppm exit ${code}`)));
      proc.on("error", reject);
    });

    const imgBuf = await fs.readFile(pngPath);
    const enhanced = await sharp(imgBuf)
      .grayscale()
      .normalize()
      .threshold(180)
      .sharpen()
      .toBuffer();

    console.log("pdftoppm: conversione riuscita");
    return enhanced.toString("base64");
  } catch (err) {
    console.warn("pdftoppm fallito:", err.message);
    return null;
  } finally {
    await fs.unlink(pdfPath).catch(() => {});
    await fs.unlink(pngPath).catch(() => {});
  }
}

// OCR Google Vision
async function ocrGoogle(buffer) {
  try {
    const [result] = await visionClient.textDetection({ image: { content: buffer } });
    const text = result.fullTextAnnotation?.text || "";
    if (text.trim()) console.log("Google Vision OCR:", text.substring(0, 200));
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
  let extractedText = "";
  let isTextExtracted = false;
  let base64Data = "";
  let contentType = "";

  try {
    const fileBuffer = await fs.readFile(filePath);

if (req.file.mimetype === "application/pdf") {
  console.log("📄 PDF rilevato → estrazione testo con pdf-parse...");
  const { text } = await parsePdf(fileBuffer);

  if (text && text.trim().length > 50) {
    // Caso PDF vettoriale → testo nativo trovato
    console.log("✅ Testo vettoriale trovato (pdf-parse).");
    extractedText = text;
    isTextExtracted = true;
  } else {
    // Caso PDF raster → estrai immagine e fai OCR
    console.log("⚙️ Nessun testo nativo → converto PDF in immagine con pdftoppm...");
    const tmpDir = os.tmpdir();
    const pdfPath = path.join(tmpDir, `pdf-${Date.now()}.pdf`);
    const pngPath = path.join(tmpDir, `page-${Date.now()}.png`);
    await fs.writeFile(pdfPath, fileBuffer);

    try {
      await new Promise((resolve, reject) => {
        const proc = spawn("pdftoppm", [
          "-png", "-singlefile", "-r", "300",
          pdfPath, pngPath.replace(".png", "")
        ]);
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pdftoppm code ${code}`)));
        proc.on("error", reject);
      });

      const imgBuffer = await fs.readFile(pngPath);
      console.log("✅ Conversione immagine riuscita, eseguo OCR Google Vision...");
      const ocrText = await ocrGoogle(imgBuffer);

      if (ocrText && ocrText.trim().length > 30) {
        console.log("✅ Testo OCR trovato con Google Vision.");
        extractedText = ocrText;
        isTextExtracted = true;
      } else {
        console.log("⚠️ OCR Google insufficiente, provo Tesseract...");
        const { data: { text: tesseractText } } = await Tesseract.recognize(imgBuffer, "eng+ita+fra+deu");
        extractedText = tesseractText || "";
        isTextExtracted = extractedText.trim().length > 30;
      }
    } finally {
      await fs.unlink(pdfPath).catch(() => {});
      await fs.unlink(pngPath).catch(() => {});
    }
  }

  if (!isTextExtracted) throw new Error("Nessun testo leggibile nel PDF");
  } else {
    base64Data = fileBuffer.toString("base64");
    contentType = req.file.mimetype;
  }

  if (isTextExtracted) {
    extractedText = extractedText
      .replace(/m\s*l/gi, "ml")
      .replace(/c\s*l/gi, "cl")
      .replace(/%[\s]*v[\s]*ol/gi, "% vol");
  }


    if (isTextExtracted) {
      base64Data = Buffer.from(extractedText).toString("base64");
      contentType = "text/plain";
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Sei UltraCheck AI...` // (il tuo prompt)
        },
        {
          role: "system",
          content: `Se ${language}="fr"...`
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

    if (process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: process.env.MAIL_TO,
        from: "noreply@ultracheck.ai",
        subject: `UltraCheck: ${azienda || "Analisi"}`,
        text: `...`,
        attachments: [{ content: fileBuffer.toString("base64"), filename: req.file.originalname, type: req.file.mimetype }],
      });
      console.log("Email inviata");
    }

    res.json({ result: analysis });
  } catch (error) {
    console.error("Errore:", error.message);
    res.status(500).json({ error: "Elaborazione fallita: " + error.message });
  } finally {
    await fs.unlink(filePath).catch(() => {});
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck su http://0.0.0.0:${port}`);
});
