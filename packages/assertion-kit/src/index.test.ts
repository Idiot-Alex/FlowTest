import { describe, expect, it } from "vitest";

import { AssertionFailure, getJsonPath } from "./index.js";

describe("getJsonPath", () => {
  it("reads a nested property", () => {
    expect(getJsonPath({ data: { status: "PENDING" } }, "$.data.status")).toBe(
      "PENDING",
    );
  });

  it("fails when a property is missing", () => {
    expect(() => getJsonPath({}, "$.data.status")).toThrow(AssertionFailure);
  });
});
