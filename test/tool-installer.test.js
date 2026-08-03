import assert from "node:assert/strict"
import test from "node:test"
import { createDefaultGlobalConfig } from "../core/config/defaults.js"
import { validateGlobalConfig } from "../core/config/schema.js"
import {
  defaultAssetPatterns,
  isDisallowedReleaseAsset,
  pickReleaseAsset,
} from "../services/tools/installer.js"

const asset = name => ({ name, browser_download_url: `https://example.invalid/${name}` })

test("BBDown selects the exact Linux CPU build", () => {
  const assets = [
    asset("BBDown_1.6.3_linux-arm64.zip"),
    asset("BBDown_1.6.3_linux-x64.zip"),
    asset("BBDown_1.6.3_win-x64.zip"),
  ]
  const selected = pickReleaseAsset("bbdown", assets, {
    environment: { platform: "linux", arch: "x64", libc: "glibc" },
  })
  assert.equal(selected.name, "BBDown_1.6.3_linux-x64.zip")
})

test("FFmpeg selects non-shared builds for the exact OS and CPU", () => {
  const assets = [
    asset("ffmpeg-master-latest-winarm64-gpl-shared.zip"),
    asset("ffmpeg-master-latest-winarm64-gpl.zip"),
    asset("ffmpeg-master-latest-win64-gpl.zip"),
  ]
  const selected = pickReleaseAsset("ffmpeg", assets, {
    environment: { platform: "windows", arch: "arm64", libc: "none" },
  })
  assert.equal(selected.name, "ffmpeg-master-latest-winarm64-gpl.zip")
})

test("aria2 never treats Android ARM64 or source archives as Linux x64 binaries", () => {
  const assets = [
    asset("aria2-1.37.0-aarch64-linux-android-build1.zip"),
    asset("aria2-1.37.0.tar.gz"),
    asset("aria2-1.37.0-win-64bit-build1.zip"),
  ]
  assert.equal(pickReleaseAsset("aria2", assets, {
    environment: { platform: "linux", arch: "x64", libc: "glibc" },
  }), null)
  assert.equal(pickReleaseAsset("aria2", assets, {
    environment: { platform: "windows", arch: "x64", libc: "none" },
  }).name, "aria2-1.37.0-win-64bit-build1.zip")
})

test("disallows foreign architectures even when a custom pattern is broad", () => {
  const environment = { platform: "linux", arch: "x64", libc: "glibc" }
  assert.equal(isDisallowedReleaseAsset("aria2", "aria2-aarch64-linux-android.zip", environment), true)
  assert.equal(isDisallowedReleaseAsset("bbdown", "BBDown_linux-arm64.zip", environment), true)
})

test("unsupported platform combinations expose no generic fallback", () => {
  assert.deepEqual(defaultAssetPatterns("aria2", "linux", "x64"), [])
  assert.deepEqual(defaultAssetPatterns("ffmpeg", "darwin", "arm64"), [])
})

test("default Python and per-environment URL configuration passes schema validation", () => {
  const config = createDefaultGlobalConfig()
  config.tools.aria2.urls["linux-x64-glibc"] = "https://mirror.example/aria2.tar.gz"
  assert.deepEqual(validateGlobalConfig(config), [])
  config.python.minimum_version = "three"
  assert.match(validateGlobalConfig(config).join("\n"), /minimum_version/)
})
