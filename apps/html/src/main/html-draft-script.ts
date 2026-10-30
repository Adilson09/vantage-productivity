import { parse, type Node, type Expression, type VariableDeclaration } from 'acorn'

const MAX_SCRIPT_TOKENS = 200000,
  MAX_SCRIPT_NODES = 200000,
  MAX_SCRIPT_DEPTH = 128
function unsupported(detail: string): never {
  throw new Error(
    'Scripted-page recovery supports only static data and local data-only module imports (' +
      detail +
      '). The previous recovery copy is retained; manual Save is unchanged.',
  )
}

/** Positive grammar boundary. No user script, expression or import is executed here. */
export function assertStaticHtmlRecoveryScript(source: string): void {
  let tokens = 0,
    nodes = 0
  const program = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
    onToken() {
      if (++tokens > MAX_SCRIPT_TOKENS)
        throw new Error('The script exceeds the recovery token budget.')
    },
  })
  const bindings = new Set<string>()
  const count = (node: Node, depth: number): void => {
    if (++nodes > MAX_SCRIPT_NODES || depth > MAX_SCRIPT_DEPTH)
      throw new Error('The static script exceeds its recovery structure budget.')
    if (!node || typeof node.type !== 'string') unsupported('invalid syntax tree')
  }
  const name = (node: Node & { name?: string }, depth: number): string => {
    count(node, depth)
    if (node.type !== 'Identifier' || typeof node.name !== 'string')
      return unsupported('binding pattern')
    return node.name
  }
  const literal = (
    node: Node & { value?: unknown; regex?: unknown; bigint?: unknown },
    depth: number,
  ): void => {
    count(node, depth)
    if (
      node.type !== 'Literal' ||
      node.regex !== undefined ||
      node.bigint !== undefined ||
      (node.value !== null && !['string', 'boolean', 'number'].includes(typeof node.value)) ||
      (typeof node.value === 'number' && !Number.isFinite(node.value))
    )
      unsupported('non-data literal')
  }
  const expression = (node: Expression, depth: number): void => {
    count(node, depth)
    switch (node.type) {
      case 'Literal':
        literal(node, depth + 1)
        return
      case 'Identifier':
        if (!bindings.has(node.name)) unsupported('unresolved data binding')
        return
      case 'ArrayExpression':
        for (const element of node.elements) {
          if (!element) continue
          if (element.type === 'SpreadElement') unsupported('spread')
          expression(element, depth + 1)
        }
        return
      case 'ObjectExpression':
        for (const property of node.properties) {
          count(property, depth + 1)
          if (
            property.type !== 'Property' ||
            property.computed ||
            property.method ||
            property.kind !== 'init'
          )
            unsupported('computed or executable object property')
          if (property.key.type === 'Identifier') {
            count(property.key, depth + 2)
            if (property.key.name === '__proto__') unsupported('prototype initializer')
          } else {
            literal(property.key, depth + 2)
            if (property.key.type === 'Literal' && property.key.value === '__proto__')
              unsupported('prototype initializer')
          }
          expression(property.value, depth + 2)
        }
        return
      case 'TemplateLiteral':
        if (node.expressions.length || node.quasis.length !== 1) unsupported('template expression')
        count(node.quasis[0]!, depth + 1)
        return
      case 'UnaryExpression':
        if (
          (node.operator !== '-' && node.operator !== '+') ||
          node.argument.type !== 'Literal' ||
          typeof node.argument.value !== 'number' ||
          !Number.isFinite(node.argument.value)
        )
          unsupported('runtime unary expression')
        literal(node.argument, depth + 1)
        return
      default:
        return unsupported(node.type)
    }
  }
  const declaration = (node: VariableDeclaration, depth: number): void => {
    count(node, depth)
    if (node.kind !== 'const') unsupported('mutable declaration')
    for (const item of node.declarations) {
      count(item, depth + 1)
      const binding = name(item.id, depth + 2)
      if (!item.init) unsupported('uninitialized data')
      expression(item.init, depth + 2)
      bindings.add(binding)
    }
  }
  const moduleSource = (
    node: Node & { value?: unknown },
    attributes: readonly unknown[],
    depth: number,
  ): void => {
    literal(node, depth)
    if (typeof node.value !== 'string' || attributes.length)
      unsupported('module import attributes or source')
  }
  count(program, 0)
  // Static imports are hoisted. Their full source graph is checked separately by
  // the asset materializer, with remote/opaque executable dependencies refused.
  for (const statement of program.body)
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) bindings.add(name(specifier.local, 2))
    }
  for (const statement of program.body) {
    count(statement, 1)
    switch (statement.type) {
      case 'EmptyStatement':
        break
      case 'ExpressionStatement':
        if (
          statement.expression.type !== 'Literal' ||
          typeof statement.expression.value !== 'string'
        )
          unsupported('runtime statement')
        literal(statement.expression, 2)
        break
      case 'VariableDeclaration':
        declaration(statement, 2)
        break
      case 'ImportDeclaration':
        moduleSource(statement.source, statement.attributes, 2)
        for (const specifier of statement.specifiers) count(specifier, 2)
        break
      case 'ExportNamedDeclaration':
        if (statement.declaration) {
          if (statement.declaration.type !== 'VariableDeclaration') unsupported('executable export')
          declaration(statement.declaration, 2)
        }
        if (statement.source) moduleSource(statement.source, statement.attributes, 2)
        for (const specifier of statement.specifiers) {
          count(specifier, 2)
          if (
            !statement.source &&
            (specifier.local.type !== 'Identifier' || !bindings.has(specifier.local.name))
          )
            unsupported('unresolved export binding')
        }
        break
      case 'ExportDefaultDeclaration':
        if (
          statement.declaration.type === 'FunctionDeclaration' ||
          statement.declaration.type === 'ClassDeclaration'
        )
          unsupported('executable default export')
        expression(statement.declaration, 2)
        break
      case 'ExportAllDeclaration':
        moduleSource(statement.source, statement.attributes, 2)
        break
      default:
        unsupported(statement.type)
    }
  }
}
