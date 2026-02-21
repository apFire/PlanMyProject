import test from "node:test";
import assert from "node:assert/strict";
import { maskSensitiveText } from "../src/privacy";

test("maskSensitiveText redacts common token and key patterns", () => {
  const input = [
    "aws=AKIAABCDEFGHIJKLMNOP",
    "openai=sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "github=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "config password='supersecret'"
  ].join("\n");

  const output = maskSensitiveText(input);
  assert.doesNotMatch(output, /AKIA[A-Z0-9]{16}/);
  assert.doesNotMatch(output, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(output, /ghp_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(output, /password='supersecret'/i);
  assert.match(output, /\[REDACTED\]/);
});

test("maskSensitiveText leaves safe text unchanged", () => {
  const input = "Implement login controller and add tests.";
  assert.equal(maskSensitiveText(input), input);
});
