import { cleanOCR } from "./cleanOCR.js";
import { extractData } from "./extract.js";
import { applyRules } from "./rules.js";

export function analyzeText(text) {
  const clean = cleanOCR(text);
  const data = extractData(clean);
  const rules = applyRules(data);

  return { clean, data, rules };
}
