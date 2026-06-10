import { describe, expect, test } from "bun:test";
import { pollUntil } from "./harness";

describe("pollUntil", () => {
  test("resolves when condition is immediately true", async () => {
    let callCount = 0;
    await pollUntil(() => {
      callCount++;
      return true;
    });
    expect(callCount).toBe(1);
  });

  test("does not evaluate condition extra time on success", async () => {
    let callCount = 0;
    await pollUntil(() => {
      callCount++;
      return callCount >= 3;
    });
    expect(callCount).toBe(3);
  });

  test("throws on timeout", async () => {
    await expect(pollUntil(() => false, 50, 10)).rejects.toThrow("pollUntil: condition not met within 50ms");
  });

  test("works with async conditions", async () => {
    let callCount = 0;
    await pollUntil(async () => {
      callCount++;
      return callCount >= 2;
    });
    expect(callCount).toBe(2);
  });

  test("accepts truthy non-boolean returns", async () => {
    await pollUntil(() => 1);
    await pollUntil(() => 42);
  });
});
