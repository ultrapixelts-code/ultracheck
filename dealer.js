import express from "express";
import multer from "multer";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fs from "fs/promises";
import sharp from "sharp";


const router = express.Router();
const upload = multer({ dest: "/tmp" });

// BOX DEL LOGO (convertite in pt)
const logoBox = {
  x: 21.13,
  y: 780.49,
  width: 113.39,
  height: 46.77
};

// BOX DEL TESTO DISTRIBUTORE
const addressBox = {
  x: 255.53,
  y: 515.66,
  width: 226.77,
  height: 85.04
};

router.post(
  "/dealer/brand-pdf",
  upload.fields([{ name: "file" }, { name: "logo" }]),
  async (req, res) => {
    try {
      const pdfBytes = await fs.readFile(req.files.file[0].path);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const page = pdfDoc.getPages()[0];

      // Carica logo distributore e normalizza in PNG (così vanno bene AVIF, WEBP, JPG, ecc.)
const rawLogoBytes = await fs.readFile(req.files.logo[0].path);

const logoPngBytes = await sharp(rawLogoBytes)
  .png()          // qualunque formato in ingresso → PNG
  .toBuffer();

const logoImage = await pdfDoc.embedPng(logoPngBytes);


      const dims = logoImage.scale(1);
      const scale = Math.min(
        logoBox.width / dims.width,
        logoBox.height / dims.height
      );

      const w = dims.width * scale;
      const h = dims.height * scale;
      const x = logoBox.x + (logoBox.width - w) / 2;
      const y = logoBox.y + (logoBox.height - h) / 2;

      // Maschera logo UltraPixel
      page.drawRectangle({
        x: logoBox.x,
        y: logoBox.y,
        width: logoBox.width,
        height: logoBox.height,
        color: rgb(1, 1, 1)
      });

      page.drawImage(logoImage, {
        x,
        y,
        width: w,
        height: h
      });

      // Maschera indirizzo
      page.drawRectangle({
        x: addressBox.x,
        y: addressBox.y,
        width: addressBox.width,
        height: addressBox.height,
        color: rgb(1, 1, 1)
      });

      // Inserisci il testo
      const { name, address, phone } = req.body;
      const textLines = [name, address, phone].filter(Boolean);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const size = 10;

      let currentY = addressBox.y + addressBox.height - size - 4;

      textLines.forEach(line => {
        const lineWidth = font.widthOfTextAtSize(line, size);
        const textX = addressBox.x + (addressBox.width - lineWidth) / 2;

        page.drawText(line, {
          x: textX,
          y: currentY,
          size,
          font,
          color: rgb(0, 0, 0)
        });

        currentY -= size + 5;
      });

      const finalPDF = await pdfDoc.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=dealer_branded.pdf"
      );

      return res.send(Buffer.from(finalPDF));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Errore durante la generazione del PDF" });
    }
  }
);

export default router;
