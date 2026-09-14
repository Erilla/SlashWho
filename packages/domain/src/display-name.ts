/**
 * Formats a character name for display without changing its canonical identity.
 */
export function formatCharacterDisplayName(value: string): string {
  const [initial, ...remaining] = Array.from(value);
  return (
    initial!.toLocaleUpperCase("en-US") +
    remaining.join("").toLocaleLowerCase("en-US")
  );
}
