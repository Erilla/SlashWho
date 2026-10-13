import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { authoredErrorCode } from "./error-codes";

type Source = { path: string; text: string };

function collectAuthoredCodes(input: Source): Set<string> {
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true
  );
  const codes = new Set<string>();
  const errorNames = new Set([
    "Error",
    "RangeError",
    "TypeError",
    "SyntaxError",
    "ReferenceError"
  ]);
  const errorVariables = new Set<string>();
  const thrownVariables = new Set<string>();
  const helperArguments: ReadonlyMap<string, readonly number[]> = new Map([
    ["one", [1]],
    ["requiredSecret", [1]],
    ["positiveInteger", [2]],
    ["requiredPositiveInteger", [1, 2]],
    ["positiveNumber", [2]],
    ["integerInRange", [4]],
    ["optionalHttpUrl", [1]],
    ["requiredEncryptionKey", [1]],
    ["connectionError", [0]]
  ]);
  function unwrapped(node: ts.Node): ts.Node {
    return ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node)
      ? unwrapped(node.expression)
      : node;
  }
  function add(node: ts.Node | undefined) {
    if (!node) return;
    const value = unwrapped(node);
    if (
      ts.isStringLiteral(value) &&
      /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value.text)
    )
      codes.add(value.text);
  }
  function expressionName(node: ts.Expression): string | undefined {
    return ts.isIdentifier(node)
      ? node.text
      : ts.isPropertyAccessExpression(node)
        ? node.name.text
        : undefined;
  }
  function directErrorClass(node: ts.Node): node is ts.ClassDeclaration {
    return (
      ts.isClassDeclaration(node) &&
      !!node.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some(
            (type) => expressionName(type.expression) === "Error"
          )
      )
    );
  }
  function inErrorClass(node: ts.Node): boolean {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (ts.isClassDeclaration(parent)) return directErrorClass(parent);
    return false;
  }
  function hasErrorCreation(node: ts.Node): boolean {
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      errorNames.has(expressionName(node.expression) ?? "")
    )
      return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (hasErrorCreation(child)) found = true;
    });
    return found;
  }
  function objectCodes(node: ts.Node) {
    const value = unwrapped(node);
    if (
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      value.expression.expression.getText(source) === "Object" &&
      value.expression.name.text === "assign"
    ) {
      for (const argument of value.arguments) objectCodes(argument);
      return;
    }
    if (!ts.isObjectLiteralExpression(value)) return;
    for (const property of value.properties)
      if (
        ts.isPropertyAssignment(property) &&
        ((ts.isIdentifier(property.name) && property.name.text === "code") ||
          (ts.isStringLiteral(property.name) && property.name.text === "code"))
      )
        add(property.initializer);
  }
  function declaredCodes(node: ts.TypeNode) {
    if (ts.isLiteralTypeNode(node)) add(node.literal);
    if (ts.isUnionTypeNode(node))
      for (const type of node.types) declaredCodes(type);
  }
  function declarations(node: ts.Node) {
    if (directErrorClass(node) && node.name) errorNames.add(node.name.text);
    if (
      ts.isThrowStatement(node) &&
      ts.isIdentifier(unwrapped(node.expression))
    )
      thrownVariables.add(unwrapped(node.expression).getText(source));
    ts.forEachChild(node, declarations);
  }
  declarations(source);
  function variables(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      hasErrorCreation(node.initializer)
    )
      errorVariables.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      thrownVariables.has(node.name.text)
    )
      objectCodes(node.initializer);
    ts.forEachChild(node, variables);
  }
  variables(source);
  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const name = expressionName(node.expression);
      if (errorNames.has(name ?? "")) add(node.arguments?.[0]);
      if (ts.isCallExpression(node)) {
        for (const index of helperArguments.get(name ?? "") ?? [])
          add(node.arguments[index]);
        if (
          node.expression.kind === ts.SyntaxKind.SuperKeyword &&
          inErrorClass(node)
        )
          add(node.arguments[0]);
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText(source) === "Object" &&
          node.expression.name.text === "assign" &&
          node.arguments.some(hasErrorCreation)
        )
          for (const argument of node.arguments) objectCodes(argument);
      }
    }
    if (ts.isThrowStatement(node)) objectCodes(node.expression);
    if (
      ts.isPropertyDeclaration(node) &&
      node.name.getText(source) === "code" &&
      inErrorClass(node)
    ) {
      add(node.initializer);
      if (node.type) declaredCodes(node.type);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "code" &&
      ((ts.isIdentifier(node.left.expression) &&
        errorVariables.has(node.left.expression.text)) ||
        (node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          inErrorClass(node)))
    )
      add(node.right);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return codes;
}

