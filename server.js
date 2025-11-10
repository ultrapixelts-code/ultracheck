import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
try { dotenv.config(); } catch {}

import sgMail from "@sendgrid/mail";
import PDFDocument from "pdfkit";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
app.use(express.static("."));
app.use(express.json());

// Serve la pagina principale
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "." });
});

// 📂 Upload temporaneo (✅ /tmp scrivibile su Render)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
  }),
});

// 🔑 Client OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🧩 Normalizza simboli
function normalizeAnalysis(md) {
  const hasStatus = (s) => /^[✅⚠️❌]/.test(s.trimStart());
  function statusFor(line) {
    const low = line.toLowerCase();
    if (/(^|\s)(non\s*presente|mancante|assente|non\s*riportat[oa]|assenza)(\W|$)/.test(low)) return "❌";
    if (/(non\s*verificabil|non\s*determinabil|non\s*misurabil|non\s*leggibil)/.test(low)) return "⚠️";
    if (/(conform|presente|indicata|indicato|riporta|adeguat|corrett)/.test(low)) return "✅";
    return null;
  }

  return md
    .split("\n")
    .map((raw) => {
      const trimmed = raw.trimStart();
      const looksLikeField =
        /^[✅⚠️❌]/.test(trimmed) ||
        /^[-*]\s*\*\*/.test(trimmed) ||
        /^[-*]\s*[A-ZÀ-Úa-zà-ú]/.test(trimmed);
      if (!looksLikeField) return raw;
      const wanted = statusFor(trimmed);
      if (!wanted) return raw;
      const noMarker = trimmed.replace(/^[✅⚠️❌]\s*/, "");
      const leftPad = raw.slice(0, raw.indexOf(trimmed));
      return leftPad + `${wanted} ${noMarker}`;
    })
    .join("\n");
}

// 📤 Endpoint analisi etichetta
app.post("/analyze", upload.single("label"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nessun file ricevuto." });

    console.log(`📥 Ricevuto: ${req.file.originalname}`);

    const imageBytes = fs.readFileSync(req.file.path);
    const base64Image = imageBytes.toString("base64");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      seed: 42,
      messages: [
        {
          role: "system",
          content: `Agisci come un ispettore tecnico *UltraCheck AI*... (testo invariato)`,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analizza questa etichetta di vino..." },
            { type: "image_url", image_url: { url: `data:${req.file.mimetype};base64,${base64Image}` } },
          ],
        },
      ],
    });

    const raw = response.choices[0].message.content || "Nessuna risposta ricevuta dall'AI.";
    const analysis = normalizeAnalysis(raw);
    console.log("✅ Analisi completata");

    const { azienda, nome, email, telefono } = req.body || {};

    // 📧 Invia email tramite API SendGrid
    if (process.env.SMTP_PASS && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SMTP_PASS);

      const msg = {
        to: process.env.MAIL_TO,
        from: "gabriele.russian@ultrapixel.it", // mittente verificato su SendGrid
        subject: `🧠 Nuova analisi etichetta vino - ${azienda || "azienda non indicata"}`,
        text: `
Azienda: ${azienda || "non indicata"}
Nome: ${nome || "non indicato"}
Email: ${email || "non indicata"}
Telefono: ${telefono || "non indicato"}

📊 RISULTATO ANALISI:
${analysis}
        `,
      };

      // Aggiunge l’immagine come allegato
      const attachment = fs.readFileSync(req.file.path).toString("base64");
      msg.attachments = [
        {
          content: attachment,
          filename: req.file.originalname,
          type: req.file.mimetype,
          disposition: "attachment",
        },
      ];

      await sgMail.send(msg);
      console.log("📧 Email inviata via SendGrid API");
    }

    // 🧹 Elimina file temporaneo
    fs.unlink(req.file.path, (err) => {
      if (err) console.warn("Impossibile eliminare file temporaneo:", err.message);
    });

    res.json({ result: analysis });
  } catch (error) {
    console.error("💥 Errore /analyze:", error);
    res.status(500).json({ error: "Errore durante l'elaborazione o l'invio email." });
  }
});

// 🟢 Avvio server
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ UltraCheck AI attivo su porta ${port}`);
});
