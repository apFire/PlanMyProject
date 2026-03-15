"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = process.cwd();
const README_PATH = path.join(ROOT, "README.md");
const PROJECT_PATH = path.join(ROOT, "project.md");
const TAP_REPORT_PATH = path.join(ROOT, ".tmp-build-status.tap");
const STATUS_START = "<!-- pmp:build-status:start -->";
const STATUS_END = "<!-- pmp:build-status:end -->";

function runCommand(command, args, envOverrides = {}, forceShell) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: typeof forceShell === "boolean" ? forceShell : process.platform === "win32",
    env: { ...process.env, ...envOverrides }
  });

  return {
    ok: result.status === 0,
    status: typeof result.status === "number" ? result.status : 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

function parseTestSummary(output) {
  const tests = matchNumber(output, /(?:ℹ|#)\s*tests\s+(\d+)/i);
  const pass = matchNumber(output, /(?:ℹ|#)\s*pass\s+(\d+)/i);
  const fail = matchNumber(output, /(?:ℹ|#)\s*fail\s+(\d+)/i);
  const testPassRate = tests > 0 ? (pass / tests) * 100 : 0;

  return { tests, pass, fail, testPassRate };
}

function parseCodeCoverage(output) {
  const match = /all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/i.exec(output);
  if (!match) {
    return { available: false, line: 0, branch: 0, funcs: 0 };
  }

  return {
    available: true,
    line: Number(match[1]),
    branch: Number(match[2]),
    funcs: Number(match[3])
  };
}

function parseFeatureCoverage(projectMarkdown) {
  const lines = projectMarkdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes("| Original requirement | Current status |"));
  if (headerIndex < 0) {
    return { total: 0, implementedUnits: 0, percent: 0 };
  }

  let total = 0;
  let implementedUnits = 0;
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) {
      break;
    }
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 3) {
      continue;
    }

    total += 1;
    const status = cells[1].toLowerCase();
    if (status.includes("partially")) {
      implementedUnits += 0.5;
    } else if (status.includes("implemented")) {
      implementedUnits += 1;
    }
  }

  const percent = total > 0 ? (implementedUnits / total) * 100 : 0;
  return { total, implementedUnits, percent };
}

function matchNumber(text, pattern) {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : 0;
}

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function encodeBadgePart(value) {
  return encodeURIComponent(String(value));
}

function coverageColor(percent) {
  if (percent >= 90) {
    return "brightgreen";
  }
  if (percent >= 75) {
    return "yellow";
  }
  if (percent >= 60) {
    return "orange";
  }
  return "red";
}

function badge(label, message, color) {
  return `![${label}](https://img.shields.io/badge/${encodeBadgePart(label)}-${encodeBadgePart(message)}-${encodeBadgePart(color)}?style=flat-square)`;
}

function buildBadgeLine(statusModel) {
  const overallBadge = badge("build", statusModel.success ? "pass" : "fail", statusModel.success ? "brightgreen" : "red");
  const { tests, pass, fail, testPassRate } = statusModel.testSummary;
  const testMessage = tests > 0 ? `${pass}/${tests} (${testPassRate.toFixed(2)}%)` : `0/0 (${testPassRate.toFixed(2)}%)`;
  const testBadge = badge("tests", testMessage, fail === 0 && tests > 0 ? "brightgreen" : fail > 0 ? "red" : "lightgrey");

  const { codeCoverage } = statusModel;
  const codeMessage = codeCoverage.available ? `${codeCoverage.line.toFixed(2)}%` : "unavailable";
  const codeBadge = badge(
    "code coverage",
    codeMessage,
    codeCoverage.available ? coverageColor(codeCoverage.line) : "lightgrey"
  );

  const { featureCoverage } = statusModel;
  const featureMessage = featureCoverage.total > 0
    ? `${featureCoverage.percent.toFixed(2)}%`
    : "unavailable";
  const featureBadge = badge(
    "feature coverage",
    featureMessage,
    featureCoverage.total > 0 ? coverageColor(featureCoverage.percent) : "lightgrey"
  );

  return `${overallBadge} ${testBadge} ${codeBadge} ${featureBadge}`;
}

function collectCompiledTestFiles() {
  const testRoot = path.join(ROOT, "out-test", "test");
  if (!fs.existsSync(testRoot)) {
    return [];
  }

  const result = [];
  const stack = [testRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".test.js")) {
        result.push(nextPath);
      }
    }
  }

  result.sort((a, b) => a.localeCompare(b));
  return result;
}

