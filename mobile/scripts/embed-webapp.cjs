const fs = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "../../webapp/out");
const destination = path.resolve(__dirname, "../android/app/src/main/assets/webapp");

if (!fs.existsSync(path.join(source, "index.html"))) {
  console.error("임베드할 webapp/out/index.html이 없습니다.");
  process.exit(1);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });
console.log("로컬 실기기 시험 화면을 Android APK에 임베드했습니다.");
