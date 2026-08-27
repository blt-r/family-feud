import fs from "node:fs";
import { pathToFileURL } from "node:url";

const path = new URL("../public/data/questions.json", import.meta.url);
const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function validateQuestionBank(questions) {
  const promptKeys = new Set();
  const ids = new Set();
  const errors = [];
  for (const [index, question] of questions.entries()) {
    const label = question.id || `index ${index}`;
    if (!question.id || ids.has(question.id)) errors.push(`${label}: missing or duplicate id`);
    ids.add(question.id);
    const promptKey = normalize(question.prompt);
    if (!promptKey || promptKeys.has(promptKey)) errors.push(`${label}: missing or duplicate normalized prompt`);
    promptKeys.add(promptKey);
    if (!Array.isArray(question.answers) || question.answers.length < 3 || question.answers.length > 8) errors.push(`${label}: answer count must be 3–8`);
    if (typeof question.familyFriendly !== "boolean") errors.push(`${label}: familyFriendly must be boolean`);
    const answers = new Set();
    for (const answer of question.answers || []) {
      const key = String(answer.text || "").toLowerCase().trim();
      if (!key || answers.has(key)) errors.push(`${label}: missing or duplicate answer text`);
      answers.add(key);
      if (!Number.isInteger(answer.points) || answer.points < 0 || answer.points > 100) errors.push(`${label}: answer points must be an integer from 0–100`);
      if (/\S\/|\/\S/.test(answer.text)) errors.push(`${label}: slash separators must have spaces`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const questions = JSON.parse(fs.readFileSync(path, "utf8"));
  const errors = validateQuestionBank(questions);
  if (errors.length) {
    console.error(errors.slice(0, 50).join("\n"));
    console.error(`${errors.length} validation error(s)`);
    process.exit(1);
  }

  const safe = questions.filter((question) => question.familyFriendly).length;
  console.log(`Validated ${questions.length} unique questions (${safe} family-friendly).`);
}
