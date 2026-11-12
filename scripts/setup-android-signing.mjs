#!/usr/bin/env node
/*
 * 给 CI 里由 `tauri android init` 现场生成的 Android 工程注入 release 签名配置。
 *
 * 背景：Tauri 官方 Android 模板的 buildTypes.release 里没有 signingConfig，
 * 所以 `tauri android build`（release）产出的是未签名 APK，无法安装。
 * 而 src-tauri/gen/ 被 .gitignore 忽略，签名配置没法直接提交进仓库，
 * 只能在每次 init 之后往生成的 app/build.gradle.kts 里注入。
 *
 * 依赖两个文件（由 workflow 的 Prepare release signing 步骤写好）：
 *   src-tauri/gen/android/keystore.properties
 *   src-tauri/gen/android/hghub-release.keystore
 *
 * 用法：node scripts/setup-android-signing.mjs [android 工程目录，默认 src-tauri/gen/android]
 * 幂等：已经注入过就直接跳过。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const projectDir = resolve(process.argv[2] ?? "src-tauri/gen/android");
const propsPath = resolve(projectDir, "keystore.properties");
const gradlePath = resolve(projectDir, "app", "build.gradle.kts");

function fail(message) {
  console.error(`[signing] ${message}`);
  process.exit(1);
}

if (!existsSync(propsPath)) {
  fail(`找不到 ${propsPath}，请先在 workflow 里生成 keystore.properties`);
}
if (!existsSync(gradlePath)) {
  fail(`找不到 ${gradlePath}，请先执行 pnpm tauri android init`);
}

// 解析 keystore.properties（key=value，允许 # 注释）
const props = {};
for (const line of readFileSync(propsPath, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  props[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
}

for (const key of ["storeFile", "storePassword", "keyAlias", "keyPassword"]) {
  if (!props[key]) fail(`keystore.properties 缺少 ${key}`);
}
if (!existsSync(resolve(projectDir, props.storeFile))) {
  fail(`keystore 文件不存在：${resolve(projectDir, props.storeFile)}`);
}

const original = readFileSync(gradlePath, "utf8");
if (original.includes("signingConfigs")) {
  console.log("[signing] build.gradle.kts 已包含 signingConfigs，跳过注入");
  process.exit(0);
}

// 模板里的固定锚点（缩进 4 空格），一旦 Tauri 改了模板结构就主动报错而不是乱改文件
const buildTypesAnchor = "    buildTypes {";
const releaseAnchor = 'getByName("release") {';
if (!original.includes(buildTypesAnchor)) {
  fail(`Android 模板结构已变化：找不到锚点 "${buildTypesAnchor}"，请同步更新本脚本`);
}
if (!original.includes(releaseAnchor)) {
  fail(`Android 模板结构已变化：找不到锚点 "${releaseAnchor}"，请同步更新本脚本`);
}

const signingConfigsBlock = `    signingConfigs {
        create("hghubRelease") {
            val ksProps = java.util.Properties()
            rootProject.file("keystore.properties").inputStream().use { ksProps.load(it) }
            storeFile = rootProject.file(ksProps.getProperty("storeFile"))
            storePassword = ksProps.getProperty("storePassword")
            keyAlias = ksProps.getProperty("keyAlias")
            keyPassword = ksProps.getProperty("keyPassword")
        }
    }

    buildTypes {`;

let patched = original.replace(buildTypesAnchor, signingConfigsBlock);
patched = patched.replace(
  releaseAnchor,
  `${releaseAnchor}\n            signingConfig = signingConfigs.getByName("hghubRelease")`
);

if (patched === original) fail("注入失败：文件内容没有发生任何变化");

writeFileSync(gradlePath, patched, "utf8");
console.log(`[signing] 已注入 release 签名配置到 ${gradlePath}`);
console.log(`[signing] keystore=${props.storeFile} alias=${props.keyAlias}`);
