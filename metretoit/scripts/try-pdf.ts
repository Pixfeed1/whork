import { readFileSync, writeFileSync } from "node:fs";
import { generateReport } from "../server/pdf/report";
const m = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pdf = await generateReport({ org: { name: "GUÉRIN COUVERTURE", address: "Rue de test", postcode: "17410", city: "Saint-Martin-de-Ré", phone: "05 00 00 00 00", email: "contact@exemple.fr", waste_pct: 10 }, number: "MT-2026-0001", date: new Date(), address: "Adresse de test, 17410 Saint-Martin-de-Ré", clientName: "M. Dupont", notes: "Tuiles canal, à vérifier sur place.", model: m, author: "R. G." });
writeFileSync(process.argv[3], pdf); console.log(pdf.length);
