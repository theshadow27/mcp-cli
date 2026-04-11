/**
 * Human-readable session name generator.
 *
 * Assigns short first names to sessions for identity anchoring.
 * Names are picked round-robin from a curated list to minimize
 * collisions while keeping the pool small enough to be memorable.
 */

const SESSION_NAMES: readonly string[] = [
  "Alice",
  "Bob",
  "Carol",
  "Dave",
  "Eve",
  "Frank",
  "Grace",
  "Hank",
  "Iris",
  "June",
  "Kurt",
  "Luna",
  "Max",
  "Nora",
  "Oscar",
  "Pam",
  "Quinn",
  "Ray",
  "Sage",
  "Tess",
  "Uri",
  "Vera",
  "Walt",
  "Xena",
  "Yuri",
  "Zara",
];

export { SESSION_NAMES };

/**
 * Pick a session name that isn't already in use.
 * Falls back to Name-N suffix if all base names are taken.
 *
 * @param usedNames - Set of names currently assigned to active sessions
 */
export function generateSessionName(usedNames: ReadonlySet<string>): string {
  // Try each base name in order
  for (const name of SESSION_NAMES) {
    if (!usedNames.has(name)) return name;
  }

  // All base names taken — append numeric suffix
  for (let i = 2; ; i++) {
    for (const name of SESSION_NAMES) {
      const suffixed = `${name}-${i}`;
      if (!usedNames.has(suffixed)) return suffixed;
    }
  }
}