function sourceFiles(): Source[] {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const sources: Source[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
        continue;
      }
      if (!path.endsWith(".ts") || /\.(?:test|spec|d)\.ts$/.test(path))
        continue;
      sources.push({ path, text: readFileSync(path, "utf8") });
    }
  }
  for (const entry of readdirSync(join(root, "packages"), {
    withFileTypes: true
  }))
    if (entry.isDirectory()) walk(join(root, "packages", entry.name, "src"));
  walk(join(root, "apps/worker/src"));
  walk(join(root, "apps/web/src/server"));
  return sources;
}

function missingCodes(codes: Iterable<string>): string[] {
  return [...new Set(codes)]
    .filter((code) => authoredErrorCode(code) === null)
    .sort();
}

const sources = sourceFiles();
const discovered = new Set(
  sources.flatMap((source) => [...collectAuthoredCodes(source)])
);

describe("authored error registry source coverage", () => {
  it("admits all discovered non-test authored codes with non-vacuous coverage", () => {
    expect(discovered.size).toBeGreaterThan(150);
    expect(missingCodes(discovered)).toEqual([]);
  });
  it.each([
    'throw new Error("evidence_probe_invalid");',
    'throw new RangeError("evidence_probe_invalid");',
    'throw new TypeError("evidence_probe_invalid");',
    'throw Error("evidence_probe_invalid");',
    'one(result, "evidence_probe_invalid");',
    'requiredSecret(value, "evidence_probe_invalid");',
    'positiveInteger(value, 1, "evidence_probe_invalid");',
    'requiredPositiveInteger(value, "evidence_probe_invalid", "rankings_unavailable");',
    'requiredPositiveInteger(value, "rankings_unavailable", "evidence_probe_invalid");',
    'positiveNumber(value, 1, "evidence_probe_invalid");',
    'integerInRange(value, 1, 0, 5, "evidence_probe_invalid");',
    'optionalHttpUrl(value, "evidence_probe_invalid");',
    'requiredEncryptionKey(value, "evidence_probe_invalid");',
    'connectionError("evidence_probe_invalid");',
    'throw {code: "evidence_probe_invalid"};',
    'throw Object.assign({}, {code: "evidence_probe_invalid"});',
    'const failure = {code: "evidence_probe_invalid"}; throw failure;',
    'throw Object.assign(new Error(), {code: "evidence_probe_invalid" as const});',
    'const failure = new Error(); failure.code = "evidence_probe_invalid";',
    'class Failure extends Error { readonly code = "evidence_probe_invalid"; }',
    'class Failure extends Error { readonly code: "evidence_probe_invalid"; constructor(code) { super(code); this.code = code; } }',
    'class Failure extends Error { constructor() { super("evidence_probe_invalid"); } }'
  ])("detects an injected unregistered code: %s", (text) => {
    expect(
      missingCodes([
        ...discovered,
        ...collectAuthoredCodes({ path: "probe.ts", text })
      ])
    ).toEqual(["evidence_probe_invalid"]);
  });
  it("ignores ordinary result codes and non-authored text", () => {
    expect([
      ...collectAuthoredCodes({
        path: "probe.ts",
        text: 'const result = {kind:"limitation",code:"ordinary_result_code"}; new Error("private free text"); new Error("unauthorized");'
      })
    ]).toEqual([]);
  });
});
