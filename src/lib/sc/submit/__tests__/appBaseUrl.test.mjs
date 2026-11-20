import { test } from "node:test";
import assert from "node:assert/strict";
import { appBaseUrl } from "../appBaseUrl.ts";

test("appBaseUrl falls back to the v2 production domain when SC_APP_BASE_URL is unset", () => {
  const saved = process.env.SC_APP_BASE_URL;
  delete process.env.SC_APP_BASE_URL;
  try {
    assert.equal(appBaseUrl(), "https://kitchfix-intranet-v2.vercel.app");
  } finally {
    if (saved !== undefined) process.env.SC_APP_BASE_URL = saved;
  }
});

test("appBaseUrl trims trailing slashes", () => {
  const saved = process.env.SC_APP_BASE_URL;
  process.env.SC_APP_BASE_URL = "https://example.test/";
  try {
    assert.equal(appBaseUrl(), "https://example.test");
  } finally {
    if (saved === undefined) delete process.env.SC_APP_BASE_URL;
    else process.env.SC_APP_BASE_URL = saved;
  }
});

test("appBaseUrl never returns '' or 'undefined' for blank env", () => {
  const saved = process.env.SC_APP_BASE_URL;
  process.env.SC_APP_BASE_URL = "   ";
  try {
    const got = appBaseUrl();
    assert.notEqual(got, "");
    assert.notEqual(got, "undefined");
    assert.match(got, /^https:\/\//);
  } finally {
    if (saved === undefined) delete process.env.SC_APP_BASE_URL;
    else process.env.SC_APP_BASE_URL = saved;
  }
});
