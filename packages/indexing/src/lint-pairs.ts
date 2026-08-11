/** Every unordered pair from a list, each item paired with every later item exactly once — shared by the discriminability and contradiction checks, both of which compare every sibling chapter pair within a volume. */
export function pairs<T>(items: readonly T[]): Array<readonly [T, T]> {
  const result: Array<readonly [T, T]> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a !== undefined && b !== undefined) {
        result.push([a, b]);
      }
    }
  }
  return result;
}
