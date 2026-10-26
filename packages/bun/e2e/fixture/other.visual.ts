import { suite } from "./fixtures";

// A second file for a direct `bun test --isolate` run.
const { test } = suite(import.meta.path, { baseUrl: "http://127.0.0.1:9" });

test("other file", async () => {});
