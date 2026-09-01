import { describe, expect, it } from "vitest";
import { bareWordDefaultSuggestion } from "../defaults";

describe("bareWordDefaultSuggestion", () => {
  const flagged: [string, string][] = [
    ["US", "'US'"],
    ["pending", "'pending'"],
    ["pending review", "'pending review'"],
    ["region_code", "'region_code'"],
  ];
  it.each(flagged)("flags %s and suggests %s", (value, want) => {
    expect(bareWordDefaultSuggestion(value)).toBe(want);
  });

  const fine = [
    "'US'",
    "''",
    "0",
    "-1",
    "19.99",
    ".5",
    "true",
    "FALSE",
    "null",
    "now()",
    "gen_random_uuid()",
    "current_timestamp",
    "CURRENT_DATE",
    "('{}'::jsonb)",
    "",
    "   ",
  ];
  it.each(fine)("accepts %s", (value) => {
    expect(bareWordDefaultSuggestion(value)).toBeNull();
  });
});
