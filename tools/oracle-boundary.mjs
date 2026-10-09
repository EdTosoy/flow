import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const configFile = ts.readConfigFile(
  path.join(root, 'tsconfig.base.json'),
  ts.sys.readFile,
);
const options = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  root,
).options;
function privateFile(file) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  return (
    relative.startsWith('libs/simulator-oracle/') ||
    relative === 'tools/simulator.ts' ||
    relative === 'tools/test-postgres.ts' ||
    relative === 'tools/ops-demo.ts' ||
    relative.startsWith('tests/') ||
    relative.includes('/test/') ||
    relative === 'tools/stripe-verify-sandbox.ts'
  );
}
export default {
  rules: {
    'operations-browser': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          server:
            'Database/privileged modules are server-only; browser closures cannot reach them.',
        },
      },
      create(context) {
        const file = context.filename,
          relative = path.relative(root, file).replaceAll('\\', '/');
        if (
          !relative.startsWith('apps/ops/') ||
          relative.startsWith('apps/ops/test/')
        )
          return {};
        const client =
          context.sourceCode.ast.body[0]?.directive === 'use client';
        const server = relative.startsWith('apps/ops/server/');
        if (
          server &&
          (client ||
            !context.sourceCode.ast.body.some(
              (n) =>
                n.type === 'ImportDeclaration' &&
                n.source.value === 'server-only',
            ))
        )
          context.report({ node: context.sourceCode.ast, messageId: 'server' });
        function unsafe(name, from, seen = new Set()) {
          if (server)
            return (
              /^@flow\/(.*postgres)(\/|$)/.test(name) &&
              name !== '@flow/operations-read-postgres'
            );
          if (
            name === 'pg' ||
            name.startsWith('pg/') ||
            name === 'server-only' ||
            /^@flow\/(.*postgres|simulator-oracle)(\/|$)/.test(name)
          )
            return true;
          const resolved = ts.resolveModuleName(name, from, options, ts.sys)
            .resolvedModule?.resolvedFileName;
          if (
            !resolved ||
            resolved.includes('/node_modules/') ||
            seen.has(resolved)
          )
            return false;
          if (privateFile(resolved)) return true;
          if (resolved.includes('/apps/ops/server/'))
            return (
              client ||
              !/apps\/ops\/app\/(.*\/)?(?:page\.tsx|route\.ts)$/.test(relative)
            );
          if (!client) return false;
          seen.add(resolved);
          const source = ts.sys.readFile(resolved);
          if (!source) return false;
          const ast = ts.createSourceFile(
            resolved,
            source,
            ts.ScriptTarget.Latest,
            true,
          );
          let bad = false;
          function visit(n) {
            if (
              (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
              n.moduleSpecifier &&
              ts.isStringLiteral(n.moduleSpecifier) &&
              unsafe(n.moduleSpecifier.text, resolved, seen)
            )
              bad = true;
            if (
              ts.isCallExpression(n) &&
              n.arguments[0] &&
              ts.isStringLiteral(n.arguments[0]) &&
              (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
                n.expression.getText(ast) === 'require') &&
              unsafe(n.arguments[0].text, resolved, seen)
            )
              bad = true;
            ts.forEachChild(n, visit);
          }
          visit(ast);
          return bad;
        }
        function check(n) {
          if (n && typeof n.value === 'string' && unsafe(n.value, file))
            context.report({ node: n, messageId: 'server' });
        }
        return {
          ImportDeclaration(n) {
            check(n.source);
          },
          ExportNamedDeclaration(n) {
            check(n.source);
          },
          ExportAllDeclaration(n) {
            check(n.source);
          },
          ImportExpression(n) {
            check(n.source);
          },
          CallExpression(n) {
            if (n.callee.type === 'Identifier' && n.callee.name === 'require')
              check(n.arguments[0]);
          },
          TSImportType(n) {
            check(n.source);
          },
        };
      },
    },
    'no-oracle-import': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          private:
            'Oracle/test harness code cannot be imported by runtime/application code.',
        },
      },
      create(context) {
        const file = context.filename;
        if (privateFile(file)) return {};
        function check(node) {
          if (!node || typeof node.value !== 'string') return;
          const name = node.value;
          const resolved = ts.resolveModuleName(name, file, options, ts.sys)
            .resolvedModule?.resolvedFileName;
          const target =
            resolved ??
            (name.startsWith('.') || path.isAbsolute(name)
              ? path.resolve(path.dirname(file), name)
              : '');
          if (
            name === '@flow/simulator-oracle' ||
            name.startsWith('@flow/simulator-oracle/') ||
            (target && privateFile(target))
          )
            context.report({ node, messageId: 'private' });
        }
        return {
          ImportDeclaration(node) {
            check(node.source);
          },
          ExportNamedDeclaration(node) {
            check(node.source);
          },
          ExportAllDeclaration(node) {
            check(node.source);
          },
          ImportExpression(node) {
            check(node.source);
          },
          CallExpression(node) {
            if (
              node.callee.type === 'Identifier' &&
              node.callee.name === 'require'
            )
              check(node.arguments[0]);
          },
          TSImportType(node) {
            check(node.source);
          },
        };
      },
    },
  },
};