function buildStatusBlock(statusModel) {
  const now = new Date().toISOString();
  const overall = statusModel.success ? "PASS" : "FAIL";
  const { tests, pass, fail, testPassRate } = statusModel.testSummary;
  const { codeCoverage } = statusModel;
  const { featureCoverage } = statusModel;
  const badgeLine = buildBadgeLine(statusModel);

  const codeCoverageLine = codeCoverage.available
    ? `- Code coverage (all files): lines ${formatPercent(codeCoverage.line)} | branches ${formatPercent(codeCoverage.branch)} | functions ${formatPercent(codeCoverage.funcs)}`
    : "- Code coverage (all files): unavailable";

  const featureCoverageLine = featureCoverage.total > 0
    ? `- Feature coverage: ${featureCoverage.implementedUnits.toFixed(1)}/${featureCoverage.total} requirements (${formatPercent(featureCoverage.percent)})`
    : "- Feature coverage: unavailable";

  return [
    STATUS_START,
    "## Build Status",
    "",
    badgeLine,
    "",
    `Last updated: ${now}`,
    `- Overall build status: ${overall}`,
    `- Test coverage: ${pass}/${tests} tests passing (${formatPercent(testPassRate)}), failed: ${fail}`,
    codeCoverageLine,
    featureCoverageLine,
    "",
    "Update source: `npm run build` or `npm run verify`",
    STATUS_END
  ].join("\n");
}

function updateReadmeBlock(block) {
  const readme = fs.readFileSync(README_PATH, "utf8");
  const startIndex = readme.indexOf(STATUS_START);
  const endIndex = readme.indexOf(STATUS_END);

  if (startIndex >= 0 && endIndex > startIndex) {
    const before = readme.slice(0, startIndex).trimEnd();
    const after = readme.slice(endIndex + STATUS_END.length).trimStart();
    const next = `${before}\n\n${block}\n\n${after}`;
    fs.writeFileSync(README_PATH, next, "utf8");
    return;
  }

  const requirementsHeader = "\n## Requirements";
  const insertionPoint = readme.indexOf(requirementsHeader);
  if (insertionPoint < 0) {
    const next = `${readme.trimEnd()}\n\n${block}\n`;
    fs.writeFileSync(README_PATH, next, "utf8");
    return;
  }

  const before = readme.slice(0, insertionPoint).trimEnd();
  const after = readme.slice(insertionPoint).trimStart();
  const next = `${before}\n\n${block}\n\n${after}`;
  fs.writeFileSync(README_PATH, next, "utf8");
}

function main() {
  if (fs.existsSync(TAP_REPORT_PATH)) {
    fs.unlinkSync(TAP_REPORT_PATH);
  }

  const compile = runCommand("npx", ["tsc", "-p", "./"]);
  process.stdout.write(compile.output);

  const testBuild = runCommand("npx", ["tsc", "-p", "./tsconfig.test.json"]);
  process.stdout.write(testBuild.output);

  const testFiles = testBuild.ok ? collectCompiledTestFiles() : [];
  const coverageRun = runCommand(
    "node",
    [
      "--test",
      "--experimental-test-coverage",
      "--test-reporter=tap",
      `--test-reporter-destination=${TAP_REPORT_PATH}`,
      ...testFiles
    ],
    { NODE_PATH: path.join(ROOT, "test", "shims") }
  );
  process.stdout.write(coverageRun.output);

  const reportOutput = fs.existsSync(TAP_REPORT_PATH)
    ? fs.readFileSync(TAP_REPORT_PATH, "utf8")
    : "";
  const testSummary = parseTestSummary(reportOutput);
  const codeCoverage = parseCodeCoverage(reportOutput);
  const projectMarkdown = fs.readFileSync(PROJECT_PATH, "utf8");
  const featureCoverage = parseFeatureCoverage(projectMarkdown);
  const success = compile.ok && testBuild.ok && coverageRun.ok;

  updateReadmeBlock(
    buildStatusBlock({
      success,
      testSummary,
      codeCoverage,
      featureCoverage
    })
  );

  if (fs.existsSync(TAP_REPORT_PATH)) {
    fs.unlinkSync(TAP_REPORT_PATH);
  }

  if (!success) {
    process.exitCode = 1;
  }
}

main();
