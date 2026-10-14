import { releaseNamespace } from "@open-design/release";
import { describe, expect, it } from "vitest";

import { officialReleaseChannelForNamespace, resolveBakedUpdaterPolicy } from "@/updates/updater-policy.js";

describe("officialReleaseChannelForNamespace", () => {
  it("recognizes every namespace the release workflows build with", () => {
    for (const channel of ["stable", "prerelease", "beta", "preview"]) {
      for (const platform of ["mac", "macIntel", "win", "linux"] as const) {
        expect(officialReleaseChannelForNamespace(releaseNamespace(channel, platform))).toBe(channel);
      }
    }
  });

  it("does not treat the default, fork, or reserved local namespaces as releases", () => {
    expect(officialReleaseChannelForNamespace("default")).toBeNull();
    expect(officialReleaseChannelForNamespace("local-fork")).toBeNull();
    expect(officialReleaseChannelForNamespace("beta-local-flow")).toBeNull();
    expect(officialReleaseChannelForNamespace("release-local")).toBeNull();
  });
});

describe("resolveBakedUpdaterPolicy", () => {
  it("bakes only an explicit opt-out", () => {
    expect(resolveBakedUpdaterPolicy({ namespace: "local-fork", updateEnabled: false })).toEqual({ updateEnabled: false });
    expect(resolveBakedUpdaterPolicy({ namespace: "local-fork", updateEnabled: true })).toBeNull();
    expect(resolveBakedUpdaterPolicy({ namespace: "local-fork" })).toBeNull();
  });

  it("allows the opt-out on the default namespace a fork may build with", () => {
    expect(resolveBakedUpdaterPolicy({ namespace: "default", updateEnabled: false })).toEqual({ updateEnabled: false });
  });

  it("refuses the opt-out for official release namespaces", () => {
    expect(() => resolveBakedUpdaterPolicy({ namespace: "release-stable", updateEnabled: false })).toThrow(
      /official stable release namespace "release-stable"/,
    );
    expect(() => resolveBakedUpdaterPolicy({ namespace: "release-prerelease-intel", updateEnabled: false })).toThrow(
      /official prerelease release namespace/,
    );
  });

  it("does not guard release namespaces that keep the updater on", () => {
    expect(resolveBakedUpdaterPolicy({ namespace: "release-beta", updateEnabled: true })).toBeNull();
    expect(resolveBakedUpdaterPolicy({ namespace: "release-beta" })).toBeNull();
  });
});
