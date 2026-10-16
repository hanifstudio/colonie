import { describe, expect, it } from "vitest";
import { executableTarget } from "./executable-target.mjs";

function executableFixture(target) {
  const bytes = Buffer.alloc(128);
  if (target === "darwin-arm64" || target === "darwin-x64") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
  } else if (target === "linux-x64" || target === "linux-arm64") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(target === "linux-arm64" ? 183 : 62, 18);
  } else if (target === "win32-x64") {
    bytes.write("MZ", 0, "ascii");
    bytes.writeUInt32LE(0x40, 0x3c);
    bytes.write("PE\0\0", 0x40, "binary");
    bytes.writeUInt16LE(0x8664, 0x44);
  }
  return bytes;
}

describe("executable target", () => {
  it("recognizes only the executable formats and architectures we ship", () => {
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]) {
      expect(executableTarget(executableFixture(target))).toBe(target);
    }
    expect(() => executableTarget(Buffer.from("not an executable"))).toThrow(/unsupported/);
  });

  it("does not mistake 32-bit, big-endian, truncated or unsupported ELF files for ARM64", () => {
    const arm32 = executableFixture("linux-arm64");
    arm32[4] = 1;
    const bigEndian = executableFixture("linux-arm64");
    bigEndian[5] = 2;
    bigEndian.writeUInt16BE(183, 18);
    const otherMachine = executableFixture("linux-arm64");
    otherMachine.writeUInt16LE(40, 18); // EM_ARM is not AArch64.
    const truncated = executableFixture("linux-arm64").subarray(0, 19);
    for (const bytes of [arm32, bigEndian, otherMachine, truncated]) {
      expect(() => executableTarget(bytes)).toThrow(/unsupported/);
    }
  });
});
