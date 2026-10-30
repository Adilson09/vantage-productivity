declare module 'css-tree/tokenizer' {
  export const tokenTypes: Readonly<Record<string, number>>
  export function tokenize(
    source: string,
    callback: (type: number, start: number, end: number) => void,
  ): void
}

declare module 'css-tree/utils' {
  export const ident: { decode(source: string): string }
  export const string: { decode(source: string): string }
  export const url: { decode(source: string): string }
}
