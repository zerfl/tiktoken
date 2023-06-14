import {
  ConstructorDeclaration,
  FunctionDeclaration,
  MethodDeclaration,
  Project,
  ScriptTarget,
  StructureKind,
  ts,
} from "ts-morph";
import * as fs from "node:fs";
import * as path from "node:path";

import outdent from "outdent";

for (const baseDir of [
  path.resolve(__dirname, "../dist"),
  path.resolve(__dirname, "../dist/lite"),
]) {
  let publicExports: string[] = [];
  // fix `any` types
  {
    const sourceFile = new Project().addSourceFileAtPath(
      path.resolve(baseDir, "tiktoken.d.ts")
    );
    const cls = sourceFile.getFirstDescendantByKindOrThrow(
      ts.SyntaxKind.ClassDeclaration
    );

    cls
      .getConstructors()[0]
      .getParameterOrThrow("special_tokens")
      .set({ type: "Record<string, number>" });

    for (const method of ["encode", "encode_with_unstable"]) {
      cls
        .getMethodOrThrow(method)
        .getParameterOrThrow("allowed_special")
        .set({ type: `"all" | string[]`, hasQuestionToken: true });

      cls
        .getMethodOrThrow(method)
        .getParameterOrThrow("disallowed_special")
        .set({ type: `"all" | string[]`, hasQuestionToken: true });
    }

    cls
      .getMemberOrThrow("token_byte_values")
      .set({ returnType: "Array<Array<number>>" });

    publicExports = sourceFile
      .getExportSymbols()
      .filter((sym) =>
        sym
          .getDeclarations()
          .some(
            (dcl) =>
              dcl.isKind(ts.SyntaxKind.ClassDeclaration) ||
              dcl.isKind(ts.SyntaxKind.FunctionDeclaration)
          )
      )
      .map((i) => i.getName());

    sourceFile.saveSync();
  }

  // tiktoken_bg.js
  {
    const sourceFile = new Project().addSourceFileAtPath(
      path.resolve(baseDir, "tiktoken_bg.js")
    );

    function prependWasmCheck(
      call: FunctionDeclaration | MethodDeclaration | ConstructorDeclaration
    ) {
      if (
        call instanceof FunctionDeclaration &&
        call.getName() === "__wbg_set_wasm"
      ) {
        return;
      }

      const statements = call
        .getDescendantsOfKind(ts.SyntaxKind.Identifier)
        .filter((i) => i.getText() === "wasm");

      if (statements.length > 0) {
        call.insertStatements(
          0,
          `if (wasm == null) throw new Error("tiktoken: WASM binary has not been propery initialized.");`
        );
      }
    }

    for (const cls of sourceFile.getClasses().filter((i) => i.isExported())) {
      for (const method of cls.getMethods()) {
        prependWasmCheck(method);
      }

      for (const constructor of cls.getConstructors()) {
        prependWasmCheck(constructor);
      }
    }
    for (const fn of sourceFile.getFunctions().filter((i) => i.isExported())) {
      prependWasmCheck(fn);
    }

    sourceFile.saveSync();
  }

  // tiktoken_bg.cjs
  {
    const sourceFile = new Project().addSourceFileAtPath(
      path.resolve(baseDir, "tiktoken_bg.js")
    );

    for (const cls of sourceFile.getClasses().filter((x) => x.isExported())) {
      cls.set({
        ...cls.getStructure(),
        kind: StructureKind.Class,
        isExported: false,
      });

      sourceFile.insertStatements(cls.getChildIndex() + 1, [
        `module.exports.${cls.getName()} = ${cls.getName()};`,
      ]);
    }

    for (const fn of sourceFile.getFunctions().filter((f) => f.isExported())) {
      fn.set({
        ...fn.getStructure(),
        kind: StructureKind.Function,
        isExported: false,
      });

      sourceFile.insertStatements(fn.getChildIndex(), [
        `module.exports.${fn.getName()} = ${fn.getText()};`,
      ]);

      sourceFile
        .getDescendantsOfKind(ts.SyntaxKind.FunctionExpression)
        .filter((x) => x.getName() === fn.getName())
        .forEach((f) => f.removeName());

      fn.remove();
    }

    sourceFile
      .copy(path.resolve(baseDir, "tiktoken_bg.cjs"), { overwrite: true })
      .saveSync();
  }

  // tiktoken.js
  {
    const relativeDir = path.relative(
      path.resolve(__dirname, "../dist"),
      baseDir
    );

    fs.writeFileSync(
      path.resolve(baseDir, "tiktoken.cjs"),
      outdent`
        const wasm = require("./tiktoken_bg.cjs");
        let imports = {};
        imports["./tiktoken_bg.js"] = wasm;
        const path = require("path");
        const fs = require("fs");
        
        const candidates = __dirname
          .split(path.sep)
          .reduce((memo, _, index, array) => {
            const prefix = array.slice(0, index + 1).join(path.sep) + path.sep;
            if (!prefix.includes("node_modules" + path.sep)) {
              memo.unshift(
                path.join(
                  prefix,
                  "node_modules",
                  "@zerfl",
                  "tiktoken",
                  "${relativeDir}",
                  "./tiktoken_bg.wasm"
                )
              );
            }
            return memo;
          }, [])
        candidates.unshift(path.join(__dirname, "./tiktoken_bg.wasm"));
        
        let bytes = null;
        for (const candidate of candidates) {
          try {
            bytes = fs.readFileSync(candidate);
            break;
          } catch {}
        }
        
        if (bytes == null) throw new Error("Missing tiktoken_bg.wasm");
        const wasmModule = new WebAssembly.Module(bytes);
        const wasmInstance = new WebAssembly.Instance(wasmModule, imports);
        wasm.__wbg_set_wasm(wasmInstance.exports);
      ` +
        "\n" +
        publicExports
          .map((name) => `exports["${name}"] = wasm["${name}"];`)
          .join("\n"),
      { encoding: "utf-8" }
    );
  }

  // init.js and init.cjs
  {
    for (const module of [ts.ModuleKind.CommonJS, ts.ModuleKind.ES2022]) {
      const sourceFile = new Project({
        compilerOptions: {
          target: ScriptTarget.ES2022,
          module,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          strict: true,
          declaration: true,
        },
      }).addSourceFileAtPath(path.resolve(__dirname, "../src/init.ts"));

      const emitOutput = sourceFile.getEmitOutput();
      for (const file of emitOutput.getOutputFiles()) {
        let targetFile = path.basename(file.getFilePath());

        let source = file.getText();
        if (module === ts.ModuleKind.CommonJS) {
          targetFile = targetFile.replace(".js", ".cjs");
          source = source
            .replaceAll(`"./tiktoken_bg"`, `"./tiktoken_bg.cjs"`)
            .replaceAll(
              `exports.init = init;`,
              `exports.init = init;\n${publicExports
                .map((name) => `exports["${name}"] = imports["${name}"];`)
                .join("\n")}`
            );
        }

        fs.writeFileSync(path.resolve(baseDir, targetFile), source, {
          encoding: "utf-8",
        });
      }
    }
  }

  // load.js and load.cjs
  {
    for (const module of [ts.ModuleKind.CommonJS, ts.ModuleKind.ES2022]) {
      const sourceFile = new Project({
        compilerOptions: {
          target: ScriptTarget.ES2022,
          module,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          strict: true,
          declaration: true,
        },
      }).addSourceFileAtPath(path.resolve(__dirname, "../src/load.ts"));

      const emitOutput = sourceFile.getEmitOutput();
      for (const file of emitOutput.getOutputFiles()) {
        let targetFile = path.basename(file.getFilePath());

        if (module === ts.ModuleKind.CommonJS) {
          targetFile = targetFile.replace(".js", ".cjs");
        }

        fs.writeFileSync(path.resolve(baseDir, targetFile), file.getText(), {
          encoding: "utf-8",
        });
      }
    }
  }

  // tiktoken_bg.d.ts
  {
    fs.writeFileSync(
      path.resolve(baseDir, "tiktoken_bg.d.ts"),
      `export * from "./tiktoken";`.trim(),
      { encoding: "utf-8" }
    );
  }

  if (!baseDir.includes("/lite")) {
    fs.writeFileSync(
      path.resolve(baseDir, "lite.d.ts"),
      `export * from "./lite/tiktoken";`.trim(),
      { encoding: "utf-8" }
    );
  }
}

