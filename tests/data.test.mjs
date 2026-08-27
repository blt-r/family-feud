import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { validateQuestionBank } from "../scripts/validate-question-bank.mjs";

test("question bank passes integrity validation", () => {
  const questions = JSON.parse(fs.readFileSync(new URL("../public/data/questions.json", import.meta.url), "utf8"));
  assert.deepEqual(validateQuestionBank(questions), []);
});
