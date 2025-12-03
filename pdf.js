// pdf.js
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { convert } from "pdf-poppler";

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
 * Converte la prima pagina di un PDF in immagine PNG ad alta risoluzione
 */
export async function pdfToFirstPageImage(pdfBuffer) {
  const ts = Date.now();
  const tmpPdf = `/tmp/ultracheck-${ts}.pdf`;
  const outDir = "/tmp";
  const outPrefix = `ultra_page_${ts}`;

  try {
    // 1. Salva PDF temporaneo
    await fs.writeFile(tmpPdf, pdfBuffer);

    // 2. Converti con pdf-poppler a 400 DPI (ottimo per QR piccoli)
    await convert(tmpPdf, {
      format: "png",
      out_dir: outDir,
      out_prefix: outPrefix,
      page: 1,
      dpi: 400,  // ← se non basta, porta a 500/600
    });

    const pngPath = path.join(outDir, `${outPrefix}-1.png`);
    const imgBuffer = await fs.readFile(pngPath);

    // 3. Pulizia file temporanei (best effort)
    await Promise.allSettled([
      fs.unlink(tmpPdf),
      fs.unlink(pngPath),
    ]);

    // Torna il PNG "grezzo" → poi lo sistemi in detectQrCode con sharp
    return imgBuffer;

  } catch (err) {
    console.warn("pdfToFirstPageImage fallito:", err.message);

    // Pulizia di emergenza
    await Promise.allSettled([
      fs.unlink(tmpPdf).catch(() => {}),
      fs
        .unlink(path.join(outDir, `${outPrefix}-1.png`))
        .catch(() => {}),
    ]);

    return null;
  }
}
