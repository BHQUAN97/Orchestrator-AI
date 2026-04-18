#!/usr/bin/env node
/**
 * AST Parse Tool — Parse JavaScript/TypeScript thanh AST de orcai refactor chinh xac
 *
 * Khac grep: AST hieu scope, binding, declaration vs reference.
 * Dung: @babel/parser (parse), @babel/traverse (walk), @babel/generator (regenerate).
 *
 * Graceful degradation: neu @babel/* chua cai → return error structured,
 * khong crash toan bo orcai.
 */

const fs = require('fs');
const path = require('path');

// --- Optional dependency detection ---
let parser = null;
let traverseFn = null;
let generateFn = null;
let babelAvailable = false;
let babelLoadError = null;

try {
  parser = require('@babel/parser');
  // @babel/traverse export default tren CJS
  const traverseMod = require('@babel/traverse');
  traverseFn = traverseMod.default || traverseMod;
  const generateMod = require('@babel/generator');
  generateFn = generateMod.default || generateMod;
  babelAvailable = true;
} catch (e) {
  babelLoadError = e.message;
}

const BABEL_MISSING_ERR = {
  success: false,
  error: 'Babel not installed. Run: npm install @babel/parser @babel/traverse @babel/generator'
};

const SUPPORTED_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

// Resolve filePath an toan trong project boundary — tranh LLM doc/ghi file ngoai project
// Tra ve { ok, absPath, error } — neu ok=false thi absPath=null, dung tai goi
function _resolveInProject(filePath, projectDir) {
  if (!projectDir) {
    // Backward compat: neu khong truyen projectDir, resolve theo cwd (caller tu chiu)
    return { ok: true, absPath: path.resolve(filePath) };
  }
  const projNorm = path.normalize(projectDir);
  const absPath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(projNorm, filePath);
  if (!absPath.startsWith(projNorm + path.sep) && absPath !== projNorm) {
    return { ok: false, absPath: null, error: `BLOCKED: path outside project: ${absPath}` };
  }
  return { ok: true, absPath };
}

// Parse options — du dung cho ca JS lan TS
const PARSE_OPTS = {
  sourceType: 'module',
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  allowImportExportEverywhere: true,
  plugins: [
    'jsx',
    'typescript',
    'classProperties',
    'decorators-legacy',
    'optionalChaining',
    'nullishCoalescingOperator',
    'dynamicImport',
    'topLevelAwait',
    'exportDefaultFrom',
    'exportNamespaceFrom',
  ],
};

/**
 * Doc file va parse thanh AST.
 * @param {string} absPath
 * @returns {{ok: true, ast: any, code: string, language: string} | {ok: false, error: string}}
 */
function _readAndParse(absPath) {
  if (!babelAvailable) return { ok: false, error: BABEL_MISSING_ERR.error };

  const ext = path.extname(absPath).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) {
    return { ok: false, error: `Unsupported extension: ${ext}. Only JS/TS variants supported.` };
  }
  if (!fs.existsSync(absPath)) {
    return { ok: false, error: `File not found: ${absPath}` };
  }

  let code;
  try {
    code = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    return { ok: false, error: `Read failed: ${e.message}` };
  }

  const language = (ext === '.ts' || ext === '.tsx') ? 'typescript' : 'javascript';

  let ast;
  try {
    ast = parser.parse(code, PARSE_OPTS);
  } catch (e) {
    return { ok: false, error: `Parse error: ${e.message}` };
  }

  return { ok: true, ast, code, language };
}

/**
 * Lay 1 dong context xung quanh loc (dung cho snippet).
 */
function _lineAt(code, line) {
  if (!code || !line) return '';
  const lines = code.split(/\r?\n/);
  return (lines[line - 1] || '').trim().slice(0, 200);
}

/**
 * Chuan hoa loc object tu AST node.
 */
function _loc(node, includeLoc) {
  if (!includeLoc || !node || !node.loc) return undefined;
  return {
    start: { line: node.loc.start.line, col: node.loc.start.column },
    end: { line: node.loc.end.line, col: node.loc.end.column },
  };
}

/**
 * Kiem tra node co o top-level (Program body) hay khong.
 * Dung de phan biet const top-level vs const trong function.
 */
function _isTopLevel(nodePath) {
  // nodePath is @babel/traverse NodePath
  const parent = nodePath.parent;
  return parent && parent.type === 'Program';
}