// package.json, README.md
{
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../package.json"), {
      encoding: "utf-8",
    })
  );

  delete pkg.devDependencies;
  delete pkg.scripts;
  pkg.files = ["**/*"];

  pkg["main"] = "tiktoken.cjs";
  pkg["types"] = "tiktoken.d.ts";
  pkg["exports"] = {
    ".": {
      types: "./tiktoken.d.ts",
      "edge-light": "./tiktoken.js",
      node: "./tiktoken.cjs",
      default: "./tiktoken.js",
    },
    "./init": {
      types: "./init.d.ts",
      "edge-light": "./init.js",
      node: "./init.cjs",
      default: "./init.js",
    },
    "./load": {
      types: "./load.d.ts",
      "edge-light": "./load.js",
      node: "./load.cjs",
      default: "./load.js",
    },
    "./tiktoken_bg.wasm": {
      types: "./tiktoken_bg.wasm.d.ts",
      default: "./tiktoken_bg.wasm",
    },
    "./tiktoken_bg.wasm?module": {
      types: "./tiktoken_bg.wasm.d.ts",
      default: "./tiktoken_bg.wasm?module",
    },
    "./lite": {
      types: "./lite/tiktoken.d.ts",
      "edge-light": "./lite/tiktoken.js",
      node: "./lite/tiktoken.cjs",
      default: "./lite/tiktoken.js",
    },
    "./lite/init": {
      types: "./lite/init.d.ts",
      "edge-light": "./lite/init.js",
      node: "./lite/init.cjs",
      default: "./lite/init.js",
    },
    "./lite/load": {
      types: "./lite/load.d.ts",
      "edge-light": "./lite/load.js",
      node: "./lite/load.cjs",
      default: "./lite/load.js",
    },
    "./lite/tiktoken_bg.wasm": {
      types: "./lite/tiktoken_bg.wasm.d.ts",
      default: "./lite/tiktoken_bg.wasm",
    },
    "./lite/tiktoken_bg.wasm?module": {
      types: "./lite/tiktoken_bg.wasm.d.ts",
      default: "./lite/tiktoken_bg.wasm?module",
    },
    "./model_to_encoding.json": "./model_to_encoding.json",
    "./registry.json": "./registry.json",
  };

  const registry = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../tiktoken/registry.json"), {
      encoding: "utf-8",
    })
  );

  fs.mkdirSync(path.resolve(__dirname, "../dist/encoders"), {
    recursive: true,
  });

  for (const key in registry) {
    fs.copyFileSync(
      path.resolve(__dirname, `../src/ranks/${key}.json`),
      path.resolve(__dirname, `../dist/encoders/${key}.json`)
    );

    pkg["exports"][`./encoders/${key}.json`] = `./encoders/${key}.json`;

    fs.copyFileSync(
      path.resolve(__dirname, `../src/ranks/${key}.js`),
      path.resolve(__dirname, `../dist/encoders/${key}.js`)
    );

    fs.copyFileSync(
      path.resolve(__dirname, `../src/ranks/${key}.cjs`),
      path.resolve(__dirname, `../dist/encoders/${key}.cjs`)
    );

    fs.copyFileSync(
      path.resolve(__dirname, `../src/ranks/${key}.d.ts`),
      path.resolve(__dirname, `../dist/encoders/${key}.d.ts`)
    );
    pkg["exports"][`./encoders/${key}`] = {
      types: `./encoders/${key}.d.ts`,
      "edge-light": `./encoders/${key}.js`,
      node: `./encoders/${key}.cjs`,
      default: `./encoders/${key}.js`,
    };
  }

  fs.copyFileSync(
    path.resolve(__dirname, "../../README.md"),
    path.resolve(__dirname, "../dist/README.md")
  );

  fs.copyFileSync(
    path.resolve(__dirname, "../../tiktoken/model_to_encoding.json"),
    path.resolve(__dirname, "../dist/model_to_encoding.json")
  );

  fs.copyFileSync(
    path.resolve(__dirname, "../../tiktoken/registry.json"),
    path.resolve(__dirname, "../dist/registry.json")
  );

  fs.writeFileSync(
    path.resolve(__dirname, "../dist/package.json"),
    JSON.stringify(pkg, null, 2),
    { encoding: "utf-8" }
  );
}
