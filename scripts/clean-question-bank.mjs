import fs from "node:fs";

const path = new URL("../public/data/questions.json", import.meta.url);
const questions = JSON.parse(fs.readFileSync(path, "utf8"));
const promptKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const answerKey = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
const textFixes = new Map([
  ["Celebs / ScandlesCelebs / Scandals", "Celebs / Scandals"]
]);

function cleanQuestion(question) {
  const merged = new Map();
  for (const original of question.answers || []) {
    const text = textFixes.get(original.text) || String(original.text || "").trim().replace(/\s*\/\s*/g, " / ");
    let points = Number(original.points);
    if (question.id === "csv-7-4a81dd728c9f" && text === "Clothes" && points === 121) points = 12;
    if (!text || !Number.isInteger(points) || points < 0 || points > 100) continue;
    const key = answerKey(text);
    if (merged.has(key)) merged.get(key).points += points;
    else merged.set(key, { text, points });
  }
  return { ...question, prompt: String(question.prompt || "").trim(), answers: [...merged.values()] };
}

const unique = new Map();
let mergedPrompts = 0;
for (const original of questions) {
  const candidate = cleanQuestion(original);
  if (!candidate.prompt || candidate.answers.length < 3 || candidate.answers.length > 8) continue;
  const key = promptKey(candidate.prompt);
  const existing = unique.get(key);
  if (!existing) {
    unique.set(key, candidate);
    continue;
  }
  mergedPrompts += 1;
  const familyFriendly = existing.familyFriendly !== false && candidate.familyFriendly !== false;
  const candidateRank = candidate.answers.length * 1000 + candidate.answers.reduce((sum, answer) => sum + answer.points, 0);
  const existingRank = existing.answers.length * 1000 + existing.answers.reduce((sum, answer) => sum + answer.points, 0);
  const selected = candidateRank > existingRank ? candidate : existing;
  unique.set(key, { ...selected, familyFriendly });
}

const cleaned = [...unique.values()];
if (process.argv.includes("--write")) fs.writeFileSync(path, JSON.stringify(cleaned));
console.log(JSON.stringify({ before: questions.length, after: cleaned.length, removedDuplicatePrompts: mergedPrompts }));
