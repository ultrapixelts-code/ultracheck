export function cleanOCR(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/m\s*l/gi, "ml")
    .replace(/c\s*l/gi, "cl")
    .replace(/%[\s]*v[\s]*ol/gi, "% vol")
    .replace(/(\d)[\.,](\d)/g, "$1.$2")
    .trim();
}
