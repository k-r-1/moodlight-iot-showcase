const fs = require("node:fs");
const path = require("node:path");

const settingsPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "@react-native",
  "gradle-plugin",
  "settings.gradle.kts",
);
const oldPlugin = 'foojay-resolver-convention").version("0.5.0")';
const compatiblePlugin = 'foojay-resolver-convention").version("1.0.0")';

if (!fs.existsSync(settingsPath)) {
  console.error(`React Native Gradle 설정을 찾지 못했습니다: ${settingsPath}`);
  process.exit(1);
}

const source = fs.readFileSync(settingsPath, "utf8");

if (source.includes(compatiblePlugin)) {
  console.log("React Native Gradle 9 호환 패치가 이미 적용되어 있습니다.");
  process.exit(0);
}

if (!source.includes(oldPlugin)) {
  console.error("예상하지 못한 React Native Gradle 설정입니다. 의존성 버전을 확인해 주세요.");
  process.exit(1);
}

fs.writeFileSync(settingsPath, source.replace(oldPlugin, compatiblePlugin));
console.log("React Native Gradle 9 호환 패치를 적용했습니다.");
