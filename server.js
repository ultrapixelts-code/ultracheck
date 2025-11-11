import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
import sgMail from "@sendgrid/mail";
import PDFDocument from "pdfkit";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(express.static("."));
app.use(express.json());

// Serve la pagina principale
app.get("/", (req, res) => {
  res.sendFile("ultracheck.html", { root: "." });
});

// 📂 Upload temporaneo (✅ /tmp scrivibile su Render)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "/tmp"),
    filename: (req, file, cb) =>
      cb(null, Date.now() + "-" + file.originalname),
  }),
});

// 🔑 Client OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🧩 Normalizza simboli
function normalizeAnalysis(md) {
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
      return `${leftPad}${wanted} ${noMarker}`;
    })
    .join("\n");
}

// ⚡ Helper per PDF
async function parsePdf(buffer) {
  const mod = await import("pdf-parse");
  const pdf = mod.default || mod;
  return await pdf(buffer);
}

// 📤 Endpoint analisi etichetta
app.post("/analyze", upload.single("label"), async (req, res) => {
  console.log("✅ Endpoint /analyze chiamato");
  console.log("Lingua ricevuta:", req.body.lang);

  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nessun file ricevuto." });
    }

    console.log("📦 Dati ricevuti dal form:", req.body);
    const { azienda, nome, email, telefono, lang } = req.body || {};
    const language = lang || "it";
    console.log(`🌍 Lingua selezionata: ${language}`);

    let base64Image;

    if (req.file.mimetype === "application/pdf") {
      console.log("📄 Rilevato PDF — estraggo testo con pdf-parse...");
      const pdfBuffer = fs.readFileSync(req.file.path);
      const pdfData = await parsePdf(pdfBuffer);
      const extractedText = pdfData.text;
      base64Image = Buffer.from(extractedText).toString("base64");
    } else {
      const imageBytes = fs.readFileSync(req.file.path);
      base64Image = imageBytes.toString("base64");
    }

    // 🧠 Analisi AI
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
Rispondi sempre nel formato markdown esatto qui sotto, in lingua: ${language}.
Se c'è anche 1 solo campo ❌ mancante, la valutazione finale sarà non conforme.

===============================
### 🔎 Conformità normativa (Reg. UE 2021/2117)
Denominazione di origine: (✅ conforme / ⚠️ parziale / ❌ mancante) + testo
Nome e indirizzo del produttore o imbottigliatore: (✅/⚠️/❌) + testo
Volume nominale: (✅/⚠️/❌) + testo
Titolo alcolometrico: (✅/⚠️/❌) + testo
Indicazione allergeni: (✅/⚠️/❌) + testo
Lotto: (✅/⚠️/❌) + testo
QR code: (✅/⚠️/❌) + testo
Lingua corretta per il mercato UE: (✅/⚠️/❌) + testo
Altezza minima dei caratteri: (✅/⚠️/❌) + testo
Contrasto testo/sfondo adeguato: (✅/⚠️/❌) + testo
**Valutazione finale:** Conforme / Parzialmente conforme / Non conforme
===============================`
        },
        {
          role: "system",
          content: `IMPORTANT: se la lingua selezionata è francese (${language}), traduci completamente tutti i titoli e le intestazioni in francese, mantenendo il formato identico.
🇫🇷 Francese → "Conformité réglementaire", "Dénomination d’origine", ecc.
🇬🇧 Inglese → "Regulatory compliance", "Designation of origin", ecc.`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analizza questa etichetta di vino e rispondi interamente in ${language}. Non mescolare l'italiano.`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${req.file.mimetype};base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    });

    const raw = response.choices[0].message.content || "Nessuna risposta ricevuta dall'AI.";
    const analysis = normalizeAnalysis(raw);
    console.log("✅ Analisi completata");

    // 📧 Invio email tramite SendGrid API
    if (process.env.SMTP_PASS && process.env.MAIL_TO) {
      sgMail.setApiKey(process.env.SMTP_PASS);
      const msg = {
        to: process.env.MAIL_TO,
        from: "gabriele.russian@ultrapixel.it",
        subject: `🧠 Nuova analisi etichetta vino - ${azienda || "azienda non indicata"}`,
        text: `Azienda: ${azienda || "non indicata"}
Nome: ${nome || "non indicato"}
Email: ${email || "non indicata"}
Telefono: ${telefono || "non indicato"}

📊 RISULTATO ANALISI:
${analysis}`,
        attachments: [
          {
            content: fs.readFileSync(req.file.path).toString("base64"),
            filename: req.file.originalname,
            type: req.file.mimetype,
            disposition: "attachment",
          },
        ],
      };
      await sgMail.send(msg);
      console.log("📧 Email inviata via SendGrid API");
    }

    fs.unlinkSync(req.file.path);
    res.json({ result: analysis });
  } catch (error) {
    console.error("💥 Errore /analyze:", error.response?.data || error.message);
    res.status(500).json({ error: "Errore durante l'elaborazione o l'invio email." });
  }
});

// 🟢 Avvio server
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ UltraCheck AI attivo su porta ${port}`);
});
