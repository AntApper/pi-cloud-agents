import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../../core/index.js";
import { RUNNER_VERSION } from "../../runner/index.js";
import { SHARED_VERSION } from "../../shared/index.js";

describe("Scaffold setup", () => {
  it("exports package versions across modules", () => {
    expect(CORE_VERSION).toBe("0.1.0");
    expect(SHARED_VERSION).toBe("0.1.0");
    expect(RUNNER_VERSION).toBe("0.1.0");
  });
});
