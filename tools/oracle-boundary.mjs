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
    relative.startsWith('tests/')
  );
}
export default {
  rules: {
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
