// C1: where `herdr-app` is looked for, on every platform a person runs Herdr on. No real filesystem or process is
// consulted: `exists`, `exec` and `readFile` are injected, so the WSL bridge to a Windows install can be tested
// anywhere.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findHerdrApp } from "./pair.mjs";

const none = () => false;
const fakeFs = (paths) => (candidate) => paths.includes(candidate);

describe("herdr-app discovery", () => {
  it("takes HERDR_APP_BIN as given, before PATH and any install folder", async () => {
    const trace = [];
    const found = await findHerdrApp({ env: { HERDR_APP_BIN: "/opt/bridge/herdr-app", PATH: "/usr/bin", HOME: "/Users/me" }, platform: "darwin", exists: fakeFs(["/usr/bin/herdr-app"]), exec: none, trace });
    assert.deepEqual(found, { bin: "/opt/bridge/herdr-app", how: "HERDR_APP_BIN" });
    assert.ok(trace.some((line) => /HERDR_APP_BIN/.test(line)));
  });

  it("prefers PATH over ~/.local/bin and the platform folders", async () => {
    const found = await findHerdrApp({
      env: { PATH: "/opt/tools:/usr/bin", HOME: "/Users/me" },
      platform: "darwin",
      exists: fakeFs(["/opt/tools/herdr-app", "/Users/me/.local/bin/herdr-app", "/Applications/Herdr.app/Contents/MacOS/herdr-app"]),
      exec: none,
    });
    assert.deepEqual(found, { bin: "/opt/tools/herdr-app", how: "PATH" });
  });

  it("finds the installed macOS app, whose binary is Herdr, and the download name in the same bundle", async () => {
    const home = "/Users/me";
    const real = `${home}/Applications/Herdr.app/Contents/MacOS/Herdr`;
    let found = await findHerdrApp({ env: { PATH: "/usr/bin:/bin", HOME: home }, platform: "darwin", exists: fakeFs([real]), exec: none });
    assert.deepEqual(found, { bin: real, how: "macOS app bundle" }, "this machine's herdr-app symlink points at .../MacOS/Herdr");
    const download = "/Applications/Herdr.app/Contents/MacOS/herdr-app";
    found = await findHerdrApp({ env: { PATH: "/usr/bin", HOME: home }, platform: "darwin", exists: fakeFs([download, real]), exec: none });
    assert.equal(found.bin, download, "a herdr-app binary in the bundle is probed too");
  });

  it("finds herdr-app.exe through the WSL bridge from the Windows LOCALAPPDATA", async () => {
    const bridge = "/mnt/c/Users/me/AppData/Local/Programs/herdr-app/herdr-app.exe";
    const calls = [];
    const exec = async (cmd, args, opts = {}) => {
      calls.push([cmd, ...args, opts]);
      if (cmd === "cmd.exe") return "C:\\Users\\me\\AppData\\Local\r\n";
      if (cmd === "wslpath") return "/mnt/c/Users/me/AppData/Local\n";
      throw new Error(`unexpected ${cmd}`);
    };
    let found = await findHerdrApp({ env: { PATH: "/usr/bin", HOME: "/home/me", WSL_DISTRO_NAME: "Ubuntu" }, platform: "linux", exists: fakeFs([bridge]), exec });
    assert.deepEqual(found, { bin: bridge, how: "WSL bridge" });
    assert.deepEqual(calls.map((call) => call[0]), ["cmd.exe", "wslpath"]);
    assert.deepEqual(calls[0].slice(1, -1), ["/c", "echo %LOCALAPPDATA%"]);
    assert.ok(calls.every((call) => call.at(-1).timeout > 0), "a stalled Windows helper cannot hold discovery open");

    // /proc/version is the other WSL signal, when WSL_DISTRO_NAME is not exported into the caller.
    calls.length = 0;
    const readFile = (path) => {
      assert.equal(path, "/proc/version");
      return "Linux version 5.15.90.1-microsoft-standard-WSL2 (gcc ...)\n";
    };
    found = await findHerdrApp({ env: { PATH: "/usr/bin", HOME: "/home/me" }, platform: "linux", exists: fakeFs([bridge]), exec, readFile });
    assert.equal(found.bin, bridge);
  });

  it("finds herdr-app.exe under %LOCALAPPDATA% on Windows", async () => {
    const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\herdr-app\\herdr-app.exe";
    const found = await findHerdrApp({ env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "C:\\Windows\\System32" }, platform: "win32", exists: fakeFs([exe]), exec: none });
    assert.deepEqual(found, { bin: exe, how: "Windows LOCALAPPDATA" });
  });

  it("finds the Linux install folders", async () => {
    for (const bin of ["/home/me/.local/share/herdr-app/herdr-app", "/opt/herdr-app/herdr-app", "/usr/bin/herdr-app"]) {
      const found = await findHerdrApp({ env: { PATH: "/bin", HOME: "/home/me" }, platform: "linux", exists: fakeFs([bin]), exec: none, readFile: () => "" });
      assert.deepEqual(found, { bin, how: "Linux install folder" }, bin);
    }
  });

  it("names every path it rejected when no CLI is installed, and still leaves Herdr core-only usable", async () => {
    const trace = [];
    const found = await findHerdrApp({
      env: { PATH: "/usr/bin:/bin", HOME: "/home/me", WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      exists: none,
      readFile: () => "",
      exec: async (cmd) => {
        if (cmd === "cmd.exe") return "C:\\Users\\me\\AppData\\Local\n";
        if (cmd === "wslpath") return "/mnt/c/Users/me/AppData/Local\n";
        throw new Error(`unexpected ${cmd}`);
      },
      trace,
    });
    assert.deepEqual(found, { bin: "herdr-app", how: null }, "the fallback name fails visibly where it is used");
    const text = trace.join("\n");
    assert.match(text, /HERDR_APP_BIN is unset/);
    assert.match(text, /\/usr\/bin\/herdr-app missing \(PATH\)/, "each PATH entry is named");
    assert.match(text, /\/bin\/herdr-app missing \(PATH\)/);
    assert.match(text, /\/home\/me\/\.local\/bin\/herdr-app missing \(~\/\.local\/bin\)/);
    for (const bundle of ["/home/me/.local/share/herdr-app/herdr-app", "/opt/herdr-app/herdr-app", "/usr/bin/herdr-app"]) {
      assert.ok(text.includes(`${bundle} missing (Linux install folder)`), bundle);
    }
    assert.match(text, /herdr-app\.exe missing \(WSL bridge\)/);
    assert.match(text, /not found; Herdr can still run core-only through hc/);
  });

  it("shows the rejected PATH entries before a later platform hit, and no summary hides them", async () => {
    const trace = [];
    const bundle = "/Users/me/Applications/Herdr.app/Contents/MacOS/Herdr";
    const found = await findHerdrApp({ env: { PATH: "/first:/second", HOME: "/Users/me" }, platform: "darwin", exists: fakeFs([bundle]), exec: none, trace });
    assert.deepEqual(found, { bin: bundle, how: "macOS app bundle" });
    const text = trace.join("\n");
    assert.match(text, /\/first\/herdr-app missing \(PATH\)/);
    assert.match(text, /\/second\/herdr-app missing \(PATH\)/);
    assert.match(text, /\/Users\/me\/\.local\/bin\/herdr-app missing \(~\/\.local\/bin\)/);
    // Rejected platform candidates before the hit are kept too, in probe order.
    assert.ok(text.indexOf("/Applications/Herdr.app/Contents/MacOS/herdr-app missing") < text.indexOf(bundle));
    assert.ok(text.includes("/Applications/Herdr.app/Contents/MacOS/Herdr missing (macOS app bundle)"));
    assert.ok(text.includes("/Users/me/Applications/Herdr.app/Contents/MacOS/herdr-app missing (macOS app bundle)"));
    assert.match(text, new RegExp(`${bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(macOS app bundle\\)$`), "the hit is last");
  });

  it("reports why the WSL bridge could not be used, and never treats a non-WSL Linux box as WSL", async () => {
    const trace = [];
    await findHerdrApp({
      env: { PATH: "/usr/bin", HOME: "/home/me", WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      exists: none,
      readFile: () => "",
      exec: async () => {
        throw new Error("cmd.exe: spawn cmd.exe ENOENT");
      },
      trace,
    });
    assert.ok(trace.some((line) => /WSL bridge unusable: .*spawn cmd\.exe ENOENT/.test(line)));

    const plain = [];
    await findHerdrApp({ env: { PATH: "/usr/bin", HOME: "/home/me" }, platform: "linux", exists: none, readFile: () => "Linux version 6.1.0-generic\n", exec: none, trace: plain });
    assert.ok(plain.some((line) => /not WSL .*no Windows bridge/.test(line)));
  });
});
