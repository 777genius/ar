import { describe, expect, it } from "vitest";
import {
  hostedAggregateIoDropIn,
  hostedIoLimitPathsFromMountInfo,
} from "../app-server/adapters/hosted-app-server-resource-policy";

const mountInfo = [
  "24 1 253:1 / / rw,relatime - ext4 /dev/vda1 rw",
  "25 24 259:0 / /boot rw,relatime - ext4 /dev/vda16 rw",
  "26 24 8:0 / /mnt/volume\\040one rw,relatime - ext4 /dev/sda rw",
  "27 24 8:0 /jobs /var/data/worker-jobs rw,relatime - ext4 /dev/sda rw",
  "28 24 0:28 / /proc rw,nosuid - proc proc rw",
  "29 24 7:0 / /snap/core ro,nodev - squashfs /dev/loop0 ro",
].join("\n");

describe("hosted app-server resource policy", () => {
  it("limits every writable block device once at its shortest mount path", () => {
    expect(hostedIoLimitPathsFromMountInfo(mountInfo)).toEqual([
      "/",
      "/boot",
      "/mnt/volume one",
    ]);
  });

  it("produces the aggregate I/O ceiling", () => {
    expect(hostedAggregateIoDropIn(["/mnt/volume one"])).toContain(
      "IOReadIOPSMax=/mnt/volume\\x20one 8000",
    );
  });

  it("falls back to the root filesystem when mount discovery is unavailable", () => {
    expect(hostedIoLimitPathsFromMountInfo("invalid")).toEqual(["/"]);
  });
});
