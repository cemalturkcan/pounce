import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalNetworkHost } from "./profile-settings.ts";

test("loopback and private hosts count as local network", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.8.0.2", "[::1]", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.1.1", "fd12:3456::1"]) {
    assert.equal(isLocalNetworkHost(host), true, host);
  }
});

test("public hosts and look-alikes do not count as local network", () => {
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "192.169.1.1", "localhost.example.com", "127.0.0.1.nip.io"]) {
    assert.equal(isLocalNetworkHost(host), false, host);
  }
});
