import express from "express";
import multer from "multer";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fs from "fs/promises";
import sharp from "sharp";

const router = express.Router();
const upload = multer({ dest: "/tmp" });

// BOX DEL LOGO (coordinate in punti – pt)
const logoBox = {
  x: 21.13,
  y: 780.49,
  width: 113.39,
  height: 46.77,
};

// BOX DEL TESTO DISTRIBUTORE
const addressBox = {
  x: 255.53,
  y: 515.66,
  width: 226.77,
  height: 85.04,
};

router.post(
  "/dealer/brand-pdf",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "logo", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // Controllo file obbligatori
      if (!req.files?.file?.[0] || !req.files?.logo?.[0]) {
        return res
          .status(400)
          .json({ error: "File PDF o logo mancanti nella richiesta" });
      }

      console.log("Dealer → PDF:", req.files.file[0].path);
      console.log(
        "Dealer → LOGO:",
        req.files.logo[0].path,
        req.files.logo[0].mimetype
      );

      // 1) Carica il PDF base
      const pdfBytes = await fs.readFile(req.files.file[0].path);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const page = pdfDoc.getPages()[0];

      // 2) Leggi il logo grezzo (qualsiasi formato)
      const rawLogoBytes = await fs.readFile(req.files.logo[0].path);

      // 3) CONVERSIONE BLINDATA IN PNG – FIX DEFINITIVO PER RENDER
      const logoPngBytes = await sharp(rawLogoBytes)
        .rotate() // RIMUOVE EXIF e qualsiasi header JPEG → ADDIO "SOI not found"
        .png({
          compressionLevel: 9,
          adaptiveFiltering: false,
          force: true, // forza PNG anche se l'input è JPEG/AVIF/WEBP/HEIC
        })
        .toBuffer();

      // 4) Embed sicuro come PNG
      const logoImage = await pdfDoc.embedPng(logoPngBytes);

      // 5) Calcolo ridimensionamento proporzionale
      const dims = logoImage.scale(1);
      const scale = Math.min(
        logoBox.width / dims.width,
        logoBox.height / dims.height
      );
      const w = dims.width * scale;
      const h = dims.height * scale;
      const x = logoBox.x + (logoBox.width - w) / 2;
      const y = logoBox.y + (logoBox.height - h) / 2;

      // 6) Maschera logo UltraPixel esistente
      page.drawRectangle({
        x: logoBox.x,
        y: logoBox.y,
        width: logoBox.width,
        height: logoBox.height,
        color: rgb(1, 1, 1), // bianco
      });

      // 7) Disegna il nuovo logo
      page.drawImage(logoImage, {
        x,
        y,
        width: w,
        height: h,
      });

      // 8) Maschera indirizzo vecchio
      page.drawRectangle({
        x: addressBox.x,
        y: addressBox.y,
        width: addressBox.width,
        height: addressBox.height,
        color: rgb(1, 1, 1),
      });

      // 9) Inserisci testo distributore (centrato)
      const { name, address, phone } = req.body;
      const textLines = [name, address, phone].filter(Boolean);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const size = 10;
      let currentY = addressBox.y + addressBox.height - size - 4;

      textLines.forEach((line) => {
        const lineWidth = font.widthOfTextAtSize(line, size);
        const textX = addressBox.x + (addressBox.width - lineWidth) / 2;

        page.drawText(line, {
          x: textX,
          y: currentY,
          size,
          font,
          color: rgb(0, 0, 0),
        });
        currentY -= size + 5;
      });

      // 10) Output finale
      const finalPDF = await pdfDoc.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=dealer_branded.pdf"
      );
      return res.send(Buffer.from(finalPDF));
    } catch (e) {
      console.error("ERRORE DEALER /brand-pdf:", e);
      res.status(500).json({
        error: "Errore durante la generazione del PDF",
        detail: e.message,
      });
    } finally {
      // Pulizia file temporanei
      try {
        if (req.files?.file?.[0]?.path)
          await fs.unlink(req.files.file[0].path).catch(() => {});
        if (req.files?.logo?.[0]?.path)
          await fs.unlink(req.files.logo[0].path).catch(() => {});
      } catch {}
    }
  }
);

export default router;
