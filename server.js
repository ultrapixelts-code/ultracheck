import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import PDFDocument from "pdfkit";
import cors from "cors";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.static("."));
app.use(express.json());

// Serve homepage
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "." });
});

// Upload
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
  }),
});

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Normalizza simboli
function normalizeAnalysis(md) {
  const statusFor = (line) => {
    const low = line.toLowerCase();
    if (/(non presente|mancante|assente|non riportat|assenza)/.test(low)) return "No";
    if (/(non verificabil|non determinabil|non leggibil)/.test(low)) return "Warning";
    if (/(conform|presente|indicata|riporta|adeguat|corrett)/.test(low)) return "Yes";
    return null;
  };
  return md
    .split("\n")
    .map((raw) => {
      const trimmed = raw.trimStart();
      if (!/^[YesWarningNo]/.test(trimmed) && !/^[-*]/.test(trimmed)) return raw;
      const wanted = statusFor(trimmed);
      if (!wanted) return raw;
      const noMarker = trimmed.replace(/^[YesWarningNo]\s*/, "");
      const leftPad = raw.slice(0, raw.indexOf(trimmed));
      return leftPad + `${wanted} ${noMarker}`;
    })
    .join("\n");
}

// Estrai testo da PDF
async function parsePdf(buffer) {
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const result = await pdfParse(buffer);
    return { text: result.text || "" };
  } catch (err) {
    console.error("Errore pdf-parse:", err.message);
    return { text: "[Errore: testo non estraibile]" };
  }
}

// === ANALISI ETICHETTA ===
app.post("/analyze", upload.single("label"), async (req, res) => {
  console.log("Endpoint /analyze chiamato");
  try {
    if (!req.file) return res.status(400).json({ error: "Nessun file." });

    const { azienda, nome, email, telefono, lang } = req.body;
    const language = lang || "it";

    let base64Image = null;
    let extractedText = "";

    if (req.file.mimetype === "application/pdf") {
      console.log("PDF rilevato → estrazione testo...");
      const pdfBuffer = fs.readFileSync(req.file.path);
      const pdfData = await parsePdf(pdfBuffer);
      extractedText = pdfData.text;
    } else {
      base64Image = fs.readFileSync(req.file.path).toString("base64");
    }

    // === ANALISI OPENAI ===
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Sei UltraCheck AI. Analizza l'etichetta vino secondo Reg. UE 2021/2117.
Rispondi in ${language} con formato markdown esatto. Se un campo manca → No.
===============================
### Conformità normativa
Denominazione di origine: (Yes/No/Warning) + testo
Nome produttore: (Yes/No/Warning) + testo
Volume: (Yes/No/Warning) + testo
Titolo alcolometrico: (Yes/No/Warning) + testo
Allergeni: (Yes/No/Warning) + testo
Lotto: (Yes/No/Warning) + testo
QR code: (Yes/No/Warning) + testo
Lingua UE: (Yes/No/Warning) + testo
Altezza caratteri: (Yes/No/Warning) + testo
Contrasto: (Yes/No/Warning) + testo
**Valutazione finale:** Conforme / Parzialmente / Non conforme
===============================`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Testo estratto: ${extractedText}\n\nAnalizza in ${language}.`
            },
            ...(base64Image
              ? [{
                  type: "image_url",
                  image_url: { url: `data:${req.file.mimetype};base64,${base64Image}` }
                }]
              : [])
          ]
        }
      ]
    });

    const raw = response.choices[0].message.content || "";
    const analysis = normalizeAnalysis(raw);

    // === GENERA PDF REPORT ===
    const reportFilename = `report-${Date.now()}.pdf`;
    const reportPath = `/tmp/${reportFilename}`;
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(reportPath);
    doc.pipe(stream);

    doc.fontSize(18).text("UltraCheck AI - Report", { align: "center" });
    doc.moveDown(1.5);
    doc.fontSize(12);

    analysis.split("\n").forEach(line => {
      if (!line.trim()) {
        doc.moveDown(0.5);
      } else if (line.startsWith("### ")) {
        doc.fontSize(14).text(line.slice(4), { underline: true });
        doc.moveDown(0.5);
      } else if (line.includes("Valutazione finale")) {
        const color = line.includes("Non conforme") ? "#a94442" : line.includes("Parzialmente") ? "#b77f00" : "#3c763d";
        doc.fontSize(15).fillColor(color).text(line, { bold: true });
      } else if (/^[YesWarningNo]/.test(line.trimStart())) {
        const icon = line.trimStart()[0];
        const text = line.replace(/^[YesWarningNo]\s*/, "");
        doc.text(`${icon} ${text}`);
      } else {
        doc.text(line);
      }
      doc.moveDown(0.3);
    });

    doc.end();
    await new Promise((resolve, reject) => {
      stream.on("finish", resolve);
      stream.on("error",", reject);
    });

    // === EMAIL ===
    if (process.env.SENDGRID_API_KEY && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: process.env.MAIL_TO,
        from: "no-reply@ultracheck.ai",
        subject: `Analisi etichetta - ${azienda || "N/D"}`,
        text: `Da: ${nome} <${email}>\n\n${analysis}`,
        attachments: [
          { content: fs.readFileSync(req.file.path).toString("base64"), filename: req.file.originalname, type: req.file.mimetype },
          { content: fs.readFileSync(reportPath).toString("base64"), filename: "Report_UltraCheck.pdf", type: "application/pdf" }
        ]
      });
    }

    // === PULIZIA ===
    fs.unlinkSync(req.file.path);

    // === RISPOSTA ===
    res.json({
      result: analysis,
      reportUrl: `/ultracheck.html?report=${reportFilename}&lang=${language}`
    });

  } catch (error) {
    console.error("Errore /analyze:", error.message);
    if (req.file?.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Errore server." });
  }
});

// === SERVI PDF ===
app.get("/report/:file", (req, res) => {
  const path = `/tmp/${req.params.file}`;
  if (fs.existsSync(path)) {
    res.set("Content-Type", "application/pdf");
    res.sendFile(path, { root: "/" });
  } else {
    res.status(404).send("Report non trovato.");
  }
});

// === ultracheck.html ===
app.get("/ultracheck.html", (req, res) => {
  const { report, lang = "it" } = req.query;
  const url = report ? `/report/${report}` : null;

  const titles = { it: "Report", fr: "Rapport", en: "Report" };
  const msgs = { it: "Report pronto", fr: "Rapport prêt", en: "Report ready" };

  res.send(`
<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <title>UltraCheck AI - ${titles[lang]}</title>
  <style>
    body { font-family: Arial; margin: 40px; text-align: center; background: #f9f9f9; }
    h1 { color: #c6a450; }
    .btn { padding: 12px 24px; margin: 10px; background: #111; color: white; border-radius: 6px; text-decoration: none; }
    .btn:hover { background: #c6a450; color: #111; }
    iframe { width: 100%; height: 75vh; border: none; margin-top: 20px; }
  </style>
</head>
<body>
  <h1>UltraCheck AI</h1>
  <p><strong>${msgs[lang]}</strong></p>
  <div>
    <a href="${url}" download class="btn">Scarica PDF</a>
    <a href="/" class="btn">Nuova Analisi</a>
  </div>
  ${url ? `<iframe src="${url}"></iframe>` : "<p>Nessun report.</p>"}
</body>
</html>`);
});

// === START ===
app.listen(port, "0.0.0.0", () => {
  console.log(`UltraCheck AI attivo su porta ${port}`);
});
