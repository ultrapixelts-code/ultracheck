// pdf.js
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import sharp from "sharp";

let pdfParse = null;

// Caricamento dinamico pdf-parse
(async () => {
  try {
    const lib = await import("pdf-parse");
    pdfParse = lib.default || lib;
    console.log("pdf-parse: caricato (modulo esterno)");
  } catch (err) {
    console.log("pdf-parse: non disponibile → fallback pdftotext");
  }
})();

/**
 * Estrae testo nativo dal PDF (se possibile)
 */
export async function parsePdf(buffer) {
  if (pdfParse) {
    try {
      const data = await pdfParse(buffer);
      return { text: data.text || "" };
    } catch (err) {
      console.warn("pdf-parse fallito:", err.message);
    }
  }

  // fallback: usa pdftotext
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `pdf-${Date.now()}.pdf`);
  const txtPath = pdfPath.replace(".pdf", ".txt");

  try {
    await fs.writeFile(pdfPath, buffer);
    await new Promise((resolve, reject) => {
      const proc = spawn("pdftotext", ["-raw", "-layout", pdfPath, txtPath]);
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`pdftotext code ${code}`))
      );
      proc.on("error", reject);
    });

    const text = await fs.readFile(txtPath, "utf8").catch(() => "");
    return { text };
  } finally {
    await Promise.all([
      fs.unlink(pdfPath).catch(() => {}),
      fs.unlink(txtPath).catch(() => {}),
    ]);
  }
}

/**
 * Converte la prima pagina di un PDF in immagine PNG ad alta risoluzione (via pdftoppm)
 */
export async function pdfToFirstPageImage(buffer) {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `pdf-${Date.now()}.pdf`);
  const prefix = path.join(tmpDir, `page-${Date.now()}`);

  try {
    await fs.writeFile(pdfPath, buffer);

    // -r 400 = PNG a 400 dpi (ottimo per QR piccoli)
    await new Promise((resolve, reject) => {
      const proc = spawn("pdftoppm", [
        "-png",
        "-singlefile",
        "-r",
        "400",
        pdfPath,
        prefix,
      ]);
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`pdftoppm code ${code}`))
      );
      proc.on("error", reject);
    });

    const imgPath = prefix + ".png";
    const imgBuffer = await fs.readFile(imgPath);

    // 🔍 LOG risoluzione PNG generato
    try {
      const metadata = await sharp(imgBuffer).metadata();
      console.log(
        `PDF → PNG generato: ${metadata.width} x ${metadata.height} px (dpi: ${
          metadata.density || "?"
        })`
      );
    } catch (err) {
      console.log("Impossibile leggere metadata PNG:", err.message);
    }

    return imgBuffer;
  } catch (err) {
    console.warn("pdftoppm fallito:", err.message);
    return null;
  } finally {
    await Promise.all([
      fs.unlink(pdfPath).catch(() => {}),
      fs.unlink(prefix + ".png").catch(() => {}),
    ]);
  }
}
