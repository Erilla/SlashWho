import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { createUpstreamError } from "@slashwho/upstream-http";
import { errorFields } from "./error-fields";

it("requires literal names on every Error subclass in the four packages", () => {
  const packages = fileURLToPath(new URL("../../", import.meta.url));
  const checked: string[] = [];
  function check(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        check(path);
        continue;
      }
      if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
      const source = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true
      );
      function visit(node: ts.Node) {
        if (
          ts.isClassDeclaration(node) &&
          node.heritageClauses?.some(
            (clause) =>
              clause.token === ts.SyntaxKind.ExtendsKeyword &&
              clause.types.some(
                (type) => type.expression.getText(source) === "Error"
              )
          )
        ) {
          checked.push(node.name!.text);
          let literalName = false;
          function findName(child: ts.Node) {
            if (
              ts.isPropertyDeclaration(child) &&
              child.name.getText(source) === "name" &&
              child.initializer &&
              ts.isStringLiteral(child.initializer) &&
              child.initializer.text === node.name!.text
            )
              literalName = true;
            if (
              ts.isBinaryExpression(child) &&
              child.left.getText(source) === "this.name" &&
              child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isStringLiteral(child.right) &&
              child.right.text === node.name!.text
            )
              literalName = true;
            ts.forEachChild(child, findName);
          }
          findName(node);
          expect(
            literalName,
            `${path}: ${node.name!.text} needs its literal name`
          ).toBe(true);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  for (const name of ["application", "database", "raiderio", "upstream-http"])
    check(join(packages, name, "src"));
  expect(checked).toEqual(
    expect.arrayContaining([
      "AuthenticationError",
      "RankingLookupFailure",
      "DiscoveryQueueStopTimeoutError",
      "StaleFingerprintDeliveryError",
      "GuildNotFound"
    ])
  );
});

it("gives client factory errors a literal name and rejects arbitrary providers", () => {
  expect(
    errorFields(createUpstreamError("raiderio", { kind: "transient" }))
  ).toEqual({ errorName: "UpstreamError", errorCode: "raiderio_transient" });
  expect(
    errorFields(createUpstreamError("private_character", { kind: "not_found" }))
      .errorCode
  ).toBeNull();
});