/**
 * astParse — parse file, tra ve symbol list (functions, classes, top-level consts, exports).
 * KHONG tra full AST tree (qua to).
 *
 * @param {{path: string, include_locations?: boolean}} args
 * @returns {Promise<{success: boolean, language?: string, symbols?: any[], error?: string}>}
 */
async function astParse(args = {}, projectDir) {
  if (!babelAvailable) return { ...BABEL_MISSING_ERR };

  const { path: filePath, include_locations = true } = args;
  if (!filePath) return { success: false, error: 'Missing path' };

  const rv = _resolveInProject(filePath, projectDir);
  if (!rv.ok) return { success: false, error: rv.error };
  const absPath = rv.absPath;
  const pr = _readAndParse(absPath);
  if (!pr.ok) return { success: false, error: pr.error };

  const { ast, language } = pr;
  const symbols = [];

  try {
    traverseFn(ast, {
      FunctionDeclaration(p) {
        if (p.node.id && p.node.id.name) {
          symbols.push({
            type: 'function',
            name: p.node.id.name,
            loc: _loc(p.node, include_locations),
            exported: _isExported(p),
          });
        }
      },
      ClassDeclaration(p) {
        if (p.node.id && p.node.id.name) {
          symbols.push({
            type: 'class',
            name: p.node.id.name,
            loc: _loc(p.node, include_locations),
            exported: _isExported(p),
          });
        }
      },
      VariableDeclaration(p) {
        // Chi lay top-level const/let/var
        if (!_isTopLevel(p) && !(p.parent && p.parent.type === 'ExportNamedDeclaration')) return;
        const kind = p.node.kind; // const/let/var
        for (const decl of p.node.declarations) {
          if (!decl.id) continue;
          // Simple identifier
          if (decl.id.type === 'Identifier') {
            // Detect neu init la function/arrow → xem nhu function
            const isFn = decl.init && (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression');
            symbols.push({
              type: isFn ? 'function' : kind,
              name: decl.id.name,
              loc: _loc(decl, include_locations),
              exported: _isExported(p),
            });
          }
          // Destructuring: { a, b } = ...
          else if (decl.id.type === 'ObjectPattern') {
            for (const prop of decl.id.properties) {
              if (prop.type === 'ObjectProperty' && prop.value && prop.value.type === 'Identifier') {
                symbols.push({
                  type: kind,
                  name: prop.value.name,
                  loc: _loc(prop, include_locations),
                  exported: _isExported(p),
                });
              }
            }
          }
        }
      },
      ExportNamedDeclaration(p) {
        // Named exports khong co declaration: export { foo, bar }
        if (!p.node.declaration && p.node.specifiers) {
          for (const spec of p.node.specifiers) {
            if (spec.type === 'ExportSpecifier' && spec.exported) {
              const name = spec.exported.name || (spec.exported.value);
              if (name) {
                symbols.push({
                  type: 'export',
                  name,
                  loc: _loc(spec, include_locations),
                  exported: true,
                });
              }
            }
          }
        }
      },
      ExportDefaultDeclaration(p) {
        const d = p.node.declaration;
        let name = 'default';
        if (d) {
          if (d.type === 'Identifier') name = d.name;
          else if (d.id && d.id.name) name = d.id.name;
        }
        symbols.push({
          type: 'export_default',
          name,
          loc: _loc(p.node, include_locations),
          exported: true,
        });
      },
    });
  } catch (e) {
    return { success: false, error: `Traverse error: ${e.message}` };
  }

  return {
    success: true,
    language,
    path: absPath,
    symbols,
  };
}

/**
 * Check xem NodePath co nam trong export declaration khong.
 */
function _isExported(p) {
  const parent = p.parent;
  if (!parent) return false;
  return parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration';
}

/**
 * astFindSymbol — tim moi reference cua symbol trong 1 file (declaration + usage).
 * Phan biet kind: declaration | reference.
 *
 * @param {{path: string, symbol_name: string}} args
 */
async function astFindSymbol(args = {}, projectDir) {
  if (!babelAvailable) return { ...BABEL_MISSING_ERR };

  const { path: filePath, symbol_name } = args;
  if (!filePath) return { success: false, error: 'Missing path' };
  if (!symbol_name) return { success: false, error: 'Missing symbol_name' };

  const rv = _resolveInProject(filePath, projectDir);
  if (!rv.ok) return { success: false, error: rv.error };
  const absPath = rv.absPath;
  const pr = _readAndParse(absPath);
  if (!pr.ok) return { success: false, error: pr.error };

  const { ast, code } = pr;
  const occurrences = [];

  try {
    traverseFn(ast, {
      Identifier(p) {
        if (p.node.name !== symbol_name) return;

        // Bo qua property access: obj.symbol_name (khi symbol_name la property, khong phai binding)
        // Chi bo neu la property cua MemberExpression VA khong phai computed
        if (p.parent && p.parent.type === 'MemberExpression' && p.parent.property === p.node && !p.parent.computed) {
          return;
        }
        // Bo qua ObjectProperty key (khong shorthand)
        if (p.parent && p.parent.type === 'ObjectProperty' && p.parent.key === p.node && !p.parent.computed && !p.parent.shorthand) {
          return;
        }

        const isDecl = _isDeclarationNode(p);
        const loc = p.node.loc;
        if (!loc) return;

        occurrences.push({
          line: loc.start.line,
          col: loc.start.column,
          kind: isDecl ? 'declaration' : 'reference',
          context_snippet: _lineAt(code, loc.start.line),
        });
      },
    });
  } catch (e) {
    return { success: false, error: `Traverse error: ${e.message}` };
  }

  // Dedupe (line+col)
  const seen = new Set();
  const unique = [];
  for (const o of occurrences) {
    const k = `${o.line}:${o.col}`;
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(o);
    }
  }

  return {
    success: true,
    path: absPath,
    symbol: symbol_name,
    occurrences: unique,
    count: unique.length,
  };
}

