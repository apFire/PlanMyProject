import test from "node:test";
import assert from "node:assert/strict";
import {
  createTaskIdGenerator,
  findTaskById,
  listLeafTasks,
  makeTaskNode,
  parseAiTaskTitles,
  parsePlanMarkdown,
  serializePlanMarkdown
} from "../src/model";

test("parsePlanMarkdown builds tree and parent-child relationships", () => {
  const input = [
    "# Project Plan",
    "",
    "<!-- pmp:schema=v1 -->",
    "",
    "## Plan Tree",
    "- [ ] [T0001] Build auth",
    "  - [ ] [T0002] Create login API",
    "  - [/] [T0003] Add auth tests",
    "    - [ ] [T0004] Write unit tests",
    "",
    "## Execution Queue (Auto-Generated, Leaf Tasks Only)",
    "1. [T0002] Create login API",
    "2. [T0004] Write unit tests"
  ].join("\n");

  const parsed = parsePlanMarkdown(input);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].id, "T0001");
  assert.equal(parsed.tasks[0].children.length, 2);
  assert.equal(parsed.tasks[0].children[1].id, "T0003");
  assert.equal(parsed.tasks[0].children[1].children[0].id, "T0004");
});

test("parsePlanMarkdown normalizes uppercase done status", () => {
  const input = [
    "## Plan Tree",
    "- [X] [T0001] Complete setup",
    "",
    "## Execution Queue (Auto-Generated, Leaf Tasks Only)"
  ].join("\n");

  const parsed = parsePlanMarkdown(input);
  assert.equal(parsed.tasks[0].status, "x");
});

test("serializePlanMarkdown writes queue and omits markdown action links", () => {
  const root = makeTaskNode("T0001", "Build auth", 0, null);
  const childA = makeTaskNode("T0002", "Create login API", 1, "T0001");
  const childB = makeTaskNode("T0003", "Add auth tests", 1, "T0001");
  childA.status = "x";
  childB.status = " ";
  root.children.push(childA, childB);

  const output = serializePlanMarkdown([root]);

  assert.doesNotMatch(output, /command:planmyproject\.planTask\?/);
  assert.doesNotMatch(output, /command:planmyproject\.drillDown\?/);
  assert.doesNotMatch(output, /command:planmyproject\.implementTask\?/);
  assert.match(output, /## Execution Queue \(Auto-Generated, Leaf Tasks Only\)/);
  assert.match(output, /1\. \[T0002\] Create login API/);
  assert.match(output, /2\. \[T0003\] Add auth tests/);
  assert.match(output, /- \[\/\] \[T0001\] Build auth/);
});

test("round-trip parse/serialize preserves task ids and leaf list", () => {
  const root = makeTaskNode("T0001", "Root objective", 0, null);
  root.children.push(makeTaskNode("T0002", "Leaf one", 1, "T0001"));
  const nonLeaf = makeTaskNode("T0003", "Parent", 1, "T0001");
  nonLeaf.children.push(makeTaskNode("T0004", "Leaf two", 2, "T0003"));
  root.children.push(nonLeaf);

  const first = serializePlanMarkdown([root]);
  const parsed = parsePlanMarkdown(first);
  const second = serializePlanMarkdown(parsed.tasks);

  assert.equal(second, first);
  const leaves = listLeafTasks(parsed.tasks).map((node) => node.id);
  assert.deepEqual(leaves, ["T0002", "T0004"]);
});

test("createTaskIdGenerator starts after current max ID", () => {
  const root = makeTaskNode("T0007", "Objective", 0, null);
  root.children.push(makeTaskNode("T0030", "Child", 1, "T0007"));

  const nextId = createTaskIdGenerator([root]);
  assert.equal(nextId(), "T0031");
  assert.equal(nextId(), "T0032");
});

test("parseAiTaskTitles extracts bullets, removes duplicates, and caps output", () => {
  const ai = [
    "- Create API route",
    "- Create API route",
    "2. Add validation layer.",
    "* Write integration tests;",
    "Not a bullet line"
  ].join("\n");

  const titles = parseAiTaskTitles(ai);
  assert.deepEqual(titles, ["Create API route", "Add validation layer", "Write integration tests"]);
});

test("parsePlanMarkdown supports plain markdown task lists without schema", () => {
  const input = [
    "# projectplan.md",
    "",
    "1. Build authentication module",
    "2. Add login endpoint",
    "  - Write unit tests"
  ].join("\n");

  const parsed = parsePlanMarkdown(input);
  assert.equal(parsed.planHeadingLine, -1);
  assert.equal(parsed.tasks.length, 2);
  assert.equal(parsed.tasks[0].title, "Build authentication module");
  assert.equal(parsed.tasks[1].title, "Add login endpoint");
  assert.equal(parsed.tasks[1].children.length, 1);
  assert.equal(parsed.tasks[1].children[0].title, "Write unit tests");
  assert.match(parsed.tasks[0].id, /^T\d{4}$/);
});

test("findTaskById returns undefined when not found", () => {
  const root = makeTaskNode("T0001", "Root", 0, null);
  assert.equal(findTaskById([root], "T9999"), undefined);
});
