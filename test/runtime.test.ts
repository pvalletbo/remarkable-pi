import { afterEach, expect, it } from "bun:test";
import { bunExecutable } from "../src/runtime.js";

const original = process.env.REMARKABLE_PI_BUN;
afterEach(() => {
  if (original === undefined) delete process.env.REMARKABLE_PI_BUN;
  else process.env.REMARKABLE_PI_BUN = original;
});

it("reuses the actual Bun executable when running under Bun", () => {
  delete process.env.REMARKABLE_PI_BUN;
  expect(process.versions.bun).toBeDefined();
  expect(bunExecutable()).toBe(process.execPath);
});

it("honors an explicit Bun worker executable without invoking a shell", () => {
  process.env.REMARKABLE_PI_BUN = "/some path/bin/bun";
  expect(bunExecutable()).toBe("/some path/bin/bun");
});