/**
 * Kiem tra Identifier NodePath co phai la declaration.
 */
function _isDeclarationNode(p) {
  const parent = p.parent;
  if (!parent) return false;
  // function foo() / class Foo — node.id === p.node
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
       parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression' ||
       parent.type === 'ArrowFunctionExpression') && parent.id === p.node) return true;
  // VariableDeclarator: const foo = ...
  if (parent.type === 'VariableDeclarator' && parent.id === p.node) return true;
  // Function param: function(foo, bar)
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
       parent.type === 'ArrowFunctionExpression') && parent.params && parent.params.includes(p.node)) return true;
  // Import specifier: import { foo } / import foo
  if (parent.type === 'ImportSpecifier' && parent.local === p.node) return true;
  if (parent.type === 'ImportDefaultSpecifier' && parent.local === p.node) return true;
  if (parent.type === 'ImportNamespaceSpecifier' && parent.local === p.node) return true;
  return false;
}

/**
 * astFindUsages — search across nhieu file (array), merge occurrences.
 * Gioi han 100 file de tranh blow up.
 *
 * @param {{symbol_name: string, files: string[]}} args
 */
async function astFindUsages(args = {}, projectDir) {
  if (!babelAvailable) return { ...BABEL_MISSING_ERR };

  const { symbol_name, files } = args;
  if (!symbol_name) return { success: false, error: 'Missing symbol_name' };
  if (!Array.isArray(files) || files.length === 0) {
    return { success: false, error: 'files must be non-empty array' };
  }

  const MAX_FILES = 100;
  const targetFiles = files.slice(0, MAX_FILES);
  const truncated = files.length > MAX_FILES;

  const by_file = [];
  let total_occurrences = 0;
  const errors = [];

  for (const f of targetFiles) {
    const res = await astFindSymbol({ path: f, symbol_name }, projectDir);
    if (!res.success) {
      errors.push({ path: f, error: res.error });
      continue;
    }
    if (res.count > 0) {
      by_file.push({
        path: res.path,
        count: res.count,
        lines: res.occurrences.map(o => ({ line: o.line, kind: o.kind, snippet: o.context_snippet })),
      });
      total_occurrences += res.count;
    }
  }

  return {
    success: true,
    symbol: symbol_name,
    total_occurrences,
    files_scanned: targetFiles.length,
    files_with_matches: by_file.length,
    by_file,
    truncated,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * astRenameSymbol — rename symbol trong 1 file bang AST (ton trong binding/scope).
 *
 * Chi rename Identifier co binding matching old_name.
 * KHONG rename property access `.oldName` (vi day la khac namespace).
 * Thuc te: dung Babel scope resolution — rename theo top-level binding neu co;
 * neu khong co binding (vd import), duyet toan file va rename Identifier match
 * nhung skip MemberExpression property + ObjectProperty key.
 *
 * @param {{path: string, old_name: string, new_name: string, dry_run?: boolean}} args
 */
async function astRenameSymbol(args = {}, projectDir) {
  if (!babelAvailable) return { ...BABEL_MISSING_ERR };

  const { path: filePath, old_name, new_name, dry_run = true } = args;
  if (!filePath) return { success: false, error: 'Missing path' };
  if (!old_name) return { success: false, error: 'Missing old_name' };
  if (!new_name) return { success: false, error: 'Missing new_name' };
  if (old_name === new_name) return { success: false, error: 'old_name === new_name' };
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(new_name)) {
    return { success: false, error: `Invalid new_name identifier: ${new_name}` };
  }

  const rv = _resolveInProject(filePath, projectDir);
  if (!rv.ok) return { success: false, error: rv.error };
  const absPath = rv.absPath;
  const pr = _readAndParse(absPath);
  if (!pr.ok) return { success: false, error: pr.error };

  const { ast, code } = pr;
  let count = 0;

  try {
    // Thu tim binding o Program scope truoc
    let renamedViaBinding = false;
    traverseFn(ast, {
      Program(p) {
        const binding = p.scope.getBinding(old_name);
        if (binding) {
          // Babel's scope.rename ton trong binding va khong rename property access.
          p.scope.rename(old_name, new_name);
          // count = 1 (decl) + so reference
          count = 1 + (binding.references || 0);
          renamedViaBinding = true;
          p.stop();
        }
      },
    });

    // Fallback: khong co binding o top-level (vd local const trong function, hoac
    // symbol den tu module ngoai khong khai bao) — duyet thu cong
    if (!renamedViaBinding) {
      traverseFn(ast, {
        Identifier(p) {
          if (p.node.name !== old_name) return;
          // Skip property access: obj.oldName
          if (p.parent && p.parent.type === 'MemberExpression' && p.parent.property === p.node && !p.parent.computed) {
            return;
          }
          // Skip ObjectProperty key (khong shorthand)
          if (p.parent && p.parent.type === 'ObjectProperty' && p.parent.key === p.node && !p.parent.computed && !p.parent.shorthand) {
            return;
          }
          p.node.name = new_name;
          count++;
        },
      });
    }
  } catch (e) {
    return { success: false, error: `Rename error: ${e.message}` };
  }

  if (count === 0) {
    return { success: false, error: `Symbol not found: ${old_name}`, count: 0 };
  }

  // Generate code moi
  let output;
  try {
    const gen = generateFn(ast, {
      retainLines: false,
      comments: true,
      compact: false,
    }, code);
    output = gen.code;
  } catch (e) {
    return { success: false, error: `Generate error: ${e.message}` };
  }

  if (dry_run) {
    // Preview diff: simple line-level diff (khong can lib 'diff')
    const preview_diff = _simpleDiff(code, output);
    return {
      success: true,
      dry_run: true,
      path: absPath,
      old_name,
      new_name,
      count,
      preview_diff,
    };
  }

  // Ghi file
  try {
    fs.writeFileSync(absPath, output, 'utf8');
  } catch (e) {
    return { success: false, error: `Write failed: ${e.message}` };
  }

  return {
    success: true,
    written: true,
    path: absPath,
    old_name,
    new_name,
    count,
  };
}

/**
 * Simple line diff — chi hien dong co thay doi, tranh depend 'diff' lib.
 */
function _simpleDiff(oldCode, newCode) {
  const oldLines = oldCode.split(/\r?\n/);
  const newLines = newCode.split(/\r?\n/);
  const changes = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o !== n) {
      if (o !== undefined) changes.push({ line: i + 1, type: '-', text: o });
      if (n !== undefined) changes.push({ line: i + 1, type: '+', text: n });
    }
    if (changes.length > 200) {
      changes.push({ line: -1, type: '!', text: `...truncated (${max - i} more lines)` });
      break;
    }
  }
  return changes;
}

module.exports = {
  astParse,
  astFindSymbol,
  astFindUsages,
  astRenameSymbol,
  // debug helpers
  _babelAvailable: () => babelAvailable,
  _babelLoadError: () => babelLoadError,
};
